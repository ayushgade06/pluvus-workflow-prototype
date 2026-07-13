"""Unit tests for the always-escalate topic gate (Phase E / #4,#5,#9,#11).

Covers app.topic_gate directly + its wiring into /classify and /negotiate. Pure
functions / deterministic gates — no LLM, no network.
"""

import pytest

from app.topic_gate import (
    TOPIC_POLICY,
    detect_escalation_topic,
    detect_topic,
)


# ---------------------------------------------------------------------------
# TOPIC_POLICY invariants
# ---------------------------------------------------------------------------


def test_policy_covers_expected_topics():
    # The Q3-locked split: these commercial/commitment topics escalate, payment
    # timing defers.
    assert TOPIC_POLICY["legal_or_contract"] == "escalate"
    assert TOPIC_POLICY["dispute_or_hostile"] == "escalate"
    assert TOPIC_POLICY["pricing_exception"] == "escalate"
    assert TOPIC_POLICY["undefined_terms"] == "escalate"
    assert TOPIC_POLICY["usage_rights_or_licensing"] == "escalate"
    assert TOPIC_POLICY["payment_timing"] == "defer"


def test_policy_values_are_valid():
    assert all(v in ("escalate", "defer") for v in TOPIC_POLICY.values())


# ---------------------------------------------------------------------------
# Escalate categories → detect_escalation_topic returns the reason code
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, expected",
    [
        ("We need to add an indemnification clause to the contract.", "legal_or_contract"),
        ("My attorney will need to review the agreement first.", "legal_or_contract"),
        ("Can you amend the terms of service to remove the exclusivity clause?", "legal_or_contract"),
        ("I never got paid for the last campaign — you owe me.", "dispute_or_hostile"),
        ("This is a scam and I'm going to report you.", "dispute_or_hostile"),
        ("You missed the payment deadline again.", "dispute_or_hostile"),
        ("Can we do a performance bonus if I hit 10k in sales?", "pricing_exception"),
        ("I'd want a guaranteed minimum payment regardless of results.", "pricing_exception"),
        ("Let's do a revenue share instead of a flat fee.", "pricing_exception"),
        ("What are the usage rights on the content?", "usage_rights_or_licensing"),
        ("Do you need category exclusivity from me?", "usage_rights_or_licensing"),
        ("Will you be whitelisting my post to run as a paid ad?", "usage_rights_or_licensing"),
        ("Do you want a perpetual license to my video?", "usage_rights_or_licensing"),
    ],
)
def test_escalate_topics_detected(text, expected):
    assert detect_escalation_topic(text) == expected


# ---------------------------------------------------------------------------
# Defer + normal → detect_escalation_topic returns None
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        # payment timing — policy "defer": NOT an escalation (Q3).
        "When do I get paid after I post?",
        "What's your payment schedule — is it net 30?",
        "How soon will I receive the payment?",
        # ordinary engaged replies — no topic at all.
        "Sounds great, I could do $400 for a reel.",
        "Yes, I'm interested — tell me more about the campaign!",
        "What's the deliverable and timeline?",
        "",
    ],
)
def test_non_escalating_returns_none(text):
    assert detect_escalation_topic(text) is None


def test_payment_timing_detected_but_not_escalated():
    # detect_topic sees the topic; detect_escalation_topic filters it out (defer).
    assert detect_topic("when do I get paid?") == "payment_timing"
    assert detect_escalation_topic("when do I get paid?") is None


def test_escalate_wins_over_defer_on_multi_match():
    # A reply mentioning BOTH licensing (escalate) and payment timing (defer)
    # escalates — the stricter policy wins (escalate topics checked first).
    text = "Do you want usage rights, and also when do I get paid?"
    assert detect_escalation_topic(text) == "usage_rights_or_licensing"


# ---------------------------------------------------------------------------
# /classify wiring — an escalate topic forces UNKNOWN + escalationReason
# ---------------------------------------------------------------------------


def test_classify_escalate_topic_forces_manual_review():
    from app.routes.classify import classify_message

    resp = classify_message("My lawyer needs to review and amend the contract terms.")
    assert resp.intent == "UNKNOWN"
    assert resp.confidence == 0.0
    assert resp.escalationReason == "legal_or_contract"


def test_classify_escalate_topic_wins_over_rate_statement():
    from app.routes.classify import classify_message

    # Names a rate (would normally FORCE POSITIVE) but ALSO demands perpetual
    # usage rights → must escalate, not auto-route to negotiation.
    resp = classify_message("I can do $400, but I need a perpetual license to my content.")
    assert resp.intent == "UNKNOWN"
    assert resp.escalationReason == "usage_rights_or_licensing"


def test_classify_payment_timing_does_not_escalate():
    from app.routes.classify import classify_message

    # A benign payment-timing question must NOT escalate on the topic; it flows to
    # the normal path (the question gate forces QUESTION → negotiation).
    resp = classify_message("Sounds good — quick question, when do I get paid?")
    assert resp.escalationReason is None
    assert resp.intent != "UNKNOWN" or resp.confidence > 0.0


# ---------------------------------------------------------------------------
# /negotiate wiring — a mid-negotiation topic escalates BEFORE any model call
# ---------------------------------------------------------------------------


def _neg(reply):
    from app.routes.negotiate import (
        CampaignConstraints,
        NegotiateRequest,
        NegotiationTerm,
        _langgraph_negotiate,
    )

    req = NegotiateRequest(
        creatorReply=reply,
        currentOffer=NegotiationTerm(rate=300),
        round=1,
        maxRounds=3,
        negotiationHistory=[],
        campaignConstraints=CampaignConstraints(
            termFloor=NegotiationTerm(rate=100),
            termCeiling=NegotiationTerm(rate=500),
        ),
    )
    return _langgraph_negotiate(req)


def test_negotiate_legal_topic_escalates():
    r = _neg("Happy to continue, but my lawyer needs to add an indemnification clause first.")
    assert r.action == "ESCALATE"
    assert r.escalationReason == "legal_or_contract"


def test_negotiate_usage_rights_topic_escalates():
    r = _neg("One more thing — do you want exclusivity and a perpetual license to my content?")
    assert r.action == "ESCALATE"
    assert r.escalationReason == "usage_rights_or_licensing"
