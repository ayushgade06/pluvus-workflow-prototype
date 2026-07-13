"""Unit tests for the bounded negotiation decision logic (FIX-3).

These tests cover the financial decision boundary in
``app.routes.negotiate._decide_action`` — the accept/counter/escalate split for
a RATE_PROPOSAL, plus the safe coercion of an LLM-provided rate.

Regression target: the previously-dead ``COUNTER`` branch. Before FIX-3 the
condition ``creator_rate <= ceiling_rate`` was the logical complement of
``creator_rate > ceiling_rate``, so *any* rate at or below the ceiling was
auto-ACCEPTed and the COUNTER branch was unreachable. These tests prove COUNTER
is now reachable and that the accept-band is what we intend.

Pure functions, no LLM, no network — deterministic and CI-safe.
"""

import pytest

from app.routes.negotiate import (
    NegotiationDecision,
    NegotiationHistoryEntry,
    NegotiationTerm,
    _coerce_rate,
    _decide_action,
    _last_offered_rate,
)

# Standard band used across the table: floor 100, ceiling 500, recommended 300.
RECOMMENDED = 300.0
CEILING = 500.0


def decide(intent, rate, prior_offer=None, is_final_round=False, consecutive_holds=0):
    return _decide_action(
        intent,
        rate,
        recommended_offer=RECOMMENDED,
        ceiling_rate=CEILING,
        prior_offer=prior_offer,
        is_final_round=is_final_round,
        consecutive_holds=consecutive_holds,
    )


# ---------------------------------------------------------------------------
# RATE_PROPOSAL accept-band — the core of FIX-3
# ---------------------------------------------------------------------------


# Stepping-counter band: when the creator asks above our current offer (= the
# recommended offer on turn 0), we COUNTER at the midpoint of our offer and
# their ask (moving toward them), never above their ask or the ceiling. With
# recommended 300 the round-0 step for an ask R is avg(300, R).
@pytest.mark.parametrize(
    "rate, expected_action, expected_proposed",
    [
        # Above ceiling -> escalate to a human (unchanged behavior).
        (600, "ESCALATE", None),
        (500.01, "ESCALATE", None),
        # At/above our offer but within ceiling -> COUNTER at the midpoint step.
        (500, "COUNTER", 400.0),   # avg(300, 500)
        (480, "COUNTER", 390.0),   # avg(300, 480)
        (301, "COUNTER", 300.5),   # avg(300, 301)
        # Exactly at the recommended offer (= our offer) -> ACCEPT at their number.
        (300, "ACCEPT", 300.0),
        # Below the recommended offer -> ACCEPT (good deal).
        (250, "ACCEPT", 250.0),
        (100, "ACCEPT", 100.0),
    ],
)
def test_rate_proposal_band(rate, expected_action, expected_proposed):
    decision = decide("RATE_PROPOSAL", rate)
    assert decision.action == expected_action
    assert decision.proposed_rate == expected_proposed


def test_counter_branch_is_reachable():
    """A proposal strictly between our offer and ceiling MUST produce a COUNTER,
    not an ACCEPT — and step toward the creator (midpoint), not flat.
    """
    decision = decide("RATE_PROPOSAL", 450)
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == 375.0  # avg(300, 450)


def test_stepping_converges_round_over_round():
    """Each round we step up from OUR last offer toward their (held) ask.

    Recommended 300, ceiling 500, creator holds 500:
      round 0 (our offer 300): avg(300,500)=400
      round 1 (our offer 400): avg(400,500)=450
      round 2 (our offer 450): avg(450,500)=475
    """
    d0 = decide("RATE_PROPOSAL", 500)
    assert d0.action == "COUNTER" and d0.proposed_rate == 400.0
    d1 = decide("RATE_PROPOSAL", 500, prior_offer=400.0)
    assert d1.action == "COUNTER" and d1.proposed_rate == 450.0
    d2 = decide("RATE_PROPOSAL", 500, prior_offer=450.0)
    assert d2.action == "COUNTER" and d2.proposed_rate == 475.0


def test_step_never_exceeds_creator_ask():
    """If the midpoint step would land at/above their ask, accept their ask
    instead of offering MORE than they wanted."""
    # our offer 480, they ask 490: avg=485 < 490 -> still a counter at 485.
    d = decide("RATE_PROPOSAL", 490, prior_offer=480.0)
    assert d.action == "COUNTER" and d.proposed_rate == 485.0
    # our offer 495, they ask 496: avg=495.5 < 496 -> counter 495.5.
    d2 = decide("RATE_PROPOSAL", 496, prior_offer=495.0)
    assert d2.action == "COUNTER" and d2.proposed_rate == 495.5
    # our offer 499, they ask 500: avg=499.5 -> counter 499.5 (still below ask).
    d3 = decide("RATE_PROPOSAL", 500, prior_offer=499.0)
    assert d3.action == "COUNTER" and d3.proposed_rate == 499.5


