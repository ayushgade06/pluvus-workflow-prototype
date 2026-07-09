"""Integration tests for the negotiate route's schema-enforced path (FIX-6).

Fake LLM injected via monkeypatch; no real model needed. Verifies the structured
output flows into the deterministic decision (_decide_action) and that malformed
output is retried then surfaced as an error (no silent wrong-money decision).
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app.routes import negotiate as neg_mod
from app.structured import StructuredOutputError


class FakeLLM:
    def __init__(self, outputs):
        self._outputs = list(outputs)
        self.calls = 0

    def invoke(self, _prompt):
        out = self._outputs[min(self.calls, len(self._outputs) - 1)]
        self.calls += 1

        class _R:
            content = out

        return _R()


def _req(reply="How about $480?", floor=100, ceiling=500):
    return neg_mod.NegotiateRequest(
        creatorReply=reply,
        currentOffer=neg_mod.NegotiationTerm(rate=floor),
        round=1,
        maxRounds=5,
        negotiationHistory=[],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=floor),
            termCeiling=neg_mod.NegotiationTerm(rate=ceiling),
        ),
    )


def _patch_llm(monkeypatch, outputs):
    # This file tests the DETERMINISTIC rules path (structured extraction →
    # _decide_action). MED-L1 flipped the default strategy to `llm`, so force
    # `rules` explicitly to exercise the path these assertions are about (incl.
    # the malformed-output-raises case). Accept num_predict so the fake matches
    # the real get_llm signature (MED-L2) if the rules path ever threads it.
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "rules")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.2, num_predict=None: FakeLLM(outputs)
    )


def test_rate_proposal_counters_via_structured_path(monkeypatch):
    # floor 100, ceiling 500. Default recommendedOfferPosition is now 0.0 → open
    # at the FLOOR (100). Creator names 480 (>our offer, <=ceil) → COUNTER stepping
    # toward them: avg(100, 480) = 290. Proves structured output → decision wiring.
    _patch_llm(
        monkeypatch,
        ['{"intent": "RATE_PROPOSAL", "response": "Thanks! Let me check.", "creatorRateMentioned": 480}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 290.0}


def test_extraction_drives_decision_and_placeholder_draft(monkeypatch):
    # HARD-P1: the rules prompt is now PURE EXTRACTION — it emits no `response`
    # copy. A bare {intent, creatorRateMentioned} is valid (nothing required to be
    # non-empty), the extracted rate drives the deterministic decision, and
    # responseDraft is a neutral, decision-derived placeholder (never model copy),
    # because /draft renders the real email from the guarded decision.
    _patch_llm(
        monkeypatch,
        ['{"intent": "ACCEPTANCE", "creatorRateMentioned": 250}'],
    )
    resp = neg_mod._langgraph_negotiate(_req(reply="Sounds good, $250 works"))
    assert resp.action == "ACCEPT"
    assert resp.proposedTerms == {"rate": 250.0}
    # Placeholder is an internal marker, not a ready-to-send email.
    assert resp.responseDraft is not None
    assert "internal" in resp.responseDraft.lower()


def test_extracted_rate_not_in_reply_is_dropped(monkeypatch):
    # HARD-P1 substring backstop: the model claims the creator asked $999, but the
    # creator's message contains no such number (they only said "I'm interested").
    # The hallucinated rate must be dropped → no number on the table → a bare
    # "interested" PRESENTS the recommended offer rather than accepting a fabricated
    # figure. (floor 100, ceiling 500, position 0.0 → recommended 100.)
    _patch_llm(
        monkeypatch,
        ['{"intent": "ACCEPTANCE", "creatorRateMentioned": 999}'],
    )
    resp = neg_mod._langgraph_negotiate(_req(reply="Yes, I'm interested!"))
    assert resp.action == "PRESENT_OFFER"
    assert resp.proposedTerms == {"rate": 100.0}


def test_persistently_malformed_raises_not_silent_decision(monkeypatch):
    _patch_llm(monkeypatch, ["not json", "still bad", "nope"])
    with pytest.raises(StructuredOutputError):
        neg_mod._langgraph_negotiate(_req())


def test_string_rate_from_model_is_handled(monkeypatch):
    # creatorRateMentioned as a string must not crash and routes via _coerce_rate.
    _patch_llm(
        monkeypatch,
        ['{"intent": "RATE_PROPOSAL", "response": "Noted.", "creatorRateMentioned": "480"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "COUNTER"
