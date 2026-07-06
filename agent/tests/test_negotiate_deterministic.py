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


# Deterministic step value for ask 480 from our round-0 offer (= recommended
# 300): avg(300, 480) = 390. Still OUR computed number, never the model's choice.
STEP_480 = 390.0


def test_decision_is_pure_and_reproducible():
    # Same inputs, many invocations → identical result every time.
    results = {
        (_decide_action("RATE_PROPOSAL", 480, recommended_offer=REC, ceiling_rate=CEIL).action,
         _decide_action("RATE_PROPOSAL", 480, recommended_offer=REC, ceiling_rate=CEIL).proposed_rate)
        for _ in range(50)
    }
    assert results == {("COUNTER", STEP_480)}


def test_counter_amount_is_computed_not_model_choice():
    # Even though the creator named 480, we counter with a deterministically
    # computed step (midpoint of our offer and their ask) — the number is ours,
    # computed, not the model's free choice.
    d = _decide_action("RATE_PROPOSAL", 480, recommended_offer=REC, ceiling_rate=CEIL)
    assert d.action == "COUNTER"
    assert d.proposed_rate == STEP_480


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
    # round 1, our offer = recommended = floor 100 (default position 0.0, no prior
    # offer in history), ask 480 → step avg(100, 480) = 290. Deterministic over 20 runs.
    assert seen == {("COUNTER", 290.0)}


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


# ---------------------------------------------------------------------------
# M5 — currentOffer is used as a fallback prior offer ONLY when it is a genuine
# above-floor standing offer (never the floor default).
# ---------------------------------------------------------------------------


def _req_with(current_offer_rate, floor=100, ceiling=500, round_=1, history=None):
    return neg_mod.NegotiateRequest(
        creatorReply="How about $480?",
        currentOffer=neg_mod.NegotiationTerm(rate=current_offer_rate),
        round=round_,
        maxRounds=5,
        negotiationHistory=history or [],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=floor),
            termCeiling=neg_mod.NegotiationTerm(rate=ceiling),
        ),
    )


def test_above_floor_current_offer_seeds_prior_offer(monkeypatch):
    # currentOffer 400 (> floor 100), empty history, creator asks 480.
    # Before M5: prior_offer=None → our_offer=recommended 300 → step avg(300,480)=390.
    # With M5:   prior_offer=400 → step avg(400, 480) = 440. currentOffer is used.
    out = '{"intent": "RATE_PROPOSAL", "response": "ok", "creatorRateMentioned": 480}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(_req_with(400))
    assert r.action == "COUNTER"
    assert r.proposedTerms.get("rate") == 440.0


def test_floor_default_current_offer_is_not_treated_as_prior_offer(monkeypatch):
    # currentOffer == floor (100) is the buildNegotiationRequest DEFAULT, not a
    # real standing offer. It must NOT seed prior_offer. With the default position
    # 0.0 the recommended opening IS the floor (100), so we step from 100:
    # avg(100, 480) = 290. (The point of the test — currentOffer=floor doesn't
    # become a prior offer — still holds; the number just reflects the new default.)
    out = '{"intent": "RATE_PROPOSAL", "response": "ok", "creatorRateMentioned": 480}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(_req_with(100))
    assert r.action == "COUNTER"
    assert r.proposedTerms.get("rate") == 290.0


# ---------------------------------------------------------------------------
# M1 — recommendedOfferPosition knob controls where in the band the opening
# offer sits (default 0.0 = the FLOOR — open low, concede up).
# ---------------------------------------------------------------------------


def _req_position(position, floor=100, ceiling=500):
    kwargs = {}
    if position is not None:
        kwargs["recommendedOfferPosition"] = position
    return neg_mod.NegotiateRequest(
        creatorReply="what's the rate?",
        currentOffer=neg_mod.NegotiationTerm(rate=floor),
        round=0,
        maxRounds=5,
        negotiationHistory=[],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=floor),
            termCeiling=neg_mod.NegotiationTerm(rate=ceiling),
            **kwargs,
        ),
    )


def test_default_position_opens_at_floor(monkeypatch):
    # No position → default 0.0 → recommended = floor = 100, presented on a
    # RATE_DISCOVERY (asking the rate) turn. Open low, concede up.
    out = '{"intent": "RATE_DISCOVERY", "response": "Here it is.", "creatorRateMentioned": null}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(_req_position(None))
    assert r.action == "PRESENT_OFFER"
    assert r.proposedTerms.get("rate") == 100.0


