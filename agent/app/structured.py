"""
Schema-enforced structured output with bounded retry (FIX-6).

The classifier and negotiator ask the LLM for JSON as free text. Previously the
parse path was "json.loads, and on failure scrape with a brace regex, and on a
bad field guess with another regex" — a free-text guess that can silently latch
onto the wrong value. That is replaced here with the production pattern:

    parse  ->  validate against a Pydantic schema  ->  on failure, RE-ASK the
    model (bounded retries)  ->  raise StructuredOutputError if still invalid.

The decision/route layer decides how to fail safe (classifier → UNKNOWN/low
confidence; negotiator → propagate, which the route maps to its escalate/500
path). No prompt wording is changed and no provider is assumed — this works for
both the Ollama and OpenAI backends behind app.llm.get_llm.
"""

from __future__ import annotations

import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Type, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

# FIX-9 / MED-L2: a shared worker pool so a hung llm.invoke can be bounded by a
# wall-clock timeout. The TS caller already aborts the HTTP request after
# AGENT_TIMEOUT_MS, but without this the Python side keeps generating and holds
# the FastAPI worker (audit Reliability Review: "a hung Ollama call holds the
# Python worker"). With it, the awaited future times out and the request returns
# promptly, freeing the worker. The orphaned generation cannot be force-killed
# (Python threads aren't interruptible), but it no longer blocks the caller.
#
# MED-L2 pool sizing: on a timeout the orphaned generation keeps running and
# holds its pool thread until it finishes, so a fixed pool of 8 could be saturated
# by 8 orphans — after which every new bounded call blocks waiting for a free
# thread, defeating the timeout. The pool is now sized from LLM_INVOKE_POOL_SIZE
# (default 16) and SHOULD be set to at least the FastAPI worker concurrency (each
# in-flight request makes at most one bounded call at a time), so a timed-out
# request always has a thread to run its next attempt / fallback on. It is NOT a
# concurrency limiter — real backpressure belongs to the ASGI server + the TS
# circuit breaker; this pool only exists to make .result(timeout) possible.
def _pool_size() -> int:
    try:
        v = int(os.getenv("LLM_INVOKE_POOL_SIZE", "16"))
    except ValueError:
        v = 16
    return max(1, v)


_LLM_EXECUTOR = ThreadPoolExecutor(max_workers=_pool_size(), thread_name_prefix="llm-invoke")

# W-9(a): a capacity semaphore sized to the pool. future.cancel() is a NO-OP once
# a task has started, so a timed-out (orphaned) generation keeps holding its pool
# thread until the underlying SDK call finally returns. With enough orphans the
# pool saturates and the NEXT invoke_model_bounded blocks on .submit() waiting for
# a free thread — the wait happens BEFORE .result(timeout), so the wall-clock
# budget never even starts and the timeout is defeated.
#
# The fix: acquire a permit BEFORE submitting and release it in a done-callback
# (so an orphan holds its permit until it genuinely finishes, accurately modelling
# real occupancy). A caller that can't get a permit within its budget fails fast
# with LLMTimeoutError instead of blocking indefinitely on a saturated pool. This
# keeps the timeout guarantee true under orphan pressure — the classify path then
# degrades to UNKNOWN and the negotiate path escalates, rather than hanging the
# FastAPI worker.
_LLM_CAPACITY = threading.BoundedSemaphore(_pool_size())


def _resize_invoke_pool_for_test(size: int) -> None:
    """Test helper: rebuild the executor + capacity semaphore at a small size so
    the W-9(a) saturation behaviour can be exercised deterministically. Not used
    in production (the pool is sized once at import from LLM_INVOKE_POOL_SIZE)."""
    global _LLM_EXECUTOR, _LLM_CAPACITY
    _LLM_EXECUTOR.shutdown(wait=False)
    _LLM_EXECUTOR = ThreadPoolExecutor(max_workers=size, thread_name_prefix="llm-invoke")
    _LLM_CAPACITY = threading.BoundedSemaphore(size)


# Per-generation wall-clock budget for a SINGLE model's llm.invoke (MED-L2). This
# now bounds ONE model call, not a whole primary→fallback chain: the FailoverChat
# in app.llm applies this budget per candidate, so a hung primary times out and
# the fallback still gets its own full budget (previously one budget spanned both,
# and a stuck primary starved the fallback). Provider-agnostic (wraps the call,
# not the SDK). 0/unset disables the bound. Default 60s — a backstop above the
# interactive budget for SDKs with no timeout of their own; tune via env.
def _invoke_timeout_seconds() -> float:
    raw = os.getenv("LLM_INVOKE_TIMEOUT_SECONDS", "60")
    try:
        v = float(raw)
    except ValueError:
        return 60.0
    return v if v > 0 else 0.0


