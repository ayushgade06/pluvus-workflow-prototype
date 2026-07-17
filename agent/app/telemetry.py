"""HARD-O1: LLM observability scaffolding — token / latency / cost telemetry.

The audit's Observability finding (score 2): there is NO token/latency/cost
telemetry anywhere, and `usage_metadata` is never read. This module is the
CODE-SIDE scaffolding for that: a single seam every LLM call funnels through that
extracts latency + token usage from the LangChain result and emits ONE structured
record stamped with {model, promptVersion}.

What this gives you now (code, in this diff):
  * per-call latency (wall clock around the model invoke),
  * prompt/completion/total token counts read from the LangChain result's
    usage_metadata (when the provider returns it),
  * an estimated USD cost from a configurable per-1K price table,
  * the model label and prompt version on every record,
  * a structured, machine-parseable log line (`llm_call ...`) + an in-process
    ring buffer the /metrics-style surfaces can read.

What still needs INFRA to reach score 8 (the acceptance criterion, NOT in this
diff): a running metrics backend (OpenTelemetry/Prometheus/Datadog) scraping or
receiving these records, dashboards, and alert routing (error rate, breaker-open,
manual-queue growth, stranded instances) + drift monitoring on the negotiation
distributions. `emit_llm_metric` is the single call site to wire an exporter into
— replace/extend the log+buffer sink with an OTel span or a Prometheus counter
and every call is instrumented, no other code changes.
"""

from __future__ import annotations

import logging
import os
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass
from typing import Iterator

logger = logging.getLogger("agent.telemetry")

# In-process ring buffer of the most recent LLM-call records. This is the
# minimal "metrics surface" a health/metrics endpoint can read without a backend;
# a real deployment swaps this for an exporter (see module docstring).
_RECENT_MAX = 256
_recent: "deque[LLMCallRecord]" = deque(maxlen=_RECENT_MAX)


@dataclass
class LLMCallRecord:
    """One instrumented LLM call. Every field is safe to log/ship (no prompt text,
    no model output — only counts, timings, and identity)."""

    model: str
    prompt_version: str | None
    latency_ms: float
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    est_cost_usd: float | None
    ok: bool
    error_kind: str | None = None


def _price_table() -> dict[str, tuple[float, float]]:
    """(input_per_1k, output_per_1k) USD by model-label prefix.

    Overridable via LLM_PRICE_TABLE (a "prefix:in/out,prefix:in/out" string) so a
    price change is config, not code. Local Ollama defaults to 0 (self-hosted).
    """
    table: dict[str, tuple[float, float]] = {
        # Local models are self-hosted → no per-token cost.
        "ollama:": (0.0, 0.0),
        # Public Claude list prices (per 1K tokens = per-MTok / 1000).
        "anthropic:claude-opus-4-8": (0.005, 0.025),   # $5 / $25 per MTok
        "anthropic:claude-opus-4-7": (0.005, 0.025),
        "anthropic:claude-sonnet-4-6": (0.003, 0.015), # $3 / $15 per MTok
        "anthropic:claude-haiku-4-5": (0.001, 0.005),  # $1 / $5 per MTok
        "anthropic:": (0.005, 0.025),  # generic fallback for other Claude models
        # Public DeepSeek list prices (per 1K tokens = per-MTok / 1000). The draft
        # path runs DeepSeek (LLM_PROVIDER_DRAFT=deepseek), so this is the paid
        # cloud path that most needs a cost estimate. Confirm current pricing at
        # platform.deepseek.com before relying on these; override via LLM_PRICE_TABLE.
        "deepseek:deepseek-chat": (0.00027, 0.0011),      # V3: $0.27 / $1.10 per MTok
        "deepseek:deepseek-reasoner": (0.00055, 0.00219), # R1: $0.55 / $2.19 per MTok
        "deepseek:": (0.00027, 0.0011),  # generic fallback for other DeepSeek models
        # W-16: OpenRouter is the ACCEPTED hosted production path (one key, Opus
        # for decisions + DeepSeek for drafting), and its labels carry the
        # upstream id — `openrouter:anthropic/claude-opus-4.8` — so none of the
        # prefixes above match and every paid call reported est_cost_usd=None.
        # OpenRouter proxies at (approximately) upstream list prices; confirm
        # current rates at openrouter.ai/models, override via LLM_PRICE_TABLE.
        # NOTE OpenRouter ids use dots in versions (claude-opus-4.8) where the
        # direct Anthropic ids above use dashes (claude-opus-4-8).
        "openrouter:anthropic/claude-opus-4.8": (0.005, 0.025),
        "openrouter:anthropic/claude-opus-4.7": (0.005, 0.025),
        "openrouter:anthropic/claude-sonnet-4.6": (0.003, 0.015),
        "openrouter:anthropic/claude-haiku-4.5": (0.001, 0.005),
        "openrouter:anthropic/": (0.005, 0.025),  # other Claude models via OpenRouter
        "openrouter:deepseek/deepseek-chat": (0.00027, 0.0011),  # matches -v3* ids too
        "openrouter:deepseek/deepseek-r1": (0.00055, 0.00219),
        "openrouter:deepseek/": (0.00027, 0.0011),  # other DeepSeek models via OpenRouter
    }
    raw = os.getenv("LLM_PRICE_TABLE", "").strip()
    if raw:
        for part in raw.split(","):
            if ":" not in part or "/" not in part:
                continue
            prefix, prices = part.rsplit(":", 1)
            try:
                in_s, out_s = prices.split("/", 1)
                table[prefix.strip()] = (float(in_s), float(out_s))
            except ValueError:
                continue
    return table


