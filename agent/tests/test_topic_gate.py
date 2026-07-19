"""Unit tests for the always-escalate topic gate (Phase E / #4,#5,#9,#11).

Covers app.topic_gate directly + its wiring into /classify and /negotiate. Pure
functions / deterministic gates — no LLM, no network.
"""

import pytest

from app.topic_gate import (
    TOPIC_POLICY,
    classify_topic_intent,
    detect_escalation_per_clause,
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


def test_negotiate_bundled_legal_plus_question_flows_and_surfaces(monkeypatch):
    # BUG-A1: a legal DEMAND ("my lawyer must review the contract") bundled with an
    # answerable question ("when do I get paid?") no longer collapses the whole turn
    # to a bare ESCALATE. The turn FLOWS to the negotiator (which answers the payment
    # timing) and the legal clause is SURFACED in creatorQuestions + escalationReason
    # so the human still sees it. (Previously this whole turn was lost to the queue.)
    from app.routes import negotiate as neg_mod

    class _FakeLLM:
        def invoke(self, _prompt):
            class _R:
                content = (
                    '{"action": "PRESENT_OFFER", "rate": 300, '
                    '"response": "Payment is net-30 after the content goes live.", '
                    '"reasoning": "answering the payment-timing question", '
                    '"creatorRateMentioned": null, '
                    '"creatorQuestions": ["when do I get paid?"], '
                    '"pushedFixedTerms": []}'
                )
            return _R()

    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.3, num_predict=None, **_kw: _FakeLLM()
    )
    r = _neg("My lawyer must review the contract first. Also, when do I get paid?")
    # Flows (not a bare handoff), the payment question is answered...
    assert r.action == "PRESENT_OFFER"
    assert any("paid" in q.lower() for q in r.creatorQuestions), r.creatorQuestions
    # ...but the legal clause is surfaced so the human/server still sees it.
    assert r.escalationReason == "legal_or_contract"
    assert any("lawyer" in q.lower() or "contract" in q.lower() for q in r.creatorQuestions), (
        r.creatorQuestions
    )


# ---------------------------------------------------------------------------
# BUG-A1: per-clause topic gate (multi-question collapse)
# ---------------------------------------------------------------------------


def test_per_clause_multiq_with_nda_flows_not_escalates():
    # The headline A1 case: two answerable questions + an NDA demand → FLOW (not a
    # bare escalate), NDA surfaced, topic recorded.
    r = detect_escalation_per_clause(
        "Love it! What is the fee, when do I get paid, and I will need a signed NDA before we start."
    )
    assert r.escalate_now is False
    assert r.escalation_topic == "legal_or_contract"
    assert len(r.answerable_clauses) >= 2  # fee + payment timing
    assert any("nda" in c.lower() for c in r.escalated_clauses)


def test_per_clause_pure_fee_timing_no_escalation():
    r = detect_escalation_per_clause("What is the fee and when do I get paid?")
    assert r.escalate_now is False
    assert r.escalation_topic is None
    assert r.escalated_clauses == []


@pytest.mark.parametrize(
    "text, expected_topic",
    [
        # Single DEMAND on an escalate-topic with nothing answerable → escalate NOW.
        # (The always-escalate DEMAND path must be preserved — not weakened.)
        ("I will need a signed NDA before we start.", "legal_or_contract"),
        ("I will sue you if you do not pay.", "dispute_or_hostile"),
        ("I will sue you and report you to the BBB.", "dispute_or_hostile"),
        ("You never paid me and this is a scam.", "dispute_or_hostile"),
        ("I require full category exclusivity or I walk.", "usage_rights_or_licensing"),
        ("$400 plus perpetual usage rights, non-negotiable.", "usage_rights_or_licensing"),
        ("Make it 40% commission or the deal is off.", "pricing_exception"),
    ],
)
def test_per_clause_single_demand_still_escalates(text, expected_topic):
    r = detect_escalation_per_clause(text)
    assert r.escalate_now is True, r.answerable_clauses
    assert r.escalation_topic == expected_topic


def test_per_clause_fee_plus_exclusivity_demand_flows_and_surfaces():
    # Fee question is answerable; the exclusivity DEMAND rides along in
    # escalated_clauses rather than swallowing the whole turn.
    r = detect_escalation_per_clause(
        "What is the fee, and do you require category exclusivity or I walk?"
    )
    assert r.escalate_now is False
    assert r.escalation_topic == "usage_rights_or_licensing"
    assert any("exclusiv" in c.lower() for c in r.escalated_clauses)
    assert any("fee" in c.lower() for c in r.answerable_clauses)


def test_per_clause_pure_usage_question_does_not_escalate():
    # A pure usage-rights QUESTION is answerable (intent-aware carve-out) → no topic.
    r = detect_escalation_per_clause("Quick question — do you ask for usage rights?")
    assert r.escalate_now is False
    assert r.escalation_topic is None


