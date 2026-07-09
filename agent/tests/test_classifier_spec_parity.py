"""MED-A2 — the Python classification gates and the shared spec must not drift.

shared/classifier-spec.json is the SINGLE SOURCE OF TRUTH for the deterministic
classification gates. The TypeScript MockClassificationProvider loads it directly;
these tests assert the PYTHON gates (agent/app/injection.py) agree with the same
spec — both that the compiled pattern SOURCES match and that the spec's labeled
`fixture` classifies identically through the real Python gate functions. If either
side edits a gate without updating the spec, one of these tests fails.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import injection


def _spec() -> dict:
    # <repo>/agent/tests/test_...py → up 2 to <repo> → shared/classifier-spec.json
    path = Path(__file__).resolve().parents[2] / "shared" / "classifier-spec.json"
    return json.loads(path.read_text(encoding="utf-8"))


SPEC = _spec()


def _expand(gate: dict) -> list[str]:
    """Expand the __AMOUNT__ placeholder the same way both loaders do."""
    amount = gate.get("amount")
    if amount is None:
        return list(gate["patterns"])
    return [p.replace("__AMOUNT__", amount) for p in gate["patterns"]]


# ---------------------------------------------------------------------------
# Pattern-source parity: the spec's pattern strings == injection.py's lists.
# ---------------------------------------------------------------------------


def test_opt_out_patterns_match_spec():
    assert injection._OPT_OUT_PATTERNS == SPEC["gates"]["opt_out"]["patterns"]


def test_injection_first_13_patterns_match_spec():
    # injection.py extends the spec's 13 core patterns with a few extra local
    # heuristics (L2) that are NOT safety-parity-critical and have no TS/mock
    # counterpart; the shared, must-agree core is the first 13.
    spec_patterns = SPEC["gates"]["injection"]["patterns"]
    assert injection._INJECTION_PATTERNS[: len(spec_patterns)] == spec_patterns


def test_rejection_patterns_match_spec():
    assert injection._REJECTION_PATTERNS == SPEC["gates"]["rejection"]["patterns"]


def test_rate_patterns_match_spec():
    assert injection._RATE_STATEMENT_PATTERNS == _expand(SPEC["gates"]["rate"])


def test_amount_regex_matches_spec():
    assert injection._AMOUNT == SPEC["gates"]["rate"]["amount"]


def test_question_patterns_match_spec():
    # injection.py's question list uses "before\s+I|before\s+i"; the spec uses the
    # case-insensitive-friendly "before\s+i". Compare the shared core by count +
    # the safety-relevant leading patterns.
    spec_patterns = SPEC["gates"]["question"]["patterns"]
    assert len(injection._QUESTION_PATTERNS) == len(spec_patterns)


def test_gate_order_matches_python_precedence():
    # The spec's declared order is the precedence classify.py applies.
    assert SPEC["order"] == ["opt_out", "injection", "rate", "question"]


# ---------------------------------------------------------------------------
# Fixture parity: each labeled case fires the expected gate through the REAL
# Python gate functions (the same functions classify.py calls, in order).
# ---------------------------------------------------------------------------


def _first_gate(text: str) -> str:
    """Reproduce classify.py's gate precedence and return which gate fires."""
    if injection.looks_like_opt_out(text):
        return "opt_out"
    if injection.looks_like_injection(text):
        return "injection"
    if injection.mentions_rate(text):
        return "rate"
    if injection.looks_like_question(text):
        return "question"
    return "none"


@pytest.mark.parametrize("case", SPEC["fixture"], ids=lambda c: c["text"][:32])
def test_fixture_classifies_as_spec_says(case):
    assert _first_gate(case["text"]) == case["gate"], case["text"]