class StructuredOutputError(ValueError):
    """Raised when the model could not produce schema-valid output within the
    allowed number of attempts. Carries the last raw output for logging."""

    def __init__(self, message: str, *, raw: str | None = None) -> None:
        super().__init__(message)
        self.raw = raw


class LLMTimeoutError(StructuredOutputError):
    """Raised when a single llm.invoke exceeds LLM_INVOKE_TIMEOUT_SECONDS.

    A subclass of StructuredOutputError so existing callers that catch the
    latter (classify → fail safe to UNKNOWN; negotiate route → 500/escalate)
    keep working unchanged, while callers that care can distinguish a timeout.
    """


def invoke_model_bounded(model, prompt):
    """Call a SINGLE model's ``model.invoke(prompt)`` under a wall-clock bound,
    returning the model's message object (with a ``.content`` attribute).

    MED-L2: this bounds ONE model call. app.llm.FailoverChat calls it PER
    CANDIDATE, so each candidate gets its own independent budget (a hung primary
    times out and the fallback runs with a fresh budget). Raises LLMTimeoutError
    on budget exhaustion. When the budget is 0/disabled the call runs inline (no
    executor overhead).
    """
    timeout = _invoke_timeout_seconds()
    if timeout <= 0:
        return model.invoke(prompt)

    # Bind the CURRENT executor + semaphore instances locally. A task must release
    # the SAME semaphore it acquired from — if a test (or a future resize) swaps
    # the module globals, a stale done-callback releasing the *new* semaphore would
    # over-release it. Capturing here ties acquire/release to one instance.
    executor = _LLM_EXECUTOR
    capacity = _LLM_CAPACITY

    # W-9(a): reserve a pool permit within the SAME wall-clock budget. If the pool
    # is saturated by orphaned (timed-out but still-running) generations, this
    # returns promptly with a timeout instead of blocking on .submit() forever.
    if not capacity.acquire(timeout=timeout):
        raise LLMTimeoutError(
            f"llm.invoke pool saturated — no free thread within {timeout:.0f}s "
            f"(orphaned generations still running)",
            raw=None,
        )

    release_lock = threading.Lock()
    permit_released = False

    def _release_once(_fut: object | None = None) -> None:
        nonlocal permit_released
        with release_lock:
            if permit_released:
                return
            permit_released = True
        capacity.release()

    try:
        future = executor.submit(lambda: model.invoke(prompt))
    except Exception:
        # Submission itself failed — don't leak the permit.
        _release_once()
        raise

    # Release the permit only when the task ACTUALLY finishes (success, error, or
    # long after a timeout) — NOT when result(timeout) gives up. An orphan thus
    # keeps its permit until it truly returns, so the semaphore reflects real
    # occupancy and can't over-admit.
    future.add_done_callback(_release_once)

    try:
        return future.result(timeout=timeout)
    except FutureTimeoutError as exc:
        # Don't wait on the orphaned generation; the done-callback frees its permit
        # when it eventually finishes. future.cancel() is a no-op once started, but
        # harmless for a task still queued.
        future.cancel()
        raise LLMTimeoutError(
            f"llm.invoke exceeded {timeout:.0f}s budget", raw=None
        ) from exc