def test_lower_position_opens_lower(monkeypatch):
    # position 0.25 → 100 + 400*0.25 = 200.
    out = '{"intent": "RATE_DISCOVERY", "response": "Here it is.", "creatorRateMentioned": null}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(_req_position(0.25))
    assert r.proposedTerms.get("rate") == 200.0


def test_out_of_range_position_falls_back_to_midpoint(monkeypatch):
    out = '{"intent": "RATE_DISCOVERY", "response": "Here it is.", "creatorRateMentioned": null}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    # 5.0 clamps to 1.0 → ceiling 500; -1 clamps to 0.0 → floor 100.
    assert neg_mod._langgraph_negotiate(_req_position(5.0)).proposedTerms.get("rate") == 500.0
    assert neg_mod._langgraph_negotiate(_req_position(-1.0)).proposedTerms.get("rate") == 100.0


def test_history_prior_offer_wins_over_current_offer(monkeypatch):
    # A real prior offer in history (COUNTER @ 350) must WIN over currentOffer.
    hist = [
        neg_mod.NegotiationHistoryEntry(
            round=0, action="COUNTER", terms=neg_mod.NegotiationTerm(rate=350)
        )
    ]
    out = '{"intent": "RATE_PROPOSAL", "response": "ok", "creatorRateMentioned": 480}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    r = neg_mod._langgraph_negotiate(_req_with(400, history=hist))
    # step from history's 350, not currentOffer's 400: avg(350, 480) = 415.
    assert r.action == "COUNTER"
    assert r.proposedTerms.get("rate") == 415.0


# ---------------------------------------------------------------------------
# M2 — final-round accept is REACHABLE and correct (audit's off-by-one claim was
# incorrect: the executor consults the agent for rounds 0..maxRounds-1, and
# is_final_round = (round+1 >= maxRounds) fires exactly at round maxRounds-1).
# These lock that behavior in against a future round-cap change.
# ---------------------------------------------------------------------------


def test_final_round_accepts_within_ceiling_ask_instead_of_countering(monkeypatch):
    # maxRounds=5 → executor consults for rounds 0..4; the LAST is round 4.
    # At round 4 is_final_round is True, so a within-ceiling ask that we'd
    # normally COUNTER is instead ACCEPTED to close the deal (not escalated).
    out = '{"intent": "RATE_PROPOSAL", "response": "ok", "creatorRateMentioned": 480}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    req = neg_mod.NegotiateRequest(
        creatorReply="How about $480?",
        currentOffer=neg_mod.NegotiationTerm(rate=400),
        round=4,
        maxRounds=5,
        negotiationHistory=[
            neg_mod.NegotiationHistoryEntry(
                round=3, action="COUNTER", terms=neg_mod.NegotiationTerm(rate=400)
            )
        ],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=100),
            termCeiling=neg_mod.NegotiationTerm(rate=500),
        ),
    )
    r = neg_mod._langgraph_negotiate(req)
    assert r.action == "ACCEPT"
    assert r.proposedTerms.get("rate") == 480.0  # closes at their within-ceiling ask


def test_non_final_round_still_counters(monkeypatch):
    # At round 3 of 5 (not final) the same ask COUNTERs (steps), not accepts.
    out = '{"intent": "RATE_PROPOSAL", "response": "ok", "creatorRateMentioned": 480}'
    monkeypatch.setattr(neg_mod, "get_llm", lambda temperature=0: _FakeLLM(out))
    req = neg_mod.NegotiateRequest(
        creatorReply="How about $480?",
        currentOffer=neg_mod.NegotiationTerm(rate=400),
        round=3,
        maxRounds=5,
        negotiationHistory=[
            neg_mod.NegotiationHistoryEntry(
                round=2, action="COUNTER", terms=neg_mod.NegotiationTerm(rate=400)
            )
        ],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=100),
            termCeiling=neg_mod.NegotiationTerm(rate=500),
        ),
    )
    r = neg_mod._langgraph_negotiate(req)
    assert r.action == "COUNTER"
    assert r.proposedTerms.get("rate") == 440.0  # avg(400, 480)
