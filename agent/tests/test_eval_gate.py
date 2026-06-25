"""Accuracy gate for the classification eval set (FIX-5).

This is the CI gate the audit calls the headline missing item: a versioned
labeled set + a metric + a threshold that FAILS the build on regression.

Two layers:
  * Deterministic gate (always runs): scores the rule-based reference classifier
    — the real production fallback path, which also exercises the FIX-7 OPT_OUT
    and injection gates — and asserts macro-F1 and per-intent F1 thresholds.
  * LLM gate (opt-in): set RUN_LLM_EVAL=1 (with a model available) to run the
    SAME eval set through the live classify_message and print/score it. Skipped
    by default so CI stays deterministic and offline.

The thresholds are intentionally strict for the deterministic path (the rules
should nail this curated set) and serve as a regression tripwire: if a future
change breaks OPT_OUT detection, the injection gate, or keyword routing, the
macro-F1 drops and this test fails.
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


def test_macro_f1_meets_threshold(report):
    assert report.macro_f1 >= MIN_MACRO_F1, (
        f"macro_f1 {report.macro_f1:.3f} < {MIN_MACRO_F1}\n{report.format_table()}"
    )


def test_per_intent_f1_meets_threshold(report):
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
