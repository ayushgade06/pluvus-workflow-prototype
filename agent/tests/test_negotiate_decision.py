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

from app.routes.negotiate import NegotiationDecision, _coerce_rate, _decide_action

# Standard band used across the table: floor 100, ceiling 500, recommended 300.
RECOMMENDED = 300.0
CEILING = 500.0


def decide(intent, rate):
    return _decide_action(
        intent, rate, recommended_offer=RECOMMENDED, ceiling_rate=CEILING
    )


# ---------------------------------------------------------------------------
# RATE_PROPOSAL accept-band — the core of FIX-3
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "rate, expected_action, expected_proposed",
    [
        # Above ceiling -> escalate to a human (unchanged behavior).
        (600, "ESCALATE", None),
        (500.01, "ESCALATE", None),
        # Exactly at the ceiling -> still in negotiation band -> COUNTER
        # (previously this auto-ACCEPTed at the ceiling, overpaying maximally).
        (500, "COUNTER", RECOMMENDED),
        # Between recommended and ceiling -> COUNTER toward recommended.
        # This is the branch that was DEAD before FIX-3.
        (480, "COUNTER", RECOMMENDED),
        (301, "COUNTER", RECOMMENDED),
        # Exactly at the recommended offer -> ACCEPT at their number.
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
    """Explicit regression guard for the dead-branch bug.

    A proposal strictly between recommended and ceiling MUST produce a COUNTER,
    not an ACCEPT. If this ever flips back to ACCEPT, the money-loser is back.
    """
    decision = decide("RATE_PROPOSAL", 450)
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == RECOMMENDED


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
    Python 3 -> caught -> HTTP 500. Now it coerces to 480.0 and counters.
    """
    decision = decide("RATE_PROPOSAL", "480")
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == RECOMMENDED


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
    decision = decide("ACCEPTANCE", 250)
    assert decision.action == "ACCEPT"
    assert decision.proposed_rate == 250.0


def test_acceptance_falls_back_to_recommended_when_no_rate():
    decision = decide("ACCEPTANCE", None)
    assert decision.action == "ACCEPT"
    assert decision.proposed_rate == RECOMMENDED


def test_rejection():
    decision = decide("REJECTION", None)
    assert decision.action == "REJECT"
    assert decision.proposed_rate is None


@pytest.mark.parametrize("intent", ["RATE_DISCOVERY", "NEGOTIATION", "OBJECTION", "WAT"])
def test_other_intents_counter_toward_recommended(intent):
    decision = decide(intent, None)
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == RECOMMENDED


# ---------------------------------------------------------------------------
# Edge: no ceiling configured (ceiling defaults to +inf upstream)
# ---------------------------------------------------------------------------


def test_no_ceiling_still_counters_above_recommended():
    """With an infinite ceiling, a high rate is no longer auto-accepted.

    Upstream sets ceiling_rate=inf when termCeiling.rate is unset. The old code
    accepted ANY number in that case. The band logic now counters instead.
    """
    decision = _decide_action(
        "RATE_PROPOSAL", 100_000, recommended_offer=RECOMMENDED, ceiling_rate=float("inf")
    )
    assert decision.action == "COUNTER"
    assert decision.proposed_rate == RECOMMENDED


def test_decision_is_a_model():
    assert isinstance(decide("REJECTION", None), NegotiationDecision)
