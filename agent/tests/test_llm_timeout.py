"""Tests for the Python-side llm.invoke wall-clock timeout (FIX-9).

The TS caller aborts the HTTP request after AGENT_TIMEOUT_MS, but without a
Python-side bound a hung generation keeps running and pins the FastAPI worker.
`_invoke_with_timeout` bounds each call so the request returns promptly.

These use a fake LLM whose invoke() sleeps, with a tiny budget set via env, so
they run in well under a second and need no real model.
"""

from __future__ import annotations

import time

import pytest

from app import structured
from app.structured import (
    LLMTimeoutError,
    StructuredOutputError,
    _invoke_with_timeout,
    invoke_structured,
)
from pydantic import BaseModel


class _Schema(BaseModel):
    intent: str


class SlowLLM:
    """invoke() sleeps `delay` seconds, then returns `content`."""

    def __init__(self, delay: float, content: str = '{"intent": "POSITIVE"}'):
        self.delay = delay
        self.content = content
        self.calls = 0

    def invoke(self, _prompt):
        self.calls += 1
        time.sleep(self.delay)

        class _R:
            content = self.content

        return _R()


def test_invoke_completes_within_budget(monkeypatch):
    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "5")
    out = _invoke_with_timeout(SlowLLM(0.0), "p")
    assert out == '{"intent": "POSITIVE"}'


def test_invoke_times_out_over_budget(monkeypatch):
    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0.1")
    with pytest.raises(LLMTimeoutError):
        _invoke_with_timeout(SlowLLM(2.0), "p")


def test_timeout_is_a_structured_output_error(monkeypatch):
    # Subclass relationship matters: classify/negotiate already catch
    # StructuredOutputError, so a timeout flows into the existing safe paths.
    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0.1")
    with pytest.raises(StructuredOutputError):
        _invoke_with_timeout(SlowLLM(2.0), "p")


def test_disabled_budget_runs_inline(monkeypatch):
    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0")
    # A slow call still completes (no timeout) when the budget is disabled.
    out = _invoke_with_timeout(SlowLLM(0.05), "p")
    assert out == '{"intent": "POSITIVE"}'


def test_invalid_budget_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "not-a-number")
    assert structured._invoke_timeout_seconds() == 60.0


def test_invoke_structured_propagates_timeout_without_burning_retries(monkeypatch):
    # A timeout must NOT be retried as if it were malformed output — the model
    # isn't responding. The slow LLM should be invoked exactly once.
    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0.1")
    llm = SlowLLM(2.0)
    with pytest.raises(LLMTimeoutError):
        invoke_structured(llm, "p", _Schema, retries=2)
    assert llm.calls == 1


# ---------------------------------------------------------------------------
# MED-L2 — the timeout is PER CANDIDATE inside FailoverChat, so a hung primary
# times out and the fallback still runs with a fresh budget (previously one
# budget spanned the whole chain, so a stuck primary starved the fallback).
# ---------------------------------------------------------------------------


def test_failover_per_candidate_timeout_runs_fallback_on_hung_primary(monkeypatch):
    from app.llm import FailoverChat

    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0.2")
    hung_primary = SlowLLM(2.0, content='{"intent": "PRIMARY"}')  # exceeds 0.2s
    fast_fallback = SlowLLM(0.0, content='{"intent": "FALLBACK"}')
    chat = FailoverChat(
        [("primary", lambda _t: hung_primary), ("fallback", lambda _t: fast_fallback)], 0
    )
    # The primary times out (per-candidate budget), the fallback then answers.
    out = chat.invoke("p")
    assert out.content == '{"intent": "FALLBACK"}'
    assert hung_primary.calls == 1
    assert fast_fallback.calls == 1


def test_invoke_with_timeout_does_not_double_wrap_failover(monkeypatch):
    # A FailoverChat passed to _invoke_with_timeout must NOT be re-bounded (it
    # bounds each candidate itself); we assert it delegates to .invoke and returns
    # the content, with the per-candidate budget applied inside.
    from app.llm import FailoverChat

    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "5")
    ok = SlowLLM(0.0, content='{"intent": "OK"}')
    chat = FailoverChat([("only", lambda _t: ok)], 0)
    assert _invoke_with_timeout(chat, "p") == '{"intent": "OK"}'


# ---------------------------------------------------------------------------
# W-9(a) — a saturated invoke pool must FAIL FAST, not block forever.
#
# future.cancel() is a no-op once a generation has started, so timed-out orphans
# keep holding their pool threads. Before the capacity-semaphore fix, once the
# pool filled with orphans the NEXT call blocked on .submit() BEFORE its budget
# even started — hanging the worker and defeating the timeout. These tests prove
# the new call now times out within roughly its own budget instead.
# ---------------------------------------------------------------------------


def test_saturated_pool_fails_fast_instead_of_blocking(monkeypatch):
    import threading as _threading

    from app.structured import invoke_model_bounded, _resize_invoke_pool_for_test

    # Shrink the pool to 1 so a single hung generation saturates it.
    _resize_invoke_pool_for_test(1)
    try:
        # A generation that "hangs" until we let it go — models an orphan that
        # keeps its thread past the timeout.
        release = _threading.Event()

        class Hanger:
            def invoke(self, _p):
                release.wait(10)  # hang until released (or a hard 10s backstop)

                class _R:
                    content = "late"

                return _R()

        monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0.2")

        # Fill the single slot with the hung generation on a background thread; it
        # will time out (0.2s) but its thread stays busy (orphan) holding the permit.
        def _saturate():
            try:
                invoke_model_bounded(Hanger(), "p")
            except LLMTimeoutError:
                pass

        t = _threading.Thread(target=_saturate)
        t.start()
        time.sleep(0.35)  # let the first call time out and orphan its thread

        # Now the pool is saturated by the orphan. A new call must fail fast —
        # within ~its budget, NOT block until the orphan finishes (up to 10s).
        start = time.perf_counter()
        with pytest.raises(LLMTimeoutError):
            invoke_model_bounded(SlowLLM(0.0, content='{"ok": true}'), "p")
        elapsed = time.perf_counter() - start
        assert elapsed < 1.0, f"saturated call blocked {elapsed:.2f}s — should fail fast"

        # Cleanup: release the orphan so the thread can exit.
        release.set()
        t.join(timeout=5)
    finally:
        # Restore a normally-sized pool for any later tests in this process.
        _resize_invoke_pool_for_test(16)


def test_permit_is_returned_after_normal_completion(monkeypatch):
    # A successful call must release its permit so capacity is not leaked — run
    # more calls than the pool size, serially, and confirm they all succeed.
    from app.structured import invoke_model_bounded, _resize_invoke_pool_for_test

    _resize_invoke_pool_for_test(1)
    try:
        monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "5")
        for _ in range(5):
            out = invoke_model_bounded(SlowLLM(0.0, content="ok"), "p")
            assert out.content == "ok"
    finally:
        _resize_invoke_pool_for_test(16)
