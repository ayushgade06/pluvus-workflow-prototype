"""
Eval runner / publisher (FIX-5).

Prints the classification accuracy report for the labeled eval set, so the
number is published and auditable rather than implicit in a test.

Usage (from agent/):
    python -m eval.run                 # deterministic reference path (no model)
    RUN_LLM_EVAL=1 python -m eval.run  # live LLM path (needs a model)

The deterministic path is what CI gates on (tests/test_eval_gate.py); this CLI
is for humans who want to see the table and the misses.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from eval.reference_classifier import reference_classify
from eval.scorer import load_dataset, score

DATASET = Path(__file__).parent / "dataset_v1.jsonl"


def main(argv: list[str]) -> int:
    cases = load_dataset(DATASET)

    if os.getenv("RUN_LLM_EVAL") == "1":
        from app.routes.classify import classify_message

        label = "LLM (classify_message)"
        pairs = [(c, classify_message(c.message).intent) for c in cases]
    else:
        label = "deterministic reference_classify"
        pairs = [(c, reference_classify(c.message)) for c in cases]

    report = score(pairs)
    print(f"\nDataset: {DATASET.name}  ({report.n} cases)")
    print(f"Classifier: {label}\n")
    print(report.format_table())
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