def _invoke_with_timeout(llm, ask: str) -> str:
    """Return the string content of ``llm.invoke(ask)`` with a wall-clock bound.

    ``llm`` may be a direct chat model OR an app.llm.FailoverChat. The FailoverChat
    ALREADY bounds each candidate per-call (MED-L2), so wrapping it again here
    would (a) double-bound and (b) re-introduce the "one budget spans the whole
    primary→fallback chain" bug this fix removes — so we detect it by duck-typing
    (a ``_candidates`` attribute) and let it manage its own per-candidate budget.
    A direct single model is bounded here via invoke_model_bounded.
    """
    if hasattr(llm, "_candidates"):
        # FailoverChat — it bounds each candidate itself AND instruments each
        # candidate call (HARD-O1); don't re-wrap or double-count here.
        return llm.invoke(ask).content

    # HARD-O1: the direct (single-model, no-fallback) path is the common one and
    # bypasses FailoverChat, so instrument it HERE — latency + token/cost telemetry
    # stamped with {model, promptVersion}. Lazy import to avoid a hard dependency /
    # import cycle. Failures still propagate; we record the error kind first.
    import time

    from app.telemetry import get_active_prompt_version, record_llm_call
    from app.llm import current_model_label

    start = time.perf_counter()
    try:
        result = invoke_model_bounded(llm, ask)
    except Exception as exc:
        record_llm_call(
            model=current_model_label(llm),
            latency_ms=(time.perf_counter() - start) * 1000.0,
            result=None,
            prompt_version=get_active_prompt_version(),
            ok=False,
            error_kind=type(exc).__name__,
        )
        raise
    record_llm_call(
        model=current_model_label(llm),
        latency_ms=(time.perf_counter() - start) * 1000.0,
        result=result,
        prompt_version=get_active_prompt_version(),
        ok=True,
    )
    return result.content


# EASY-S1: how many chars of raw model output may appear in an ERROR message.
# The raw output can quote confidential figures (a floor/ceiling the model
# echoed, a rate); those must not transit logs / HTTP error details in full.
# A short, truncated preview is enough to debug a malformed generation without
# spilling the whole response — and keeps the repair-prompt suffix from bloating
# past num_ctx on retry (the second half of the EASY-S1 rationale).
_ERROR_RAW_PREVIEW_CHARS = 80


def _redact_raw(raw: str) -> str:
    """A short, safe preview of raw model output for an error message: the first
    _ERROR_RAW_PREVIEW_CHARS characters, with a truncation marker. Never the whole
    thing — a raw response can carry figures the model quoted."""
    text = raw.strip()
    if len(text) <= _ERROR_RAW_PREVIEW_CHARS:
        return repr(text)
    return repr(text[:_ERROR_RAW_PREVIEW_CHARS]) + " …[truncated]"


def extract_json_object(raw: str) -> dict:
    """Pull a JSON object out of a raw model response.

    Tolerates ```json fences and leading/trailing prose by falling back to the
    first balanced-looking brace span. This is the *parse* step only — the
    result is still validated against a schema by the caller.
    """
    text = raw.strip()
    # Strip qwen3 thinking blocks before any other processing
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            # EASY-S1: a truncated preview, not the full raw — this ValueError's
            # str() becomes `last_error`, which flows into the repair suffix AND
            # the HTTPException detail. Embedding the whole response leaked model
            # output to logs/clients and could blow num_ctx on the repair retry.
            raise ValueError(f"No JSON object found in model response: {_redact_raw(raw)}")
        obj = json.loads(m.group())
    if not isinstance(obj, dict):
        raise ValueError(f"Expected a JSON object, got {type(obj).__name__}: {_redact_raw(raw)}")
    return obj


_REPAIR_SUFFIX = (
    "\n\nYour previous response was not valid. "
    "Respond with ONLY a single valid JSON object matching the requested shape, "
    "no prose, no code fences. Error: {error}"
)


def invoke_structured(
    llm,
    prompt: str,
    schema: Type[T],
    *,
    retries: int = 2,
) -> T:
    """Invoke the LLM and return a validated instance of `schema`.

    Tries up to ``1 + retries`` times. Each retry re-asks the model with a short
    repair instruction appended (the original prompt is otherwise unchanged).
    Raises StructuredOutputError if no attempt yields schema-valid JSON.
    """
    last_error: str = "no attempts made"
    last_raw: str | None = None
    attempts = max(1, 1 + retries)

    for attempt in range(attempts):
        ask = prompt if attempt == 0 else prompt + _REPAIR_SUFFIX.format(error=last_error)
        # FIX-9: bound each invoke so a hung generation can't pin the worker. A
        # timeout is a transport failure, not malformed output — let it propagate
        # (don't burn a retry re-asking a model that isn't responding).
        raw = _invoke_with_timeout(llm, ask)
        last_raw = raw if isinstance(raw, str) else str(raw)
        try:
            obj = extract_json_object(last_raw)
            return schema.model_validate(obj)
        except (ValueError, ValidationError) as exc:
            last_error = str(exc)

    raise StructuredOutputError(
        f"Model did not produce schema-valid output after {attempts} attempt(s): {last_error}",
        raw=last_raw,
    )
