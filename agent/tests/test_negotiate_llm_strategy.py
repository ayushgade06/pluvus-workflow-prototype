"""Tests for the LLM-driven negotiation strategy (NEGOTIATION_STRATEGY=llm).

Two layers are covered:

  1. ``_apply_decision_guards`` — the pure safety layer that bounds whatever the
     model chose to the campaign's money invariants (clamp to [floor, ceiling],
     escalate on over-ceiling ACCEPT / unreadable rate, close on the final
     round). No LLM, no network — deterministic.

  2. ``_langgraph_negotiate`` end to end with a fake LLM injected — proving the
     flag routes to the LLM path, that the guards actually bound a rogue model,
     and that a failed LLM call falls back to the deterministic `_decide_action`
     path (never blocks a negotiation).

The deterministic path itself is covered by test_negotiate_decision.py /
test_negotiate_structured.py; here we only assert the LLM path and its fallback.
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app.routes import negotiate as neg_mod


# ---------------------------------------------------------------------------
# Fakes / builders (mirrors test_negotiate_structured.py conventions)
# ---------------------------------------------------------------------------


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


def _req(reply="How about $480?", floor=100, ceiling=500, round_=1, max_rounds=5, history=None):
    return neg_mod.NegotiateRequest(
        creatorReply=reply,
        currentOffer=neg_mod.NegotiationTerm(rate=floor),
        round=round_,
        maxRounds=max_rounds,
        negotiationHistory=history or [],
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=floor),
            termCeiling=neg_mod.NegotiationTerm(rate=ceiling),
        ),
    )


def _patch_llm(monkeypatch, outputs):
    """Route both strategies through a fake model and force the LLM strategy.

    The fake get_llm accepts num_predict (MED-L2 threads a per-call token cap into
    the llm-negotiate call) so the real signature is matched.
    """
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.3, num_predict=None, **_kw: FakeLLM(outputs)
    )


# ---------------------------------------------------------------------------
# _apply_decision_guards — the pure safety layer
# ---------------------------------------------------------------------------

FLOOR = 100.0
CEILING = 500.0


def guard(action, rate, is_final_round=False, creator_ask=None):
    return neg_mod._apply_decision_guards(
        action,
        rate,
        floor_rate=FLOOR,
        ceiling_rate=CEILING,
        is_final_round=is_final_round,
        creator_ask=creator_ask,
    )


def test_accept_above_ceiling_becomes_escalate():
    # The model tried to close ABOVE the ceiling — we must not agree over budget.
    d = guard("ACCEPT", 600)
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_accept_below_floor_closes_at_creator_number():
    # The floor is a low anchor, not a pay-up minimum: a below-floor ACCEPT closes
    # at the creator's own cheaper number, never raised up to the floor.
    d = guard("ACCEPT", 50)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 50


def test_accept_in_band_is_kept():
    d = guard("ACCEPT", 300)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 300.0


# ---------------------------------------------------------------------------
# ACCEPT must land on a number ON THE TABLE — the live "$250" drift bug.
# ---------------------------------------------------------------------------
# A weak model on the final round returned ACCEPT at a number NEITHER side
# proposed ($250) when the creator asked $400 and our standing offer was $200.
# The old guard only re-based the rate when creator_ask was None, so an in-band
# drift was rubber-stamped and the deal closed at a fabricated price. An ACCEPT
# where the creator named an in-band rate must close AT the creator's ask.


def test_accept_drifted_below_creator_ask_snaps_to_ask():
    # THE BUG: model ACCEPT $250, creator asked $400 (in-band) → accept AT $400,
    # not the model's invented $250.
    d = neg_mod._apply_decision_guards(
        "ACCEPT", 250,
        floor_rate=200.0, ceiling_rate=500.0, is_final_round=True,
        creator_ask=400.0, tolerance_ceiling=500.0, prior_offer=200.0,
    )
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 400.0


def test_accept_drifted_above_creator_ask_never_overpays():
    # Model ACCEPT $450 but the creator only asked $300 → never pay more than the
    # creator asked; close at $300.
    d = neg_mod._apply_decision_guards(
        "ACCEPT", 450,
        floor_rate=200.0, ceiling_rate=500.0, is_final_round=True,
        creator_ask=300.0, tolerance_ceiling=500.0, prior_offer=200.0,
    )
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 300.0


def test_accept_at_creator_ask_is_kept():
    d = neg_mod._apply_decision_guards(
        "ACCEPT", 400,
        floor_rate=200.0, ceiling_rate=500.0, is_final_round=True,
        creator_ask=400.0, tolerance_ceiling=500.0, prior_offer=200.0,
    )
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 400.0


def test_accept_over_ceiling_creator_ask_escalates():
    # The creator's OWN ask is over tolerance → cannot close; hand to a human even
    # if the model rate looks in-band.
    d = neg_mod._apply_decision_guards(
        "ACCEPT", 250,
        floor_rate=200.0, ceiling_rate=500.0, is_final_round=True,
        creator_ask=650.0, tolerance_ceiling=500.0, prior_offer=200.0,
    )
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_accept_rogue_over_ceiling_model_rate_still_escalates():
    # A wildly over-ceiling MODEL rate is a red flag on the money path and still
    # escalates even when the creator's ask is in-band (belt-and-braces safety).
    d = neg_mod._apply_decision_guards(
        "ACCEPT", 900,
        floor_rate=100.0, ceiling_rate=500.0, is_final_round=False,
        creator_ask=480.0, tolerance_ceiling=500.0, prior_offer=100.0,
    )
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_counter_above_ceiling_is_clamped_to_ceiling():
    d = guard("COUNTER", 900)
    assert d.action == "COUNTER"
    assert d.proposed_rate == CEILING


def test_counter_below_floor_is_clamped_to_floor():
    d = guard("COUNTER", 10)
    assert d.action == "COUNTER"
    assert d.proposed_rate == FLOOR


def test_rate_bearing_action_with_unreadable_rate_escalates():
    # ACCEPT/COUNTER/PRESENT_OFFER need a number; garbage/None → fail safe.
    for action in ("ACCEPT", "COUNTER", "PRESENT_OFFER"):
        d = guard(action, None)
        assert d.action == "ESCALATE", action
        assert d.proposed_rate is None
        d2 = guard(action, "not a number")
        assert d2.action == "ESCALATE", action


def test_string_rate_is_coerced():
    d = guard("COUNTER", "480")
    assert d.action == "COUNTER"
    assert d.proposed_rate == 480.0


def test_reject_and_escalate_pass_through_without_rate():
    assert guard("REJECT", None).action == "REJECT"
    assert guard("REJECT", 300).proposed_rate is None  # rate ignored for REJECT
    assert guard("ESCALATE", None).action == "ESCALATE"


def test_unrecognized_action_escalates():
    d = guard("HAGGLE", 300)
    assert d.action == "ESCALATE"


def test_final_round_counter_closes_at_offer():
    # On the last round we cannot counter again — close at the (clamped) number.
    # The creator's ask (460) is within the ceiling, so closing is genuine.
    d = guard("COUNTER", 460, is_final_round=True, creator_ask=460)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 460.0


def test_final_round_counter_closes_when_ask_unknown():
    # No creator_ask read → retain the prior in-band close behavior (fail-safe:
    # a miss on the ask extractor must not suppress a legitimate final close).
    d = guard("COUNTER", 460, is_final_round=True)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 460.0


def test_final_round_over_ceiling_ask_escalates_not_false_accept():
    # CRITICAL-4 / Case-19: creator firmly asks ABOVE the ceiling on the final
    # round. Coercing the model's COUNTER to ACCEPT at the clamped-down ceiling
    # would invent an agreement the creator explicitly rejected. We ESCALATE.
    d = guard("COUNTER", 700, is_final_round=True, creator_ask=650)
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_final_round_in_ceiling_ask_still_closes():
    # Creator's ask is within ceiling on the final round → genuine close (the
    # model countered high at 700, but the creator only asked 480 ≤ ceiling 500).
    # Close at the creator's OWN ask ($480), never the clamped ceiling ($500):
    # the final-round COUNTER→ACCEPT coercion must land on a real on-the-table
    # number and never over-pay (live $250 drift fix — closing at the ceiling here
    # would pay the creator $20 more than they asked, the same over-pay bug).
    d = guard("COUNTER", 700, is_final_round=True, creator_ask=480)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 480.0


# ---------------------------------------------------------------------------
# _langgraph_negotiate end to end with the LLM strategy
# ---------------------------------------------------------------------------


def test_llm_strategy_routes_and_uses_model_rate(monkeypatch):
    # The model itself picks COUNTER at 420 (in band) — the LLM path passes it
    # through unchanged (the deterministic midpoint would have been 390).
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 420, "response": "How about $420?", "reasoning": "meet in the middle"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 420.0}
    # HARD-N1 §4: guards left the decision UNCHANGED (420 in band), so the model's
    # pre-guard draft is kept as an advisory draft.
    assert resp.responseDraft == "How about $420?"
    assert resp.reasoning == "meet in the middle"


# ---------------------------------------------------------------------------
# HARD-N1 §4 — the pre-guard email is DROPPED whenever a guard changed the
# action/rate, so the executor is forced to re-draft from the guarded decision
# (the outgoing email can never state a number that contradicts the deal).
# ---------------------------------------------------------------------------


def test_llm_draft_dropped_when_guard_clamps_below_floor(monkeypatch):
    # Model wrote "How about $20?" but $20 is below the floor (100). The guard
    # clamps the counter UP to 100; the model's "$20" email now contradicts the
    # recorded number, so responseDraft MUST be dropped (executor re-drafts).
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 20, "response": "How about $20?", "reasoning": "lowball"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 100.0}  # raised to floor
    assert resp.responseDraft is None  # pre-guard "$20" email must not ship


def test_llm_draft_dropped_when_over_ceiling_accept_escalates(monkeypatch):
    # Model wrote "Deal at $900!" (ACCEPT over ceiling 500) → guard ESCALATE. No
    # acceptance email may ship; the pre-guard draft is dropped.
    _patch_llm(
        monkeypatch,
        ['{"action": "ACCEPT", "rate": 900, "response": "Deal at $900!", "reasoning": "eager"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "ESCALATE"
    assert resp.proposedTerms is None
    assert resp.responseDraft is None  # no acceptance email ships


def test_llm_draft_kept_when_guard_clamps_above_ceiling_but_still_counter(monkeypatch):
    # Model COUNTER@900 → clamped to ceiling 500 (rate changed) → draft dropped.
    # The creator's own ask is ABOVE the ceiling ($900), so the anti-over-pay
    # guard does NOT convert this to an accept (we're still under their ask) — the
    # action stays COUNTER at the clamped ceiling.
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 900, "response": "How about $900?", "reasoning": "high"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req("My rate is $900."))
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 500.0}
    assert resp.responseDraft is None  # "$900" contradicts the clamped $500


def test_guards_changed_decision_helper():
    # Direct unit coverage of the change-detector: cosmetic diffs are NOT changes.
    from app.routes.negotiate import NegotiationDecision, _guards_changed_decision

    kept = NegotiationDecision(action="COUNTER", proposed_rate=420.0)
    assert _guards_changed_decision("counter", "420", kept) is False  # case/str only
    assert _guards_changed_decision("COUNTER", 420, kept) is False
    clamped = NegotiationDecision(action="COUNTER", proposed_rate=100.0)
    assert _guards_changed_decision("COUNTER", 20, clamped) is True  # rate changed
    escalated = NegotiationDecision(action="ESCALATE", proposed_rate=None)
    assert _guards_changed_decision("ACCEPT", 900, escalated) is True  # action changed


# ---------------------------------------------------------------------------
# F-M8/F-M13 — action-consistent `reasoning`. The stored reasoning is the audit
# line shown in the Manual Queue; it must NEVER contradict the recorded action.
# On a terminal REJECT/ESCALATE or any guard-altered decision we overwrite the
# model's (possibly contradictory) reasoning with a deterministic one.
# ---------------------------------------------------------------------------


def test_reasoning_overwritten_on_escalate_even_if_model_describes_counter(monkeypatch):
    # F-M8: final-round over-ceiling firm ask → guard ESCALATES, but the model's
    # reasoning says "we counter at $450". The stored reasoning must describe the
    # ESCALATE and must not name a number.
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 650, '
         '"response": "Let us secure this at $450.", '
         '"reasoning": "Since this is the final round, we counter at our standing offer of $450 to secure the collaboration."}'],
    )
    resp = neg_mod._langgraph_negotiate(_req("$650 flat, won't go under. Final answer.", round_=4, max_rounds=5))
    assert resp.action == "ESCALATE"
    assert "counter" not in resp.reasoning.lower()
    assert "450" not in resp.reasoning
    assert "human" in resp.reasoning.lower()


def test_commission_change_demand_escalates_even_with_fee_concession(monkeypatch):
    # F-23 (policy: any commission-% CHANGE demand → human, uniformly). The creator
    # bundles a commission rewrite ("bump commission to 20%") WITH a fee concession
    # ("$250 flat", below our $350). Even though $250 is budget-optimal, commission
    # is a fixed, non-negotiable term — a demand to change it is a structural change
    # only a human may approve. The deterministic topic gate fires BEFORE any model
    # call, so this escalates regardless of what the model would have returned.
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 350, '
         '"response": "We remain firm at $350.", '
         '"reasoning": "We remain firm on our $350.00 offer and invite them to accept it.", '
         '"creatorRateMentioned": 250, "pushedFixedTerms": ["commission"]}'],
    )
    resp = neg_mod._langgraph_negotiate(
        _req("Bump my commission to 20% and I'll take just $250 flat.", round_=1, max_rounds=4)
    )
    assert resp.action == "ESCALATE"
    # Reasoning must be action-consistent (an ESCALATE reason) and never leak a rate.
    assert "250" not in (resp.reasoning or "")
    assert "350" not in (resp.reasoning or "")


def test_plain_commission_question_is_not_escalated(monkeypatch):
    # F-23 guard-rail: the demand-only policy must NOT catch a plain commission
    # QUESTION. "what's the commission?" carries no new %, no change verb, no
    # ultimatum → it flows to the model, which answers "10%, fixed". A regression
    # here would flood the Manual Queue with answerable questions.
    _patch_llm(
        monkeypatch,
        ['{"action": "PRESENT_OFFER", "rate": 350, '
         '"response": "Our commission is 10%.", '
         '"reasoning": "Answering the creator\'s commission question.", '
         '"creatorRateMentioned": null}'],
    )
    resp = neg_mod._langgraph_negotiate(
        _req("Quick question — what's the commission on this deal?", round_=1, max_rounds=4)
    )
    assert resp.action != "ESCALATE"


def test_reasoning_kept_when_decision_unaltered(monkeypatch):
    # When the guards leave an in-band COUNTER untouched, the model's own reasoning
    # is preserved (it matches the action).
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 420, "response": "How about $420?", "reasoning": "meet in the middle"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "COUNTER"
    assert resp.reasoning == "meet in the middle"


def test_reasoning_never_leaks_number_on_reject(monkeypatch):
    _patch_llm(
        monkeypatch,
        ['{"action": "REJECT", "rate": null, "response": "No worries!", '
         '"reasoning": "We could have gone to $500 but they declined."}'],
    )
    resp = neg_mod._langgraph_negotiate(_req("Not interested, thanks."))
    assert resp.action == "REJECT"
    assert "500" not in resp.reasoning
    assert "declin" in resp.reasoning.lower() or "closing" in resp.reasoning.lower()


def test_deterministic_reasoning_helper():
    from app.routes.negotiate import NegotiationDecision, _deterministic_reasoning

    esc = _deterministic_reasoning(NegotiationDecision(action="ESCALATE", proposed_rate=None))
    assert "human" in esc.lower()
    esc2 = _deterministic_reasoning(
        NegotiationDecision(action="ESCALATE", proposed_rate=None), escalation_reason="usage_rights_or_licensing"
    )
    assert "usage rights" in esc2.lower()
    acc = _deterministic_reasoning(NegotiationDecision(action="ACCEPT", proposed_rate=250.0))
    assert "250" in acc
    rej = _deterministic_reasoning(NegotiationDecision(action="REJECT", proposed_rate=None))
    assert "declin" in rej.lower()


# ---------------------------------------------------------------------------
# F-M3 — perk-push extraction backstop: the creator's own words inject `perk`
# when the model under-extracted it.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        "$380 works. Oh and can you throw in a second pair of shoes to seal it?",
        "Sounds good — could I get an extra pair too?",
        "Deal, but toss in another pair of shoes.",
        "Yes, and send a signing-bonus pair up front.",
        "Can you add two pairs on top of the perk?",
    ],
)
def test_fm3_augment_injects_perk_from_reply(reply):
    assert "perk" in neg_mod._augment_pushed_terms_from_reply([], reply)


def test_fm3_augment_does_not_duplicate_or_touch_other_terms():
    # Already tagged → unchanged; other terms preserved.
    assert neg_mod._augment_pushed_terms_from_reply(["perk"], "throw in a second pair") == ["perk"]
    out = neg_mod._augment_pushed_terms_from_reply(["commission"], "and an extra pair of shoes")
    assert out == ["commission", "perk"]


def test_fm3_augment_no_false_positive_on_bare_reward_mention():
    # A plain mention of the reward (no CHANGE requested) must not inject perk.
    assert neg_mod._augment_pushed_terms_from_reply([], "Love that the shoes come with the deal!") == []
    assert neg_mod._augment_pushed_terms_from_reply([], "What's the fee?") == []


def test_fm3_end_to_end_injects_perk(monkeypatch):
    # M3: model held the fee (ACCEPT 380) but returned pushedFixedTerms=[]. The
    # backstop injects perk from "second pair of shoes".
    _patch_llm(
        monkeypatch,
        ['{"action": "ACCEPT", "rate": 380, "response": "Deal at $380!", '
         '"reasoning": "met our terms", "creatorRateMentioned": 380, "pushedFixedTerms": []}'],
    )
    req = _req(reply="$380 works. Oh and can you throw in a second pair of shoes?",
               floor=100, ceiling=500, round_=2, max_rounds=4)
    resp = neg_mod._langgraph_negotiate(req)
    assert "perk" in resp.pushedFixedTerms


# ---------------------------------------------------------------------------
# F-T2 — a bare "yes" with no creator rate and no real prior offer must become
# PRESENT_OFFER, never a fabricated ACCEPT at a seeded number.
# ---------------------------------------------------------------------------


def test_ft2_bare_yes_no_prior_offer_becomes_present_offer(monkeypatch):
    # Model "accepts" the seeded currentOffer 350 on a bare "I'm in!" with NO
    # history. There is no real offer to accept → force PRESENT_OFFER.
    _patch_llm(
        monkeypatch,
        ['{"action": "ACCEPT", "rate": 350, "response": "Great, deal at $350!", '
         '"reasoning": "they said yes", "creatorRateMentioned": null}'],
    )
    req = _req(reply="Sounds good, I'm in!", floor=100, ceiling=500, round_=0, max_rounds=4, history=[])
    # seed a non-zero currentOffer the model latched onto
    req.currentOffer = neg_mod.NegotiationTerm(rate=350)
    resp = neg_mod._langgraph_negotiate(req)
    assert resp.action == "PRESENT_OFFER"
    assert resp.proposedTerms is not None
    # The pre-guard "Deal at $350!" email must be dropped (action changed).
    assert resp.responseDraft is None


def test_ft2_bare_yes_WITH_real_prior_offer_still_accepts(monkeypatch):
    # When a REAL offer was already presented (a PRESENT_OFFER turn in history), a
    # bare "yes" is a genuine acceptance of that number — F-T2 must NOT fire.
    _patch_llm(
        monkeypatch,
        ['{"action": "ACCEPT", "rate": 350, "response": "Locking it in at $350!", '
         '"reasoning": "they accepted our presented offer", "creatorRateMentioned": null}'],
    )
    hist = [neg_mod.NegotiationHistoryEntry(round=0, action="PRESENT_OFFER",
                                            terms=neg_mod.NegotiationTerm(rate=350))]
    req = _req(reply="Yes, let's do it!", floor=100, ceiling=500, round_=1, max_rounds=4, history=hist)
    resp = neg_mod._langgraph_negotiate(req)
    assert resp.action == "ACCEPT"
    assert resp.proposedTerms == {"rate": 350.0}


def test_ft2_does_not_fire_when_creator_named_a_rate(monkeypatch):
    # If the creator DID name a number, an ACCEPT is legitimate even with no
    # history — F-T2 only guards the bare "yes with no number" case.
    _patch_llm(
        monkeypatch,
        ['{"action": "ACCEPT", "rate": 300, "response": "Deal at $300!", '
         '"reasoning": "met our terms", "creatorRateMentioned": 300}'],
    )
    req = _req(reply="I'll take $300.", floor=100, ceiling=500, round_=0, max_rounds=4, history=[])
    resp = neg_mod._langgraph_negotiate(req)
    assert resp.action == "ACCEPT"
    assert resp.proposedTerms == {"rate": 300.0}


def test_llm_strategy_guards_over_ceiling_acceptance(monkeypatch):
    # A rogue model tries to ACCEPT above the ceiling → guarded to ESCALATE.
    _patch_llm(
        monkeypatch,
        ['{"action": "ACCEPT", "rate": 900, "response": "Deal at 900!", "reasoning": "eager"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "ESCALATE"
    assert resp.proposedTerms is None


def test_llm_strategy_clamps_below_floor_counter(monkeypatch):
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 20, "response": "How about $20?", "reasoning": "lowball"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 100.0}  # raised to floor


def test_llm_strategy_final_round_closes(monkeypatch):
    # round 4 of 5 → next counter would hit the cap → final round → close. The
    # default reply asks $480 (≤ ceiling 500), so the close is genuine.
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 450, "response": "One more push?", "reasoning": "close"}'],
    )
    resp = neg_mod._langgraph_negotiate(_req(round_=4, max_rounds=5))
    assert resp.action == "ACCEPT"
    assert resp.proposedTerms == {"rate": 450.0}


def test_llm_strategy_case19_final_round_over_ceiling_escalates(monkeypatch):
    # CRITICAL-4 / Case-19 end to end: on the FINAL round the creator firmly asks
    # $650 (above ceiling 500) and won't budge. The model tries to COUNTER; the
    # guard reads the creator's over-ceiling ask and ESCALATES instead of coercing
    # a false ACCEPT at the clamped $500. The pre-guard "deal" draft is dropped so
    # no "congrats on our agreed rate" email can ship (HARD-N1 §4).
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 500, "response": "Can we meet at $500?", "reasoning": "cap"}'],
    )
    resp = neg_mod._langgraph_negotiate(
        _req(reply="My absolute floor is $650, and I won't budge.", round_=4, max_rounds=5),
    )
    assert resp.action == "ESCALATE"
    assert resp.proposedTerms is None
    assert resp.responseDraft is None


def test_llm_strategy_falls_back_to_rules_on_bad_llm_output(monkeypatch):
    # The model output lacks the `action` field the LLM decision schema requires,
    # so the LLM path exhausts its retries and raises StructuredOutputError. The
    # SAME output is valid for the RULES schema (intent + response), so the
    # deterministic fallback parses it and still produces a decision — a failing
    # LLM never blocks a negotiation.
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    # A fresh FakeLLM is built per get_llm() call, so the LLM path and the rules
    # fallback each get their own instance with the same (rules-valid) output.
    monkeypatch.setattr(
        neg_mod,
        "get_llm",
        lambda temperature=0.3, num_predict=None, **_kw: FakeLLM(
            ['{"intent": "RATE_PROPOSAL", "response": "Noted.", "creatorRateMentioned": 480}']
        ),
    )
    resp = neg_mod._langgraph_negotiate(_req())
    # Rules path: floor 100 ceiling 500; default position 0.0 → open at floor 100;
    # ask 480 → COUNTER avg(100, 480) = 290.
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 290.0}


def test_llm_is_the_default_strategy(monkeypatch):
    # MED-L1: no env set → the LLM path now drives the turn (llm is the default;
    # rules is a fallback). Feed a VALID llm-decision output (action + rate) and
    # assert the model's own COUNTER@420 is used (the rules path would have
    # computed the deterministic midpoint 290 instead — proving the LLM path ran).
    monkeypatch.delenv("NEGOTIATION_STRATEGY", raising=False)
    monkeypatch.setattr(
        neg_mod,
        "get_llm",
        lambda temperature=0.3, num_predict=None, **_kw: FakeLLM(
            ['{"action": "COUNTER", "rate": 420, "response": "How about $420?", "reasoning": "mid"}']
        ),
    )
    resp = neg_mod._langgraph_negotiate(_req())
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 420.0}


def test_rules_strategy_when_forced(monkeypatch):
    # NEGOTIATION_STRATEGY=rules forces the deterministic path (e.g. reproducible
    # audit). A rules-shaped extraction output → the _decide_action ladder.
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "rules")
    monkeypatch.setattr(
        neg_mod,
        "get_llm",
        lambda temperature=0, **_kw: FakeLLM(
            ['{"intent": "RATE_PROPOSAL", "response": "Noted.", "creatorRateMentioned": 480}']
        ),
    )
    resp = neg_mod._langgraph_negotiate(_req())
    # Default position 0.0 → open at floor 100; ask 480 → COUNTER avg(100,480)=290.
    assert resp.action == "COUNTER"
    assert resp.proposedTerms == {"rate": 290.0}
