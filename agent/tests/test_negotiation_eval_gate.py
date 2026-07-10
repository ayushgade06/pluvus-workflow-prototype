"""HARD-T1: deterministic, CI-runnable machine-assertions for the load-bearing
negotiation eval cases — the ones whose SAFE outcome is decided by the
deterministic guard layer (`_apply_decision_guards`), not by the model's free
choice. These run with a FAKE model injected, so they are offline and stable in
CI (unlike run_eval.py, which hits a live model over HTTP and is opt-in).

The full 22-case matrix in negotiation_eval/run_eval.py is now machine-asserted
against a LIVE model (ASSERTS covers every case, Case-19 = ESCALATE). But a live
eval is gated behind RUN_LLM_EVAL because it needs a running agent + model. This
file is the always-on tripwire for the subset whose correctness must NOT depend
on model behavior at all:

  * Case-19 (above-ceiling on the FINAL round) MUST ESCALATE — validating
    CRITICAL-4. A rogue/eager model that picks ACCEPT or COUNTER at the
    creator's over-ceiling ask is deterministically overridden to ESCALATE.
  * Over-ceiling ACCEPT → ESCALATE (never auto-commit above budget).
  * Below-floor rate → clamped UP to the floor (never auto-offer below minimum).
  * Unreadable/absent rate on a rate-bearing action → ESCALATE (never invent).

If any of these regress, the build fails — these are money-safety invariants,
not tactics, so they belong in code, not just in a live eval a human reads.
"""

import pytest

pytest.importorskip("langgraph", reason="langgraph not installed (ai extra)")

from app.routes import negotiate as neg_mod


class _FakeLLM:
    """Returns a fixed model output string per invoke (mirrors the FakeLLM in
    test_negotiate_llm_strategy.py)."""

    def __init__(self, outputs):
        self._outputs = list(outputs)
        self.calls = 0

    def invoke(self, _prompt):
        out = self._outputs[min(self.calls, len(self._outputs) - 1)]
        self.calls += 1

        class _R:
            content = out

        return _R()


def _H(round0, action, rate=None):
    e = {"round": round0, "action": action}
    if rate is not None:
        e["terms"] = {"rate": rate}
    return neg_mod.NegotiationHistoryEntry(**e)


def _req(reply, *, floor=200, ceiling=500, round_, max_rounds, current_offer, history):
    """Build a NegotiateRequest mirroring the eval band (floor 200 / ceiling 500)."""
    return neg_mod.NegotiateRequest(
        creatorReply=reply,
        currentOffer=neg_mod.NegotiationTerm(rate=current_offer),
        round=round_,
        maxRounds=max_rounds,
        negotiationHistory=history,
        campaignConstraints=neg_mod.CampaignConstraints(
            termFloor=neg_mod.NegotiationTerm(rate=floor),
            termCeiling=neg_mod.NegotiationTerm(rate=ceiling),
        ),
    )


def _patch_llm(monkeypatch, outputs):
    monkeypatch.setenv("NEGOTIATION_STRATEGY", "llm")
    monkeypatch.setattr(
        neg_mod, "get_llm", lambda temperature=0.3, num_predict=None: _FakeLLM(outputs)
    )


# ---------------------------------------------------------------------------
# Case 19 — the CRITICAL-4 assertion (must ESCALATE, never fold)
# ---------------------------------------------------------------------------
# Eval case 19: round 3 of 4 (the final allowed round), standing offer $450,
# creator firmly asks $650 (above the $500 ceiling). The correct, safe outcome
# is ESCALATE — closing at a clamped $500 and calling it ACCEPT would invent an
# agreement the creator explicitly rejected.

_CASE_19 = dict(
    reply="My absolute floor is $650, and I won't budge.",
    round_=3,
    max_rounds=4,
    current_offer=450,
    history=[_H(0, "PRESENT_OFFER", 300), _H(1, "COUNTER", 400), _H(2, "COUNTER", 450)],
)


@pytest.mark.parametrize(
    "model_output",
    [
        # An eager model tries to ACCEPT the over-ceiling ask on the final round →
        # the over-ceiling ACCEPT guard escalates (never auto-commit above budget).
        '{"action": "ACCEPT", "rate": 650, "response": "Deal at $650!", "reasoning": "final round, close it"}',
        # A model tries to COUNTER at the over-ceiling ask on the final round →
        # the CRITICAL-4 final-round guard escalates (the creator's own ask is above
        # the ceiling, so coercing the counter to an ACCEPT would invent a deal the
        # creator explicitly rejected).
        '{"action": "COUNTER", "rate": 650, "response": "How about $650?", "reasoning": "meet them"}',
        # A model tries to COUNTER at an in-band number on the final round while the
        # creator's stated ask ($650) is over ceiling — coercing this to a close
        # would still fabricate an agreement the creator rejected → ESCALATE.
        '{"action": "COUNTER", "rate": 490, "response": "Can we do $490?", "reasoning": "meet in the middle"}',
    ],
)
def test_case_19_above_ceiling_final_round_escalates(monkeypatch, model_output):
    # CRITICAL-4 / HARD-T1: on the FINAL round, with the creator's firm ask above
    # the ceiling, the guard layer must ESCALATE rather than fold — whether the
    # model tried to ACCEPT over ceiling or COUNTER (which would otherwise be
    # coerced to a close). No acceptance/counter email ships; proposedTerms is None.
    _patch_llm(monkeypatch, [model_output])
    resp = neg_mod._langgraph_negotiate(_req(**_CASE_19))
    assert resp.action == "ESCALATE", f"expected ESCALATE, got {resp.action}"
    assert resp.proposedTerms is None
    # A pre-guard acceptance/counter draft must never be shipped as the outgoing
    # email when the guard changed the decision (HARD-N1 §4).
    assert resp.responseDraft is None


