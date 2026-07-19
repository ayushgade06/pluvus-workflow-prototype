"""Unit tests for the always-escalate topic gate (Phase E / #4,#5,#9,#11).

Covers app.topic_gate directly + its wiring into /classify and /negotiate. Pure
functions / deterministic gates — no LLM, no network.
"""

import pytest

from app.topic_gate import (
    TOPIC_POLICY,
    classify_topic_intent,
    detect_escalation_topic,
    detect_escalation_topic_ex,
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
        # usage-rights/exclusivity as a DEMAND (not a question) still escalates.
        ("I require category exclusivity or I'm out.", "usage_rights_or_licensing"),
        ("Remove the usage rights from the deal.", "usage_rights_or_licensing"),
        ("I need a perpetual license fee for my video.", "usage_rights_or_licensing"),
        # whitelisting / paid-media / ownership are NOT knowledge-backed, so even a
        # QUESTION about them escalates (F-Q1/Q2/T3 scope).
        ("Will you be whitelisting my post to run as a paid ad?", "usage_rights_or_licensing"),
        ("Who owns the content and footage after the campaign?", "usage_rights_or_licensing"),
    ],
)
def test_escalate_topics_detected(text, expected):
    assert detect_escalation_topic(text) == expected


# ---------------------------------------------------------------------------
# F-Q1/Q2/T3 — intent-aware gating: a QUESTION about a knowledge-backed sensitive
# topic (usage rights / exclusivity / license duration) does NOT escalate; a
# DEMAND / removal / ultimatum does. Non-knowledge-backed sub-topics (whitelisting
# / paid-media / ownership) escalate even as a question.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Do you need category exclusivity from me?",
        "What are the usage rights on the content?",
        "How long are the usage rights?",
        "Do you want a perpetual license to my video?",
        "Just wondering — is there any exclusivity I should know about?",
        # bundled with other innocent questions (the Q1/T3 real-world shape)
        "What's the fee, do I keep the shoes, and is there any exclusivity?",
        "When do I get paid, and do you need exclusivity?",
    ],
)
def test_answerable_question_not_escalated(text):
    topic, answered = detect_escalation_topic_ex(text)
    assert topic is None, f"a pure question should not escalate: {text!r}"
    assert answered == "usage_rights_or_licensing"
    # Back-compat wrapper agrees.
    assert detect_escalation_topic(text) is None


@pytest.mark.parametrize(
    "text",
    [
        "I require category exclusivity or I'm out.",
        "Remove the usage rights from the deal.",
        "I need a perpetual license to my content.",
        "I won't do it without full exclusivity.",
        "No usage rights — you can't repost my content.",
        "Take it or leave it: exclusive license or no deal.",
    ],
)
def test_demand_on_sensitive_topic_still_escalates(text):
    topic, answered = detect_escalation_topic_ex(text)
    assert topic == "usage_rights_or_licensing", f"a demand must escalate: {text!r}"
    assert answered is None


@pytest.mark.parametrize(
    "text",
    [
        # whitelisting / paid-media / ownership: commitment-bearing, no configured
        # answer → escalate even when phrased as a question.
        "Will you be whitelisting my post to run as a paid ad?",
        "Who owns the content after the campaign?",
    ],
)
def test_non_knowledge_backed_question_still_escalates(text):
    topic, answered = detect_escalation_topic_ex(text)
    assert topic == "usage_rights_or_licensing"
    assert answered is None


def test_classify_topic_intent_biases_to_demand_on_ambiguity():
    # A bare statement (neither a clear question nor a demand) is treated as a
    # demand so it still escalates — we never widen the answerable path on doubt.
    assert classify_topic_intent("the usage rights matter to me", "usage_rights_or_licensing") == "demand"
    # Empty → demand.
    assert classify_topic_intent("", "usage_rights_or_licensing") == "demand"
    # Clear question / clear demand.
    assert classify_topic_intent("what are the usage rights?", "usage_rights_or_licensing") == "question"
    assert classify_topic_intent("I require exclusivity.", "usage_rights_or_licensing") == "demand"