def test_creator_ask_at_or_below_our_offer_accepts():
    """They met or beat our standing offer -> accept their number."""
    d = decide("RATE_PROPOSAL", 400, prior_offer=420.0)
    assert d.action == "ACCEPT" and d.proposed_rate == 400.0


def test_final_round_accepts_creator_ask_within_ceiling():
    """On the last allowed round, stop holding out: accept their ask (<= ceiling)
    rather than escalating to a human."""
    d = decide("RATE_PROPOSAL", 500, prior_offer=400.0, is_final_round=True)
    assert d.action == "ACCEPT" and d.proposed_rate == 500.0
    # Still escalates if their ask is ABOVE the ceiling, even on the final round.
    d_over = decide("RATE_PROPOSAL", 600, prior_offer=400.0, is_final_round=True)
    assert d_over.action == "ESCALATE"


# ---------------------------------------------------------------------------
# Rate coercion — string / garbage rates fail SAFE (never silent accept / 500)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        (480, 480.0),
        (480.5, 480.5),
        ("480", 480.0),
        ("$480", 480.0),
        ("1,500", 1500.0),
        ("  300  ", 300.0),
        (None, None),
        ("", None),
        ("abc", None),
        ("$", None),
        ("1.2.3", None),
        (True, None),  # bool must not be read as 1.0
        (False, None),
        ([300], None),
        ({}, None),
    ],
)
def test_coerce_rate(raw, expected):
    assert _coerce_rate(raw) == expected


def test_rate_proposal_with_numeric_string_does_not_raise_and_counters():
    """A proposal of "480" (string) must be coerced and routed, not crash.

    Before FIX-3 a string rate hit ``"480" > 500`` which raises TypeError in
    Python 3 -> caught -> HTTP 500. Now it coerces to 480.0 and counters at the
    midpoint step avg(300, 480) = 390.
    """
    decision = decide("RATE_PROPOSAL", "480")
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == 390.0


def test_rate_proposal_with_unreadable_rate_escalates():
    """If the model claims RATE_PROPOSAL but no number can be read, fail safe."""
    decision = decide("RATE_PROPOSAL", "let's talk")
    assert decision.action == "ESCALATE"
    assert decision.proposed_rate is None


def test_rate_proposal_with_null_rate_escalates():
    decision = decide("RATE_PROPOSAL", None)
    assert decision.action == "ESCALATE"


# ---------------------------------------------------------------------------
# Other intents — must be preserved exactly (no behavior change from FIX-3)
# ---------------------------------------------------------------------------


def test_acceptance_uses_creator_rate_when_present():
    """Creator named a concrete number in their acceptance -> ACCEPT at it."""
    decision = decide("ACCEPTANCE", 250)
    assert decision.action == "ACCEPT"
    assert decision.proposed_rate == 250.0


def test_acceptance_above_ceiling_escalates():
    """An 'acceptance' at a number above the ceiling is not a real deal -> human."""
    decision = decide("ACCEPTANCE", 600)
    assert decision.action == "ESCALATE"
    assert decision.proposed_rate is None


def test_acceptance_of_prior_offer_accepts_at_that_offer():
    """No new number, but WE already offered one and they're saying yes to it.

    This is the genuine 'they accepted our offer' case -> ACCEPT at our offer.
    """
    decision = decide("ACCEPTANCE", None, prior_offer=320.0)
    assert decision.action == "ACCEPT"
    assert decision.proposed_rate == 320.0


def test_acceptance_with_no_rate_and_no_prior_offer_counters():
    """The reported bug: 'Yes, I'm interested' with no number ever discussed.

    Before the fix this auto-ACCEPTed at the fabricated midpoint, silently
    inventing an agreed rate the creator never saw. Now there is no number on
    the table, so we COUNTER to actually present the recommended offer instead
    of closing a deal that was never made. We PRESENT the recommended offer
    (informational — does not consume a negotiation round).
    """
    decision = decide("ACCEPTANCE", None)
    assert decision.action == "PRESENT_OFFER"
    assert decision.proposed_rate == RECOMMENDED


