"""Regression gate for the classification eval set (FIX-5).

IMPORTANT (C4): the always-on gate measures the DETERMINISTIC reference
classifier against a curated dataset — it scores ~1.000 by construction and is
NOT a measure of the LLM's real-world accuracy. It is a CODE-PATH REGRESSION
TRIPWIRE: reference_classify now calls the SAME production gate functions
(looks_like_opt_out, looks_like_injection, mentions_rate, looks_like_question)
in the same order as classify_message, so a break in any of those gates drops
the macro-F1 and fails the build. For a real MODEL-accuracy number, run the
opt-in LLM gate below.

Two layers:
  * Deterministic gate (always runs): scores reference_classify — which exercises
    the production OPT_OUT / injection / rate / question gates — and asserts
    macro-F1 and per-intent F1 thresholds. Measures the RULES, not the model.
  * LLM gate (opt-in): set RUN_LLM_EVAL=1 (with a model available) to run the
    SAME eval set through the live classify_message and score the actual model.
    Skipped by default so CI stays deterministic and offline.

The deterministic thresholds are intentionally strict (the rules should nail
this curated set); they are a tripwire, not an accuracy claim.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from eval.reference_classifier import reference_classify
from eval.scorer import INTENTS, load_dataset, score

DATASET = Path(__file__).parent.parent / "eval" / "dataset_v1.jsonl"

# Regression thresholds for the deterministic reference path on dataset_v1.
MIN_MACRO_F1 = 0.90
MIN_PER_INTENT_F1 = 0.80
# OPT_OUT is compliance-critical: it must be detected without misses.
MIN_OPT_OUT_RECALL = 1.0


@pytest.fixture(scope="module")
def report():
    cases = load_dataset(DATASET)
    pairs = [(c, reference_classify(c.message)) for c in cases]
    return score(pairs)


def test_dataset_loads_and_covers_all_intents():
    cases = load_dataset(DATASET)
    assert len(cases) >= 30
    covered = {c.expected for c in cases}
    assert covered == set(INTENTS), f"eval set must cover every intent; missing {set(INTENTS) - covered}"


def test_reference_classifier_macro_f1_regression(report):
    # Tripwire on the deterministic rule path (NOT model accuracy): a break in the
    # production gates reference_classify calls drops this macro-F1.
    assert report.macro_f1 >= MIN_MACRO_F1, (
        f"macro_f1 {report.macro_f1:.3f} < {MIN_MACRO_F1}\n{report.format_table()}"
    )


def test_reference_classifier_per_intent_f1_regression(report):
    weak = {
        intent: s.f1
        for intent, s in report.per_intent.items()
        if s.support > 0 and s.f1 < MIN_PER_INTENT_F1
    }
    assert not weak, f"intents below F1 {MIN_PER_INTENT_F1}: {weak}\n{report.format_table()}"


def test_opt_out_is_never_missed(report):
    # Compliance tripwire: an opt-out misclassified as anything else is a legal
    # risk, so OPT_OUT recall must be perfect on the labeled set.
    recall = report.per_intent["OPT_OUT"].recall
    assert recall >= MIN_OPT_OUT_RECALL, (
        f"OPT_OUT recall {recall:.3f} < {MIN_OPT_OUT_RECALL}\n{report.format_table()}"
    )


def test_reference_classifier_exercises_production_rate_and_question_gates():
    # C4: reference_classify must route through the SAME production gates as
    # classify_message, so a regression in mentions_rate / looks_like_question
    # trips the eval. Previously reference_classify re-implemented only opt-out +
    # injection and never exercised these two, leaving them untested in the gate.
    #   bare rate statement  → POSITIVE (via mentions_rate, production gate 3.5)
    #   product/deal question → QUESTION (via looks_like_question, gate 3.6)
    assert reference_classify("I charge $480") == "POSITIVE"
    assert reference_classify("my rate is 500 dollars") == "POSITIVE"
    assert reference_classify("what's the commission rate?") == "QUESTION"
    # A rejection that also names a price must NOT be forced POSITIVE (the rate
    # gate is suppressed by rejection language).
    assert reference_classify("no thanks, I'd need way more than $480") != "POSITIVE"


def test_injection_cases_do_not_flip_classification():
    # No injection-tagged case should be classified POSITIVE/NEGATIVE (a flipped
    # classification). They must land on UNKNOWN or, when also an opt-out, OPT_OUT.
    cases = load_dataset(DATASET)
    inj_cases = [c for c in cases if "injection" in c.tags]
    assert inj_cases, "eval set should contain injection-tagged cases"
    for c in inj_cases:
        pred = reference_classify(c.message)
        assert pred in ("UNKNOWN", "OPT_OUT"), f"injection case {c.id} classified as {pred}"


@pytest.mark.skipif(
    os.getenv("RUN_LLM_EVAL") != "1",
    reason="set RUN_LLM_EVAL=1 (with a model available) to run the live-LLM eval",
)
def test_llm_eval_meets_threshold():
    # Opt-in: runs the eval through the real production classify path.
    from app.routes.classify import classify_message

    cases = load_dataset(DATASET)
    pairs = [(c, classify_message(c.message).intent) for c in cases]
    report = score(pairs)
    print("\n[LLM eval]\n" + report.format_table())
    # The LLM threshold is looser than the deterministic one — a 7B model on real
    # replies will not be perfect, and the point is to TRACK the number.
    assert report.macro_f1 >= 0.70, report.format_table()