# ---------------------------------------------------------------------------
# BUG-A1 follow-up: a QUOTED commission % is a question, not a demand
# ---------------------------------------------------------------------------
# Regression for the live finding: a creator asking whether the brand's OWN
# quoted commission ("the 10% commission") is on top of or instead of the fixed
# fee was wrongly classified as a pricing_exception DEMAND and escalated. Quoting
# the configured rate to ask about deal structure is a clarifying QUESTION we can
# answer from the campaign fields — it must flow to the negotiator. A demand to
# CHANGE the commission (F-23) must still escalate.


@pytest.mark.parametrize(
    "text",
    [
        "Is the 10% commission on top of the fixed fee, or instead of it?",
        "Just to confirm, is the 10% commission in addition to the flat fee?",
        "What is the 10% commission based on?",
        "Is the commission on top of the fee or instead of it?",
    ],
)
def test_quoted_commission_question_is_not_a_demand(text):
    # classify_topic_intent must read these as questions, and the whole-text gate
    # must not escalate them.
    assert classify_topic_intent(text, "pricing_exception") == "question"
    assert detect_escalation_topic(text) is None


@pytest.mark.parametrize(
    "text",
    [
        "I want 40% commission or the deal is off.",
        "Make it 20% commission.",
        "Bump my commission to 25%.",
        "Raise the commission to 30 percent.",
        "Raise the commission.",
        "Can we do commission-only, no flat fee?",
    ],
)
def test_commission_change_demand_still_escalates(text):
    # F-23 must be preserved: a real change/removal of the commission escalates.
    assert classify_topic_intent(text, "pricing_exception") == "demand"
    assert detect_escalation_topic(text) == "pricing_exception"


def test_per_clause_multiq_with_quoted_commission_flows():
    # The exact shape from the live run: fixed-fee + payment-timing questions plus a
    # commission-structure clarifying question. No clause is a demand, so the whole
    # turn flows to negotiation (escalate_now False, no topic) instead of collapsing
    # to MANUAL_REVIEW.
    r = detect_escalation_per_clause(
        "What fixed fee are you offering for the Reel plus 3 Stories? "
        "When would payment be sent, before or after the content goes live? "
        "Is the 10% commission on top of the fixed fee, or instead of it?"
    )
    assert r.escalate_now is False
    assert r.escalation_topic is None
    assert r.escalated_clauses == []


def test_classify_multiq_with_quoted_commission_does_not_escalate(monkeypatch):
    # /classify wiring (BUG-A1): the bundled multi-question turn with a quoted-
    # commission clause must NOT be force-escalated by the topic gate. The gate lets
    # it fall through to the LLM path; a QUESTION classification then routes it to
    # negotiation. We stub the LLM (no Ollama) so the test asserts the gate change,
    # not model behavior.
    from app.routes import classify as classify_mod

    class _FakeLLM:
        def invoke(self, _prompt):
            class _R:
                content = '{"intent": "QUESTION", "confidence": 0.9, "reasoning": "asking about deal"}'

            return _R()

    monkeypatch.setattr(classify_mod, "get_llm", lambda temperature=0, **_kw: _FakeLLM())

    resp = classify_mod.classify_message(
        "Yes, interested! What fixed fee are you offering for the Reel plus 3 Stories, "
        "and is the 10% commission on top of the fixed fee or instead of it?"
    )
    # The topic gate no longer force-escalates on the quoted commission clause.
    assert resp.escalationReason is None
    # And the reply reaches negotiation (not a bare MANUAL_REVIEW handoff).
    assert resp.intent != "UNKNOWN"


def test_negotiate_multiq_with_nda_flows_and_surfaces(monkeypatch):
    # /negotiate wiring for A1: the bundled multi-question turn no longer bare-
    # escalates. It flows to the model (answers fee/timing) and surfaces the NDA
    # clause in creatorQuestions + escalationReason for the human.
    from app.routes import negotiate as neg_mod

    class _FakeLLM:
        def invoke(self, _prompt):
            class _R:
                content = (
                    '{"action": "PRESENT_OFFER", "rate": 300, '
                    '"response": "The fee is $300 and payment is net-30 after go-live.", '
                    '"reasoning": "answering the fee and payment questions", '
                    '"creatorRateMentioned": null, '
                    '"creatorQuestions": ["what is the fee?", "when do I get paid?"], '
                    '"pushedFixedTerms": []}'
                )
            return _R()

    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.3, num_predict=None, **_kw: _FakeLLM()
    )
    r = _neg(
        "Love it! What is the fee, when do I get paid, and I will need a signed NDA before we start."
    )
    assert r.action == "PRESENT_OFFER"
    assert r.escalationReason == "legal_or_contract"
    # fee + timing answered, NDA surfaced, no duplicate NDA entry.
    joined = " | ".join(r.creatorQuestions).lower()
    assert "fee" in joined and "paid" in joined and "nda" in joined
    nda_count = sum(1 for q in r.creatorQuestions if "nda" in q.lower())
    assert nda_count == 1, r.creatorQuestions


def test_negotiate_single_legal_demand_still_escalates_after_a1():
    # Regression guard: A1 must not weaken the always-escalate DEMAND path. A single
    # legal demand with nothing answerable still bare-escalates before any model call.
    r = _neg("I will need a signed NDA before we start.")
    assert r.action == "ESCALATE"
    assert r.escalationReason == "legal_or_contract"
