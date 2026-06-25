"""Tests for deterministic negotiation decisions (FIX-10).

The money decision (accept/counter/escalate + the counter amount) is computed by
the pure `_decide_action` over numbers — the model only classifies intent and
extracts the creator's rate. These tests assert:

  1. Identical decision inputs always yield an identical decision (reproducible).
  2. The decision number never comes from the model's free choice — it is either
     the creator's (validated) rate or the deterministically-computed
     recommended offer.
  3. The model's self-reported `confidence` does not influence the decision.

Pure where possible; the end-to-end check uses a fake LLM (no real model).
"""

import pytest

from app.routes.negotiate import _decide_action

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")
from app.routes import negotiate as neg_mod  # noqa: E402


REC = 300.0
CEIL = 500.0


def test_decision_is_pure_and_reproducible():
    # Same inputs, many invocations → identical result every time.
    results = {
        (_decide_action("RATE_PROPOSAL", 480, recommended_offer=REC, ceiling_rate=CEIL).action,
         _decide_action("RATE_PROPOSAL", 480, recommended_offer=REC, ceiling_rate=CEIL).proposed_rate)
        for _ in range(50)
    }
    assert results == {("COUNTER", REC)}


def test_counter_amount_is_recommended_not_model_choice():
    # Even though the creator named 480, we counter with the deterministic
    # recommended offer — the number is ours, computed, not the model's.
    d = _decide_action("RATE_PROPOSAL", 480, recommended_offer=REC, ceiling_rate=CEIL)
    assert d.action == "COUNTER"
    assert d.proposed_rate == REC


def test_accept_amount_is_creator_validated_rate_not_invented():
    d = _decide_action("RATE_PROPOSAL", 250, recommended_offer=REC, ceiling_rate=CEIL)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 250.0  # the creator's number, validated — not invented


class _FakeLLM:
    def __init__(self, output):
        self._output = output

    def invoke(self, _prompt):
        class _R:
            content = self._output

        return _R()


def _req():
    return neg_mod.NegotiateRequest(
        creatorReply="How about $480?",
        currentOffer=neg_mod.NegotiationTerm(rate=100),
        round=1,
        maxRounds=5,
        negotiationHistory=[],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=100),
            termCeiling=neg_mod.NegotiationTerm(rate=500),
        ),
    )


def test_end_to_end_decision_reproducible(monkeypatch):
    # Identical extraction output → identical decision across many runs.
    out = '{"intent": "RATE_PROPOSAL", "response": "Let me check.", "creatorRateMentioned": 480}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    seen = {
        (r.action, None if r.proposedTerms is None else r.proposedTerms.get("rate"))
        for r in (neg_mod._langgraph_negotiate(_req()) for _ in range(20))
    }
    assert seen == {("COUNTER", 300.0)}


def test_confidence_does_not_change_decision(monkeypatch):
    # Two different self-reported confidences, same rate → same decision.
    high = '{"intent": "RATE_PROPOSAL", "response": "ok", "creatorRateMentioned": 480, "confidence": 0.99}'
    low = '{"intent": "RATE_PROPOSAL", "response": "ok", "creatorRateMentioned": 480, "confidence": 0.10}'

    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(high))
    a = neg_mod._langgraph_negotiate(_req())
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(low))
    b = neg_mod._langgraph_negotiate(_req())

    assert (a.action, a.proposedTerms) == (b.action, b.proposedTerms)


def test_negotiate_call_uses_temperature_zero(monkeypatch):
    # Guard against a regression back to a non-zero (stochastic) decision call.
    captured = {}

    def fake_get_llm(temperature=0):
        captured["temperature"] = temperature
        return _FakeLLM('{"intent": "REJECTION", "response": "No thanks."}')

    monkeypatch.setattr(neg_mod, "get_llm", fake_get_llm)
    neg_mod._langgraph_negotiate(_req())
    assert captured["temperature"] == 0