def _estimate_cost(model: str, input_tokens: int | None, output_tokens: int | None) -> float | None:
    if input_tokens is None and output_tokens is None:
        return None
    table = _price_table()
    # Longest matching prefix wins (so "anthropic:claude-opus-4-8" beats "anthropic:").
    match = None
    for prefix in sorted(table, key=len, reverse=True):
        if model.startswith(prefix):
            match = table[prefix]
            break
    if match is None:
        return None
    in_rate, out_rate = match
    return round((input_tokens or 0) / 1000 * in_rate + (output_tokens or 0) / 1000 * out_rate, 6)


def extract_usage(result: object) -> tuple[int | None, int | None, int | None]:
    """Pull (input, output, total) token counts from a LangChain result.

    Reads `.usage_metadata` (the modern LangChain field, populated by ChatOllama /
    ChatAnthropic when the backend returns usage). Returns (None, None, None) when the
    provider didn't report usage — telemetry degrades to latency-only, never fails.
    """
    usage = getattr(result, "usage_metadata", None)
    if isinstance(usage, dict):
        in_t = usage.get("input_tokens")
        out_t = usage.get("output_tokens")
        total = usage.get("total_tokens")
        if total is None and (in_t is not None or out_t is not None):
            total = (in_t or 0) + (out_t or 0)
        return (
            in_t if isinstance(in_t, int) else None,
            out_t if isinstance(out_t, int) else None,
            total if isinstance(total, int) else None,
        )
    return (None, None, None)


class SpendCapExceeded(RuntimeError):
    """Raised mid-request when the running estimated cost of the active capture
    crosses LLM_MAX_REQUEST_COST_USD (P4 spend guard). A route catches this and
    degrades (falls back to rules / escalates) rather than let a runaway
    negotiation loop keep spending. Carries the running total + cap for the log."""

    def __init__(self, running_cost: float, cap: float) -> None:
        self.running_cost = running_cost
        self.cap = cap
        super().__init__(
            f"per-request LLM spend cap exceeded: "
            f"est ${running_cost:.4f} > cap ${cap:.4f} (LLM_MAX_REQUEST_COST_USD)"
        )


def _request_cost_cap_usd() -> float:
    """Per-request estimated-cost ceiling. 0 (default) disables the guard, so
    local Ollama ($0) and the existing suites are unaffected. Set a small dollar
    value in a hosted (paid) deployment to bound a single runaway loop."""
    raw = os.getenv("LLM_MAX_REQUEST_COST_USD", "").strip()
    if not raw:
        return 0.0
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 0.0


def emit_llm_metric(record: LLMCallRecord) -> None:
    """The SINGLE sink for an instrumented LLM call. Today it logs a structured
    line, appends to the in-process ring buffer, and hands the record to any
    active per-request capture (see capture_llm_calls); wire an OTel/Prometheus
    exporter HERE to ship the same record to a real backend (the acceptance-
    criterion infra) without touching any call site.

    P4 spend guard: after appending to the active capture, if the running
    estimated cost of THIS request crosses LLM_MAX_REQUEST_COST_USD, raise
    SpendCapExceeded so a runaway loop is stopped mid-flight. The record is still
    buffered/logged first, so the call that tipped over the cap is observable."""
    _recent.append(record)
    captured = _active_capture.get()
    if captured is not None:
        captured.append(record)
    # Structured, grep-/parse-friendly. Keep keys stable — dashboards key on them.
    logger.info(
        "llm_call model=%s promptVersion=%s latency_ms=%.0f input_tokens=%s "
        "output_tokens=%s total_tokens=%s est_cost_usd=%s ok=%s error_kind=%s",
        record.model,
        record.prompt_version,
        record.latency_ms,
        record.input_tokens,
        record.output_tokens,
        record.total_tokens,
        record.est_cost_usd,
        record.ok,
        record.error_kind,
    )

    # P4 spend guard — bound a single request. Only meaningful inside a capture
    # (a route's request scope) and when a cap is configured. The record above is
    # already buffered + logged, so the tipping call stays observable.
    cap = _request_cost_cap_usd()
    if cap > 0 and captured is not None:
        running = round(sum(r.est_cost_usd or 0.0 for r in captured), 6)
        if running > cap:
            logger.warning(
                "llm_spend_cap_exceeded running_cost_usd=%.6f cap_usd=%.6f calls=%d",
                running,
                cap,
                len(captured),
            )
            raise SpendCapExceeded(running, cap)


