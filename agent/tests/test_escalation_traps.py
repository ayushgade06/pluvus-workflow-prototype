"""T2 — Escalation-trap AGENT GUARD-MATH tests (deterministic, no model, no HTTP).

Purpose: lock the founder's V1 escalation *decision logic* at the layer where it
lives — the pure guard functions the LLM's output is bounded by. These call the
agent's decision functions DIRECTLY with crafted numbers/text, so they prove the
"code guards" half of "LLM decides, code guards" without a model call.

This complements:
  * T1 (server/src/engine/escalationTraps.test.ts) — the routing layer, and
  * T3 (readme_docs/testing/README.md) — the live Ollama end-to-end runbook.

Covered (guard-math trap matrix):
  * Over-tolerance ask                → ESCALATE
  * In-tolerance over-ceiling ask     → close AT the ceiling (never above — no overpay)
  * Final round, ask within tolerance → ACCEPT at the clamped (ceiling-capped) rate
  * Final round, ask over tolerance   → ESCALATE (no fabricated acceptance, CRITICAL-4)
  * Never agree above the ceiling / never offer below the floor
  * Topic gate: escalate topics escalate; payment-timing DEFERS (returns None) (Q3)
  * Topic gate is deterministic (fires without a model — injection-proof)

ASSERTION BASIS (locked decision): assert CURRENT documented behavior so the suite
stays green and describes reality. Any divergence from the founder's LITERAL
wording is flagged with a `# KNOWN DIVERGENCE` comment and catalogued in
readme_docs/testing/README.md.

Run:  cd agent && pytest tests/test_escalation_traps.py -q
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app.routes.negotiate import (  # noqa: E402
    NegotiationDecision,
    _apply_decision_guards,
    _decide_action,
)
from app.topic_gate import (  # noqa: E402
    TOPIC_POLICY,
    detect_escalation_topic,
    detect_topic,
)

FLOOR = 200.0
CEIL = 500.0


# ---------------------------------------------------------------------------
# Guard trap: over-tolerance ask → ESCALATE (#12)
# ---------------------------------------------------------------------------

def test_guard_over_tolerance_ask_escalates():
    # tolerance 0 → tolerance_ceiling == ceiling. An ACCEPT above it must escalate,
    # never agree over budget.
    d = _apply_decision_guards(
        "ACCEPT", 5000,
        floor_rate=FLOOR, ceiling_rate=CEIL, tolerance_ceiling=CEIL,
        is_final_round=False,
    )
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_guard_unreadable_rate_escalates():
    # The model wants to put a number down but gave nothing readable → fail safe.
    d = _apply_decision_guards(
        "COUNTER", "some words, no number",
        floor_rate=FLOOR, ceiling_rate=CEIL, tolerance_ceiling=CEIL,
        is_final_round=False,
    )
    assert d.action == "ESCALATE"


def test_guard_unknown_action_escalates():
    d = _apply_decision_guards(
        "MAYBE", 300,
        floor_rate=FLOOR, ceiling_rate=CEIL, is_final_round=False,
    )
    assert d.action == "ESCALATE"


# ---------------------------------------------------------------------------
# Guard trap: in-tolerance over-ceiling ask → close AT ceiling, NEVER above (#12)
# The no-overpay invariant — tolerance shifts the ESCALATE boundary, not the pay.
# ---------------------------------------------------------------------------

def test_guard_in_tolerance_accept_clamps_to_ceiling_not_above():
    # 20% tolerance → tolerance_ceiling 600. Creator "accepted"/model proposes 560
    # (over the 500 ceiling but within tolerance). We must CLOSE — but AT 500, the
    # real ceiling, never at 560.
    tol_ceiling = round(CEIL * 1.20, 2)  # 600.0
    d = _apply_decision_guards(
        "ACCEPT", 560,
        floor_rate=FLOOR, ceiling_rate=CEIL, tolerance_ceiling=tol_ceiling,
        is_final_round=False,
    )
    assert d.action == "ACCEPT"
    assert d.proposed_rate == CEIL, "in-tolerance close pays AT the ceiling, never above"


def test_guard_counter_never_exceeds_ceiling():
    # A COUNTER the model set above the ceiling is clamped down to the ceiling.
    tol_ceiling = round(CEIL * 1.20, 2)
    d = _apply_decision_guards(
        "COUNTER", 560,
        floor_rate=FLOOR, ceiling_rate=CEIL, tolerance_ceiling=tol_ceiling,
        is_final_round=False,
    )
    assert d.proposed_rate is not None
    assert d.proposed_rate <= CEIL, "a counter is never offered above the real ceiling"


def test_guard_offer_never_below_floor():
    # A below-floor number is clamped UP to the floor (never pay below minimum).
    d = _apply_decision_guards(
        "ACCEPT", 50,
        floor_rate=FLOOR, ceiling_rate=CEIL, is_final_round=False,
    )
    assert d.action == "ACCEPT"
    assert d.proposed_rate == FLOOR


# ---------------------------------------------------------------------------
# Guard trap: final round behavior (#13 + CRITICAL-4)
# ---------------------------------------------------------------------------

def test_guard_final_round_in_tolerance_accepts_at_clamped_rate():
    # Final round, creator's own ask within tolerance → close (ACCEPT), clamped to
    # the real ceiling. The ceiling IS the approval limit (#13): no human needed.
    tol_ceiling = round(CEIL * 1.20, 2)  # 600
    d = _apply_decision_guards(
        "COUNTER", 480,
        floor_rate=FLOOR, ceiling_rate=CEIL, tolerance_ceiling=tol_ceiling,
        is_final_round=True, creator_ask=480,
    )
    assert d.action == "ACCEPT"
    assert d.proposed_rate is not None and d.proposed_rate <= CEIL


def test_guard_final_round_over_tolerance_escalates_not_false_accept():
    # CRITICAL-4: final round, creator FIRMLY asked above tolerance ($650 vs tol
    # ceiling $600) → ESCALATE. Never coerce a COUNTER into a fabricated ACCEPT at
    # the clamped ceiling for a number the creator explicitly rejected.
    tol_ceiling = round(CEIL * 1.20, 2)  # 600
    d = _apply_decision_guards(
        "COUNTER", 650,
        floor_rate=FLOOR, ceiling_rate=CEIL, tolerance_ceiling=tol_ceiling,
        is_final_round=True, creator_ask=650,
    )
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_guard_default_tolerance_ceiling_is_plain_ceiling():
    # When no tolerance_ceiling is passed it defaults to the ceiling (zero
    # tolerance = today's hard boundary). An ask just over the ceiling on the final
    # round escalates.
    d = _apply_decision_guards(
        "COUNTER", 501,
        floor_rate=FLOOR, ceiling_rate=CEIL,  # tolerance_ceiling omitted
        is_final_round=True, creator_ask=501,
    )
    assert d.action == "ESCALATE"


# ---------------------------------------------------------------------------
# RULES path: an over-ceiling ask escalates IMMEDIATELY, even on an early round.
# This MATCHES the founder's #12 literal ("escalate immediately"). The divergence
# below is that the LLM path does NOT enforce the same on an early-round COUNTER.
# ---------------------------------------------------------------------------

def test_decide_action_early_round_over_ceiling_escalates_immediately():
    """The deterministic rules engine escalates an over-ceiling ask on ANY round.

    Founder #12: an ask above tolerance should "escalate immediately". The pure
    `_decide_action` does exactly that — a $5000 ask vs a $500 ceiling returns
    ESCALATE even on round 0 (not a counter). This is the founder-aligned path.
    """
    d = _decide_action(
        "RATE_PROPOSAL", 5000,
        recommended_offer=FLOOR, ceiling_rate=CEIL, floor_rate=FLOOR,
        tolerance_ceiling=CEIL, is_final_round=False,
    )
    assert d.action == "ESCALATE"
    assert d.proposed_rate is None


def test_guard_allows_early_round_counter_below_ceiling_on_over_ceiling_ask():
    """LLM path: anchor low on an early round, escalate at max-rounds (README D-1).

    INTENDED V1 behavior (decision 2026-07-13): unlike `_decide_action` (which
    escalates an over-ceiling ask immediately), the LLM-path guard
    `_apply_decision_guards` lets the model COUNTER at/below the ceiling on an EARLY
    round — anchoring low (clamped ≤ ceiling) — and only forces ESCALATE for an
    over-tolerance ask on the FINAL round (CRITICAL-4, tested above). So with
    NEGOTIATION_STRATEGY=llm, a $5000 ask can be met with a below-ceiling counter on
    round 0 (the live curl behavior). This is intended: it minimizes manual-queue
    volume (#15), and there is no overpay because the counter is clamped to the
    ceiling. The rules fallback (`_decide_action`) escalates immediately instead —
    an intentional, safe conservative degrade when the model is unavailable.
    """
    d = _apply_decision_guards(
        "COUNTER", 200,  # model anchored low on a $5000 ask
        floor_rate=FLOOR, ceiling_rate=CEIL, tolerance_ceiling=CEIL,
        is_final_round=False, creator_ask=5000,
    )
    # The guard permits the below-ceiling counter (does not escalate here).
    assert d.action == "COUNTER"
    assert d.proposed_rate is not None and d.proposed_rate <= CEIL


# ---------------------------------------------------------------------------
# Topic gate traps (#5, Q3) — deterministic, fires without a model.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected_topic",
    [
        # F-Q1/Q2/T3: a usage-rights/exclusivity DEMAND still escalates (a pure
        # QUESTION about the same is now answerable — see the intent-aware tests
        # below and in test_topic_gate.py).
        ("I want category exclusivity and a non-compete.", "usage_rights_or_licensing"),
        ("I require exclusive usage rights and licensing for my content.", "usage_rights_or_licensing"),
        # whitelisting / spark-ad is a commitment with no configured answer →
        # escalates even as a question.
        ("Can you whitelist my post / run it as a spark ad?", "usage_rights_or_licensing"),
        ("I need a performance bonus structure tiered per conversion (CPA).", "pricing_exception"),
        ("My lawyer needs to review the agreement first.", "legal_or_contract"),
        ("I still haven't been paid from the last campaign — you owe me.", "dispute_or_hostile"),
        ("This is a scam and I'm going to report you.", "dispute_or_hostile"),
    ],
)
def test_topic_gate_escalates_commercial_and_legal_topics(text, expected_topic):
    reason = detect_escalation_topic(text)
    assert reason == expected_topic, f"expected {expected_topic}, got {reason!r}"
    assert TOPIC_POLICY[reason] == "escalate"


def test_topic_gate_usage_rights_QUESTION_is_answerable_not_escalated():
    # F-Q1/Q2/T3: a pure QUESTION about knowledge-backed usage rights / exclusivity
    # no longer escalates — it flows to the negotiator which answers from the
    # campaign knowledge fields. (A DEMAND still escalates — see the parametrized
    # test above.)
    assert detect_escalation_topic("Can we discuss the usage rights and licensing for my content?") is None
    assert detect_escalation_topic("Do you need category exclusivity from me?") is None


def test_topic_gate_payment_timing_defers_not_escalates():
    # Q3: "when do I get paid?" is benign scheduling → honest-defer, NOT a human
    # handoff. detect_escalation_topic returns None (so the normal defer path runs),
    # even though detect_topic still classifies it as payment_timing.
    text = "Quick question — when do I get paid after posting? What's the payment timeline?"
    assert detect_escalation_topic(text) is None
    assert detect_topic(text) == "payment_timing"
    assert TOPIC_POLICY["payment_timing"] == "defer"


def test_topic_gate_ignores_benign_reply():
    # A normal engaged reply must NOT trip any escalation topic (avoid false
    # positives flooding the manual queue).
    assert detect_escalation_topic("Sounds great, when do we start? Happy to move forward.") is None


def test_topic_gate_stricter_policy_wins_on_multi_match():
    # A reply mentioning BOTH a licensing DEMAND (escalate) and payment timing
    # (defer) must escalate — the stricter policy wins (escalate topics are checked
    # first). F-Q1/Q2/T3: uses a DEMAND phrasing so intent-awareness doesn't
    # suppress it (a pure licensing QUESTION is now answerable).
    text = "I insist on keeping the licensing rights, and also when do I get paid?"
    assert detect_escalation_topic(text) == "usage_rights_or_licensing"


def test_topic_gate_is_deterministic_no_model():
    # The gate is pure regex — same input, same output, no model, no network.
    text = "I need perpetual usage rights in perpetuity."
    results = {detect_escalation_topic(text) for _ in range(50)}
    assert results == {"usage_rights_or_licensing"}


# ---------------------------------------------------------------------------
# NEGATIVE guard sanity — REJECT / ESCALATE pass through with no number.
# ---------------------------------------------------------------------------

def test_guard_reject_and_escalate_carry_no_rate():
    for action in ("REJECT", "ESCALATE"):
        d = _apply_decision_guards(
            action, None,
            floor_rate=FLOOR, ceiling_rate=CEIL, is_final_round=False,
        )
        assert isinstance(d, NegotiationDecision)
        assert d.action == action
        assert d.proposed_rate is None