def test_acceptance_with_creator_rate_takes_priority_over_prior_offer():
    """If they name a number AND we had a prior offer, honor THEIR number."""
    decision = decide("ACCEPTANCE", 280, prior_offer=320.0)
    assert decision.action == "ACCEPT"
    assert decision.proposed_rate == 280.0


def test_rejection():
    decision = decide("REJECTION", None)
    assert decision.action == "REJECT"
    assert decision.proposed_rate is None


# ---------------------------------------------------------------------------
# HARD-N1 §3 — the deterministic fallback also clamps a below-floor accept UP to
# the floor, unifying the floor invariant with the LLM path's guards. (Before
# this fix _decide_action never received the floor, so it could ACCEPT below it
# while the LLM path clamped up — a split invariant.)
# ---------------------------------------------------------------------------


def _decide_with_floor(intent, rate, floor, prior_offer=None, is_final_round=False):
    return _decide_action(
        intent,
        rate,
        recommended_offer=RECOMMENDED,
        ceiling_rate=CEILING,
        floor_rate=floor,
        prior_offer=prior_offer,
        is_final_round=is_final_round,
    )


def test_acceptance_below_floor_is_clamped_up_to_floor():
    # Creator "accepts" at 50 but the floor is 100 → ACCEPT clamped up to 100.
    d = _decide_with_floor("ACCEPTANCE", 50, floor=100)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 100.0


def test_rate_proposal_below_floor_is_clamped_up_to_floor():
    # They propose 40 (<= our offer 300, so we'd accept their number) but floor
    # 100 raises it to 100. Never accept below the minimum.
    d = _decide_with_floor("RATE_PROPOSAL", 40, floor=100)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 100.0


def test_prior_offer_accept_below_floor_is_clamped_up():
    # "Yes" to a stale prior offer of 60 that somehow sits below a 100 floor.
    d = _decide_with_floor("ACCEPTANCE", None, floor=100, prior_offer=60.0)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 100.0


def test_floor_zero_default_never_clamps_a_real_rate():
    # Default floor 0.0 is a no-op — a positive rate passes through unchanged.
    d = _decide_with_floor("ACCEPTANCE", 250, floor=0)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == 250.0


@pytest.mark.parametrize("intent", ["NEGOTIATION", "OBJECTION", "WAT"])
def test_other_intents_hold_without_consuming_round(intent):
    # MED-N2: NEGOTIATION/OBJECTION/unknown with no number → HOLD at our offer
    # (PRESENT_OFFER, which doesn't burn a round), asking them for a number —
    # not a COUNTER that repeats the identical figure while consuming rounds.
    decision = decide(intent, None)
    assert decision.action == "PRESENT_OFFER"
    assert decision.proposed_rate == RECOMMENDED


@pytest.mark.parametrize("intent", ["NEGOTIATION", "OBJECTION", "WAT"])
def test_no_number_pushback_escalates_after_two_holds(intent):
    # MED-N2: two consecutive holds with still no number is a stalemate code
    # can't resolve — escalate to a human instead of looping the same offer.
    decision = decide(intent, None, consecutive_holds=2)
    assert decision.action == "ESCALATE"
    assert decision.proposed_rate is None


def test_first_and_second_holds_do_not_escalate():
    assert decide("OBJECTION", None, consecutive_holds=0).action == "PRESENT_OFFER"
    assert decide("OBJECTION", None, consecutive_holds=1).action == "PRESENT_OFFER"


def test_rate_discovery_presents_offer_without_consuming_round():
    """A pure 'what's the rate?' question PRESENTS the recommended fee — a
    distinct action so the executor does NOT burn a negotiation round on it."""
    decision = decide("RATE_DISCOVERY", None)
    assert decision.action == "PRESENT_OFFER"
    assert decision.proposed_rate == RECOMMENDED


def test_rate_discovery_with_a_number_is_treated_as_a_proposal():
    """If a 'discovery' message also names a price, treat it as a proposal
    (step/accept), not a pure question."""
    decision = decide("RATE_DISCOVERY", 250)
    assert decision.action == "ACCEPT"  # 250 <= our offer 300
    assert decision.proposed_rate == 250.0


@pytest.mark.parametrize("intent", ["NEGOTIATION", "OBJECTION", "RATE_DISCOVERY"])
def test_rate_present_under_any_intent_uses_stepping(intent):
    """The 7B model often labels a repeated price NEGOTIATION/OBJECTION, not
    RATE_PROPOSAL. When a readable number is present we must STILL step (not fall
    back to a flat recommended offer that ignores both their ask and our prior
    offer). our offer 425, ask 500 -> avg = 462.5.
    """
    d = decide(intent, 500, prior_offer=425.0)
    assert d.action == "COUNTER"
    assert d.proposed_rate == 462.5


