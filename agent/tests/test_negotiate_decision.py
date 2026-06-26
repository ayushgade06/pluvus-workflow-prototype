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


def decide(intent, rate, prior_offer=None, is_final_round=False):
    return _decide_action(
        intent,
        rate,
        recommended_offer=RECOMMENDED,
        ceiling_rate=CEILING,
        prior_offer=prior_offer,
        is_final_round=is_final_round,
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


@pytest.mark.parametrize("intent", ["NEGOTIATION", "OBJECTION", "WAT"])
def test_other_intents_counter_toward_recommended(intent):
    # NEGOTIATION/OBJECTION/unknown with no number → hold at our offer (COUNTER).
    decision = decide(intent, None)
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == RECOMMENDED


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
    """Once we've offered 425, a later round must never counter BELOW 425 — that
    would look like we're walking back our own offer."""
    # Vague reply (no number) at a later round: hold at our prior offer, not
    # recommended (which is lower).
    d_vague = decide("NEGOTIATION", None, prior_offer=425.0)
    assert d_vague.action == "COUNTER"
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