def record_llm_call(
    *,
    model: str,
    latency_ms: float,
    result: object | None,
    prompt_version: str | None = None,
    ok: bool = True,
    error_kind: str | None = None,
) -> LLMCallRecord:
    """Build + emit an LLMCallRecord from a completed (or failed) LLM invoke."""
    in_t, out_t, total = extract_usage(result) if result is not None else (None, None, None)
    record = LLMCallRecord(
        model=model,
        prompt_version=prompt_version,
        latency_ms=round(latency_ms, 1),
        input_tokens=in_t,
        output_tokens=out_t,
        total_tokens=total,
        est_cost_usd=_estimate_cost(model, in_t, out_t),
        ok=ok,
        error_kind=error_kind,
    )
    emit_llm_metric(record)
    return record


# ---------------------------------------------------------------------------
# Prompt-version context (item 47: stamp PROMPT_VERSION on every AI call)
# ---------------------------------------------------------------------------
# The LLM layer (llm.py) doesn't know which prompt is being run — the routes do.
# A route sets the active prompt version for the duration of a call so the
# telemetry record can be stamped with it without threading the string through
# every function signature. A ContextVar (not a module global): FastAPI runs
# sync endpoints on a threadpool, so concurrent requests would cross-stamp each
# other's prompt version through a shared global. record_llm_call runs on the
# request's own thread (the executor in structured.py only bounds model.invoke),
# so the request context is visible everywhere a record is emitted.

_active_prompt_version: ContextVar[str | None] = ContextVar(
    "llm_prompt_version", default=None
)


def set_active_prompt_version(version: str | None) -> None:
    _active_prompt_version.set(version)


def get_active_prompt_version() -> str | None:
    return _active_prompt_version.get()


# ---------------------------------------------------------------------------
# Per-request usage capture (usage crosses the HTTP seam to the caller)
# ---------------------------------------------------------------------------
# The ring buffer is process-wide and ephemeral — it cannot answer "what did
# THIS request cost" and dies with the process. capture_llm_calls() gives a
# route a request-scoped list that every record emitted during the request is
# appended to (including failed candidates and repair retries), which the route
# then returns to the TS server as the response's `llmUsage` block. ContextVar
# keeps concurrent requests' captures isolated.

_active_capture: ContextVar["list[LLMCallRecord] | None"] = ContextVar(
    "llm_usage_capture", default=None
)


@contextmanager
def capture_llm_calls() -> Iterator[list[LLMCallRecord]]:
    """Collect every LLMCallRecord emitted while the context is active."""
    records: list[LLMCallRecord] = []
    token = _active_capture.set(records)
    try:
        yield records
    finally:
        _active_capture.reset(token)


def usage_payload(records: list[LLMCallRecord]) -> dict:
    """Shape a capture into the wire `llmUsage` block: per-call records plus
    request totals. Token totals treat providers that reported no usage as 0;
    `calls` carries the per-call None so "unreported" stays distinguishable."""
    return {
        "calls": [asdict(r) for r in records],
        "totals": {
            "calls": len(records),
            "inputTokens": sum(r.input_tokens or 0 for r in records),
            "outputTokens": sum(r.output_tokens or 0 for r in records),
            "totalTokens": sum(r.total_tokens or 0 for r in records),
            "estCostUsd": round(sum(r.est_cost_usd or 0.0 for r in records), 6),
            "latencyMs": round(sum(r.latency_ms for r in records), 1),
            "errors": sum(1 for r in records if not r.ok),
        },
    }


def recent_records() -> list[dict]:
    """Snapshot of the recent-call ring buffer (for a /metrics-style surface)."""
    return [asdict(r) for r in _recent]


def summary() -> dict:
    """Coarse aggregate over the ring buffer — the shape a metrics endpoint would
    expose (call count, error rate, p-ish latency, token + cost totals). This is a
    convenience for the scaffolding; a real backend computes these server-side."""
    records = list(_recent)
    if not records:
        return {"calls": 0}
    latencies = sorted(r.latency_ms for r in records)
    errors = sum(1 for r in records if not r.ok)
    total_tokens = sum(r.total_tokens or 0 for r in records)
    total_cost = sum(r.est_cost_usd or 0.0 for r in records)
    return {
        "calls": len(records),
        "error_rate": round(errors / len(records), 4),
        "latency_ms_p50": latencies[len(latencies) // 2],
        "latency_ms_max": latencies[-1],
        "total_tokens": total_tokens,
        "est_cost_usd": round(total_cost, 6),
    }
