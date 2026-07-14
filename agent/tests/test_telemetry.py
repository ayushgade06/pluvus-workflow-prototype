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


def test_capture_llm_calls_collects_only_scoped_records():
    # Records emitted inside the capture land in the scoped list; records
    # emitted outside do not.
    telemetry.record_llm_call(model="ollama:outside", latency_ms=1, result=None, ok=True)
    with telemetry.capture_llm_calls() as calls:
        telemetry.record_llm_call(model="ollama:inside", latency_ms=2, result=None, ok=True)
        telemetry.record_llm_call(
            model="ollama:inside", latency_ms=3, result=None, ok=False, error_kind="Boom"
        )
    telemetry.record_llm_call(model="ollama:after", latency_ms=4, result=None, ok=True)
    assert [c.model for c in calls] == ["ollama:inside", "ollama:inside"]


def test_capture_is_isolated_across_contexts():
    # Two captures running in different contexts (as concurrent requests would)
    # must not see each other's records. contextvars.copy_context simulates the
    # per-request context isolation FastAPI provides.
    import contextvars

    seen: dict[str, list[str]] = {}

    def request(name: str) -> None:
        with telemetry.capture_llm_calls() as calls:
            telemetry.record_llm_call(model=f"ollama:{name}", latency_ms=1, result=None, ok=True)
            seen[name] = [c.model for c in calls]

    contextvars.copy_context().run(request, "a")
    contextvars.copy_context().run(request, "b")
    assert seen == {"a": ["ollama:a"], "b": ["ollama:b"]}


def test_usage_payload_shapes_calls_and_totals():
    with telemetry.capture_llm_calls() as calls:
        telemetry.record_llm_call(
            model="anthropic:claude-opus-4-8",
            latency_ms=100.0,
            result=_FakeMsg("{}", {"input_tokens": 1000, "output_tokens": 200, "total_tokens": 1200}),
            prompt_version="offer-v1.4",
            ok=True,
        )
        telemetry.record_llm_call(
            model="anthropic:claude-opus-4-8", latency_ms=50.0, result=None, ok=False, error_kind="Boom"
        )
    payload = telemetry.usage_payload(calls)
    assert len(payload["calls"]) == 2
    # snake_case wire keys (the TS sink parses these exact names).
    assert payload["calls"][0]["input_tokens"] == 1000
    assert payload["calls"][0]["prompt_version"] == "offer-v1.4"
    t = payload["totals"]
    assert t["calls"] == 2
    assert t["inputTokens"] == 1000
    assert t["outputTokens"] == 200
    assert t["totalTokens"] == 1200
    assert t["latencyMs"] == 150.0
    assert t["errors"] == 1
    assert t["estCostUsd"] > 0


def test_usage_payload_empty_capture():
    payload = telemetry.usage_payload([])
    assert payload["calls"] == []
    assert payload["totals"]["calls"] == 0
    assert payload["totals"]["estCostUsd"] == 0.0


def test_classify_route_returns_llm_usage(monkeypatch):
    # The route response must carry the llmUsage block (calls + totals) so the
    # TS server can persist token/cost telemetry attributed to the instance.
    from app.routes import classify as classify_mod

    class _Model:
        def invoke(self, _prompt):
            return _FakeMsg(
                '{"intent": "POSITIVE", "confidence": 0.9, "reasoning": "keen"}',
                {"input_tokens": 20, "output_tokens": 8, "total_tokens": 28},
            )

    monkeypatch.setenv("LLM_INVOKE_TIMEOUT_SECONDS", "0")
    monkeypatch.setattr(classify_mod, "get_llm", lambda temperature=0, **_kw: _Model())

    resp = classify_mod.classify(classify_mod.ClassifyRequest(message="I'd love to collaborate!"))
    assert resp.intent == "POSITIVE"
    assert resp.llmUsage is not None
    assert resp.llmUsage["totals"]["calls"] == 1
    assert resp.llmUsage["totals"]["totalTokens"] == 28


def test_classify_route_deterministic_gate_reports_zero_calls(monkeypatch):
    # A deterministic-gate classification (opt-out keyword, no LLM) still carries
    # an llmUsage block — with zero calls — so the server sink sees a consistent
    # shape on every response.
    from app.routes import classify as classify_mod

    resp = classify_mod.classify(
        classify_mod.ClassifyRequest(message="unsubscribe me please, stop emailing")
    )
    assert resp.intent == "OPT_OUT"
    assert resp.llmUsage is not None
    assert resp.llmUsage["totals"]["calls"] == 0


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
