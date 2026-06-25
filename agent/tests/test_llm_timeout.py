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
