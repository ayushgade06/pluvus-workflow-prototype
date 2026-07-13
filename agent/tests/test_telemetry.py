"""HARD-O1: unit coverage for the LLM telemetry scaffolding.

Deterministic — no live model. Asserts the record shape, usage extraction, cost
estimation, prompt-version stamping, and that the invoke seam emits a record.
"""

from __future__ import annotations

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app import telemetry


class _FakeMsg:
    """A LangChain-ish result with content + usage_metadata."""

    def __init__(self, content, usage=None):
        self.content = content
        if usage is not None:
            self.usage_metadata = usage


def test_extract_usage_reads_usage_metadata():
    msg = _FakeMsg("{}", {"input_tokens": 100, "output_tokens": 40, "total_tokens": 140})
    assert telemetry.extract_usage(msg) == (100, 40, 140)


def test_extract_usage_computes_total_when_absent():
    msg = _FakeMsg("{}", {"input_tokens": 10, "output_tokens": 5})
    assert telemetry.extract_usage(msg) == (10, 5, 15)


def test_extract_usage_no_metadata_returns_none():
    assert telemetry.extract_usage(_FakeMsg("{}")) == (None, None, None)


def test_cost_zero_for_local_ollama():
    # Local models are self-hosted → no per-token cost.
    assert telemetry._estimate_cost("ollama:qwen3:30b", 1000, 1000) == 0.0


def test_cost_nonzero_for_anthropic_prefix():
    cost = telemetry._estimate_cost("anthropic:claude-opus-4-8", 1000, 1000)
    assert cost is not None and cost > 0


def test_record_llm_call_emits_and_buffers():
    before = len(telemetry.recent_records())
    rec = telemetry.record_llm_call(
        model="ollama:test",
        latency_ms=123.4,
        result=_FakeMsg("{}", {"input_tokens": 50, "output_tokens": 20, "total_tokens": 70}),
        prompt_version="offer-v1.4",
        ok=True,
    )
    assert rec.model == "ollama:test"
    assert rec.prompt_version == "offer-v1.4"
    assert rec.total_tokens == 70
    assert rec.est_cost_usd == 0.0  # local
    assert len(telemetry.recent_records()) == before + 1


def test_prompt_version_context_roundtrip():
    telemetry.set_active_prompt_version("draft-v1.3")
    assert telemetry.get_active_prompt_version() == "draft-v1.3"
    telemetry.set_active_prompt_version(None)
    assert telemetry.get_active_prompt_version() is None


def test_summary_aggregates_the_buffer():
    # Emit a couple of records and confirm the summary shape.
    telemetry.record_llm_call(model="ollama:t", latency_ms=10, result=None, ok=True)
    telemetry.record_llm_call(model="ollama:t", latency_ms=30, result=None, ok=False, error_kind="Boom")
    s = telemetry.summary()
    assert s["calls"] >= 2
    assert 0.0 <= s["error_rate"] <= 1.0
    assert "latency_ms_p50" in s and "est_cost_usd" in s


def test_invoke_seam_emits_a_record(monkeypatch):
    # Drive the real structured._invoke_with_timeout direct path with a fake model
    # and assert a telemetry record is emitted, stamped with the active version.
    from app import structured

    class _Model:
        def invoke(self, _prompt):
            return _FakeMsg('{"ok": true}', {"input_tokens": 12, "output_tokens": 3, "total_tokens": 15})

    # Disable the wall-clock bound so the call runs inline in this test.
    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0")
    telemetry.set_active_prompt_version("classify-v1.0")
    before = len(telemetry.recent_records())
    content = structured._invoke_with_timeout(_Model(), "hi")
    telemetry.set_active_prompt_version(None)

    assert content == '{"ok": true}'
    records = telemetry.recent_records()
    assert len(records) == before + 1
    last = records[-1]
    assert last["prompt_version"] == "classify-v1.0"
    assert last["total_tokens"] == 15
    assert last["ok"] is True