def test_legal_and_pricing_escalate_even_as_a_question():
    # These topics are NOT answerable from knowledge fields, so intent-awareness
    # does not apply — a question still escalates.
    assert detect_escalation_topic("Can my lawyer review the contract terms first?") == "legal_or_contract"
    assert detect_escalation_topic("Could we do a revenue share instead?") == "pricing_exception"


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
    # escalates — the stricter policy wins (escalate topics checked first). Uses a
    # DEMAND on the usage-rights term so intent-awareness doesn't suppress it
    # (a pure usage-rights QUESTION is now answerable — see F-Q1/Q2/T3 tests).
    text = "Remove the usage rights, and also when do I get paid?"
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


def test_negotiate_usage_rights_DEMAND_escalates():
    # A DEMAND to remove/require a sensitive term still escalates mid-negotiation.
    r = _neg("I require full category exclusivity or I'm walking.")
    assert r.action == "ESCALATE"
    assert r.escalationReason == "usage_rights_or_licensing"


def test_negotiate_commission_change_DEMAND_escalates():
    # F-23: a demand to CHANGE the commission % is a structural rewrite of a fixed,
    # non-negotiable term → escalate (pricing_exception), even when bundled with a
    # fee concession. Commission is never a lever the agent may trade.
    r = _neg("10% commission is laughable. I want 40% commission or this doesn't happen.")
    assert r.action == "ESCALATE"
    assert r.escalationReason == "pricing_exception"


def test_negotiate_commission_only_DEMAND_escalates():
    # F-23: converting to a commission-only deal is a structure rewrite → escalate.
    r = _neg("Forget the flat fee — make it commission-only at 30%.")
    assert r.action == "ESCALATE"
    assert r.escalationReason == "pricing_exception"


def test_negotiate_commission_QUESTION_does_not_escalate_on_topic(monkeypatch):
    # F-23 guard-rail: the demand-only policy must NOT catch a plain commission
    # QUESTION — no new %, no change verb, no ultimatum. It flows to the model,
    # which answers "10%, fixed". Mirrors the usage-rights question test.
    from app.routes import negotiate as neg_mod

    class _FakeLLM:
        def invoke(self, _prompt):
            class _R:
                content = (
                    '{"action": "PRESENT_OFFER", "rate": 300, '
                    '"response": "Our commission is 10%.", '
                    '"reasoning": "answering the commission question", '
                    '"creatorRateMentioned": null, '
                    '"creatorQuestions": ["what is the commission?"], '
                    '"pushedFixedTerms": []}'
                )
            return _R()

    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.3, num_predict=None, **_kw: _FakeLLM()
    )
    r = _neg("Quick question — what's the commission on this deal?")
    assert r.escalationReason != "pricing_exception"
    assert r.action == "PRESENT_OFFER"


def test_negotiate_usage_rights_QUESTION_does_not_escalate_on_topic(monkeypatch):
    # F-Q1/Q2/T3: a pure QUESTION about exclusivity no longer escalates on the
    # topic gate — it flows to the model (which answers from the knowledge fields).
    # Inject a fake LLM (PRESENT_OFFER) so the reply reaches the model path instead
    # of hitting Ollama, and assert the topic gate did NOT short-circuit to a topic
    # escalation.
    from app.routes import negotiate as neg_mod

    class _FakeLLM:
        def invoke(self, _prompt):
            class _R:
                content = (
                    '{"action": "PRESENT_OFFER", "rate": 300, '
                    '"response": "Happy to share — no category exclusivity is required.", '
                    '"reasoning": "answering the exclusivity question", '
                    '"creatorRateMentioned": null, '
                    '"creatorQuestions": ["do you need category exclusivity?"], '
                    '"pushedFixedTerms": []}'
                )
            return _R()

    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.3, num_predict=None, **_kw: _FakeLLM()
    )
    r = _neg("Quick question — do you need category exclusivity from me?")
    assert r.escalationReason != "usage_rights_or_licensing"
    assert r.action == "PRESENT_OFFER"


def test_negotiate_escalate_populates_creator_questions():
    # F-Q1/Q2/T3 #2: even when the turn legitimately escalates (a legal matter
    # bundled with a question), the extracted questions are surfaced so the Manual
    # Queue shows the operator exactly what the creator asked.
    r = _neg("My lawyer must review the contract first. Also, when do I get paid?")
    assert r.action == "ESCALATE"
    assert r.escalationReason == "legal_or_contract"
    assert any("paid" in q.lower() for q in r.creatorQuestions), r.creatorQuestions