def test_case_19_deterministic_guard_direct():
    # Same invariant asserted directly on the pure guard, no model at all: an
    # over-ceiling creator ask on the final round → ESCALATE.
    from app.routes.negotiate import _apply_decision_guards

    guarded = _apply_decision_guards(
        "ACCEPT",
        650.0,
        floor_rate=200.0,
        ceiling_rate=500.0,
        is_final_round=True,
        creator_ask=650.0,
    )
    assert guarded.action == "ESCALATE"
    assert guarded.proposed_rate is None


# ---------------------------------------------------------------------------
# Other load-bearing guard invariants (offline, deterministic)
# ---------------------------------------------------------------------------


def test_over_ceiling_accept_escalates(monkeypatch):
    # Case 04/05 family: an ACCEPT above the ceiling is never auto-committed.
    _patch_llm(
        monkeypatch,
        ['{"action": "ACCEPT", "rate": 900, "response": "Deal at $900!", "reasoning": "eager"}'],
    )
    resp = neg_mod._langgraph_negotiate(
        _req(
            "My flat rate is $900.",
            round_=1,
            max_rounds=4,
            current_offer=350,
            history=[_H(0, "PRESENT_OFFER", 350)],
        )
    )
    assert resp.action == "ESCALATE"
    assert resp.proposedTerms is None


def test_below_floor_ask_closes_at_floor(monkeypatch):
    # Case 06 family: the creator ASKS below our floor ("$20", floor 200). We never
    # counter a below-floor ask UPWARD toward our standing offer (that hands them
    # more than they asked); the anti-over-pay guard closes at the floor. The
    # re-draft seam blanks the pre-guard email.
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": 20, "response": "How about $20?", "reasoning": "lowball"}'],
    )
    resp = neg_mod._langgraph_negotiate(
        _req(
            "I'd do it for $20.",
            round_=1,
            max_rounds=4,
            current_offer=300,
            history=[_H(0, "PRESENT_OFFER", 300)],
        )
    )
    assert resp.action == "ACCEPT"  # below-floor ask → close at floor, don't counter up
    assert resp.proposedTerms == {"rate": 200.0}  # the floor
    assert resp.responseDraft is None  # "$20" contradicts the clamped $200


def test_unreadable_rate_on_counter_escalates(monkeypatch):
    # Rate-bearing action with an unreadable/absent number → ESCALATE (never invent).
    _patch_llm(
        monkeypatch,
        ['{"action": "COUNTER", "rate": null, "response": "Let us discuss.", "reasoning": "no number"}'],
    )
    resp = neg_mod._langgraph_negotiate(
        _req(
            "Let's talk more.",
            round_=1,
            max_rounds=4,
            current_offer=300,
            history=[_H(0, "PRESENT_OFFER", 300)],
        )
    )
    assert resp.action == "ESCALATE"
    assert resp.proposedTerms is None


# ---------------------------------------------------------------------------
# Coverage tripwire: the live-eval matrix (run_eval.py) asserts EVERY case
# ---------------------------------------------------------------------------
# HARD-T1's headline requirement is that ALL eval cases are machine-asserted, not
# just a hand-picked few. This guards the run_eval.py ASSERTS dict against
# silently regressing to a partial-coverage set, and pins Case-19 to ESCALATE.


def _load_run_eval():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).parent / "negotiation_eval" / "run_eval.py"
    spec = importlib.util.spec_from_file_location("negotiation_run_eval", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # safe: main() is guarded by __name__
    return mod


def test_every_eval_case_is_machine_asserted():
    mod = _load_run_eval()
    case_ids = {c["id"] for c in mod.CASES}
    asserted = set(mod.ASSERTS)
    missing = case_ids - asserted
    assert not missing, f"eval cases with no machine assertion: {sorted(missing)}"
    # And no dangling assertion for a case that no longer exists.
    orphan = asserted - case_ids
    assert not orphan, f"ASSERTS entries for unknown cases: {sorted(orphan)}"


def test_case_19_asserts_escalate_only():
    mod = _load_run_eval()
    checks = mod.ASSERTS["19-above-ceiling-final-round"]
    action_checks = [c["action"] for c in checks if "action" in c]
    assert action_checks, "case 19 must assert an action"
    # CRITICAL-4: the only allowed action for case 19 is ESCALATE.
    assert all(a == {"ESCALATE"} for a in action_checks), (
        f"case 19 must be ESCALATE-only, got {action_checks}"
    )
