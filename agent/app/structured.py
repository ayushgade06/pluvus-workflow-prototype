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
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Type, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

# FIX-9: a single shared worker so a hung llm.invoke can be bounded by a
# wall-clock timeout. The TS caller already aborts the HTTP request after
# AGENT_TIMEOUT_MS, but without this the Python side keeps generating and holds
# the FastAPI worker (audit Reliability Review: "a hung Ollama call holds the
# Python worker"). With it, the awaited future times out and the request returns
# promptly, freeing the worker. The orphaned generation cannot be force-killed
# (Python threads aren't interruptible), but it no longer blocks the caller.
_LLM_EXECUTOR = ThreadPoolExecutor(max_workers=8, thread_name_prefix="llm-invoke")

# Per-call wall-clock budget for a single llm.invoke. Provider-agnostic (works
# for Ollama and OpenAI alike since it wraps the call, not the SDK). 0/unset
# disables the bound. Default 60s — comfortably under the TS 30s? No: this is a
# backstop for the case where the SDK has no timeout of its own, so keep it a
# little above the interactive budget; tune via env.
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


def _invoke_with_timeout(llm, ask: str) -> str:
    """Call ``llm.invoke(ask)`` with a wall-clock bound, returning ``.content``.

    Raises LLMTimeoutError if the call does not finish within the budget. When
    the budget is 0/disabled the call runs inline (no executor overhead).
    """
    timeout = _invoke_timeout_seconds()
    if timeout <= 0:
        return llm.invoke(ask).content
    future = _LLM_EXECUTOR.submit(lambda: llm.invoke(ask).content)
    try:
        return future.result(timeout=timeout)
    except FutureTimeoutError as exc:
        # Don't wait on the orphaned generation; let it finish in the background.
        future.cancel()
        raise LLMTimeoutError(
            f"llm.invoke exceeded {timeout:.0f}s budget", raw=None
        ) from exc


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
            raise ValueError(f"No JSON object found in model response: {raw!r}")
        obj = json.loads(m.group())
    if not isinstance(obj, dict):
        raise ValueError(f"Expected a JSON object, got {type(obj).__name__}: {raw!r}")
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