def test_counter_never_regresses_below_prior_offer():
    """Once we've offered 425, a later round must never offer BELOW 425 — that
    would look like we're walking back our own offer."""
    # Vague reply (no number) at a later round: HOLD (MED-N2) at our prior
    # offer, not recommended (which is lower).
    d_vague = decide("NEGOTIATION", None, prior_offer=425.0)
    assert d_vague.action == "PRESENT_OFFER"
    assert d_vague.proposed_rate == 425.0
    # Numbered reply: step UP from 425, never down.
    d_num = decide("NEGOTIATION", 500, prior_offer=425.0)
    assert d_num.proposed_rate >= 425.0


# ---------------------------------------------------------------------------
# Edge: no ceiling configured (ceiling defaults to +inf upstream)
# ---------------------------------------------------------------------------


def test_no_ceiling_still_counters_above_recommended():
    """With an infinite ceiling, a high rate is no longer auto-accepted.

    Upstream sets ceiling_rate=inf when termCeiling.rate is unset. The old code
    accepted ANY number in that case. The stepping logic counters at the midpoint
    of our offer (300) and their ask (100000) = 50150 (inf ceiling doesn't cap).
    """
    decision = _decide_action(
        "RATE_PROPOSAL", 100_000, recommended_offer=RECOMMENDED, ceiling_rate=float("inf")
    )
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == 50150.0


def test_decision_is_a_model():
    assert isinstance(decide("REJECTION", None), NegotiationDecision)


# ---------------------------------------------------------------------------
# _last_offered_rate — derives the rate WE last put on the table from history
# ---------------------------------------------------------------------------


def _turn(action, rate=None):
    terms = NegotiationTerm(rate=rate) if rate is not None else None
    return NegotiationHistoryEntry(round=0, action=action, terms=terms)


def test_last_offered_rate_empty_history_is_none():
    assert _last_offered_rate([]) is None


def test_last_offered_rate_returns_most_recent_offer():
    history = [_turn("COUNTER", 350), _turn("COUNTER", 300)]
    assert _last_offered_rate(history) == 300.0


def test_last_offered_rate_ignores_reject_and_escalate():
    """REJECT/ESCALATE turns carry no offer and must be skipped."""
    history = [_turn("COUNTER", 300), _turn("ESCALATE"), _turn("REJECT")]
    assert _last_offered_rate(history) == 300.0


def test_last_offered_rate_ignores_turns_without_a_rate():
    history = [_turn("COUNTER", 300), _turn("COUNTER", None)]
    assert _last_offered_rate(history) == 300.0


def test_last_offered_rate_none_when_only_non_offer_turns():
    history = [_turn("ESCALATE"), _turn("REJECT")]
    assert _last_offered_rate(history) is None


# ---------------------------------------------------------------------------
# Phase C (#12) — over-ceiling tolerance
# ---------------------------------------------------------------------------
# floor 100, ceiling 500. A 10% tolerance → tolerance_ceiling = 550. Within the
# (500, 550] band the agent counters/accepts AT the ceiling (never above it);
# above 550 it escalates. tolerance_ceiling omitted (None) must reproduce today's
# zero-tolerance behavior (boundary == ceiling).

from app.routes.negotiate import _apply_decision_guards  # noqa: E402

TOL_CEILING = 550.0  # ceiling 500 * (1 + 10/100)


def decide_tol(intent, rate, prior_offer=None, is_final_round=False):
    return _decide_action(
        intent,
        rate,
        recommended_offer=RECOMMENDED,
        ceiling_rate=CEILING,
        tolerance_ceiling=TOL_CEILING,
        floor_rate=100.0,
        prior_offer=prior_offer,
        is_final_round=is_final_round,
    )


# ── _decide_action with tolerance ──────────────────────────────────────────


def test_decide_ask_within_tolerance_counters_toward_but_never_above_ceiling():
    # Ask 520 is over the ceiling (500) but within tolerance (<=550). We COUNTER
    # (rather than escalate), stepping toward them but the offer is CAPPED at the
    # ceiling — never above it. With prior_offer 300 the step is avg(300,520)=410.
    d = decide_tol("RATE_PROPOSAL", 520, prior_offer=300.0)
    assert d.action == "COUNTER"
    assert d.proposed_rate == 410.0
    assert d.proposed_rate <= CEILING


def test_decide_ask_within_tolerance_counter_caps_at_ceiling_when_prior_high():
    # When our prior offer is already near the ceiling, the step is capped AT the
    # ceiling (never above), so an in-tolerance over-ceiling ask counters at 500.
    d = decide_tol("RATE_PROPOSAL", 540, prior_offer=490.0)
    assert d.action == "COUNTER"
    assert d.proposed_rate == CEILING


def test_decide_ask_above_tolerance_escalates():
    # Ask 600 is beyond the tolerance ceiling (550) → escalate.
    d = decide_tol("RATE_PROPOSAL", 600, prior_offer=300.0)
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_decide_final_round_within_tolerance_closes_at_ceiling():
    # Final round, ask 530 (over ceiling, within tolerance) → ACCEPT at the
    # ceiling (not their number, and not escalate).
    d = decide_tol("RATE_PROPOSAL", 530, prior_offer=480.0, is_final_round=True)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == CEILING


def test_decide_final_round_above_tolerance_escalates():
    d = decide_tol("RATE_PROPOSAL", 700, prior_offer=480.0, is_final_round=True)
    assert d.action == "ESCALATE"


def test_decide_acceptance_within_tolerance_closes_at_ceiling():
    # They "accept" at 540 (over ceiling, within tolerance) → ACCEPT at the
    # ceiling; we never agree above the real ceiling.
    d = decide_tol("ACCEPTANCE", 540)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == CEILING


def test_decide_acceptance_above_tolerance_escalates():
    d = decide_tol("ACCEPTANCE", 560)
    assert d.action == "ESCALATE"


def test_decide_in_band_unchanged_by_tolerance():
    # An ask at/below the ceiling behaves exactly as before (tolerance is inert).
    d = decide_tol("RATE_PROPOSAL", 450, prior_offer=300.0)
    assert d.action == "COUNTER"
    assert d.proposed_rate == round((300.0 + 450.0) / 2.0, 2)


def test_decide_zero_tolerance_default_escalates_over_ceiling():
    # tolerance_ceiling omitted (None) → defaults to the ceiling → an over-ceiling
    # ask escalates, exactly as before Phase C.
    d = _decide_action(
        "RATE_PROPOSAL",
        520,
        recommended_offer=RECOMMENDED,
        ceiling_rate=CEILING,
        floor_rate=100.0,
        prior_offer=300.0,
    )
    assert d.action == "ESCALATE"


# ── _apply_decision_guards (LLM path) with tolerance ───────────────────────


def guard_tol(action, rate, is_final_round=False, creator_ask=None):
    return _apply_decision_guards(
        action,
        rate,
        floor_rate=100.0,
        ceiling_rate=CEILING,
        tolerance_ceiling=TOL_CEILING,
        is_final_round=is_final_round,
        creator_ask=creator_ask,
    )


def test_guard_accept_within_tolerance_clamps_to_ceiling():
    # The model accepts at 540 (over ceiling, within tolerance) → ACCEPT clamped
    # DOWN to the ceiling (never agree above it).
    d = guard_tol("ACCEPT", 540)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == CEILING


def test_guard_accept_above_tolerance_escalates():
    d = guard_tol("ACCEPT", 600)
    assert d.action == "ESCALATE"


def test_guard_final_round_counter_within_tolerance_closes_at_ceiling():
    # CRITICAL-4 boundary shifted to the tolerance ceiling: a final-round COUNTER
    # with the creator's ask over the ceiling but within tolerance closes at the
    # ceiling instead of escalating.
    d = guard_tol("COUNTER", 500, is_final_round=True, creator_ask=530)
    assert d.action == "ACCEPT"
    assert d.proposed_rate == CEILING


def test_guard_final_round_counter_above_tolerance_escalates():
    # Ask beyond tolerance on the final round → ESCALATE (Case-19 protection,
    # boundary = tolerance ceiling).
    d = guard_tol("COUNTER", 500, is_final_round=True, creator_ask=650)
    assert d.action == "ESCALATE"


def test_guard_zero_tolerance_default_matches_ceiling_boundary():
    # tolerance_ceiling omitted → boundary == ceiling → a final-round over-ceiling
    # ask escalates, exactly as before Phase C.
    d = _apply_decision_guards(
        "COUNTER",
        500,
        floor_rate=100.0,
        ceiling_rate=CEILING,
        is_final_round=True,
        creator_ask=530,
    )
    assert d.action == "ESCALATE"
