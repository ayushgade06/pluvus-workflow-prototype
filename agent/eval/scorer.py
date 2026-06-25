"""
Classification accuracy scorer (FIX-5).

Pure, deterministic, no network. Given (expected, predicted) intent pairs it
computes the confusion matrix and per-intent precision / recall / F1 plus the
macro-averaged F1, so the eval can publish an accuracy number and a CI gate can
fail when it regresses.

This is the measurement the audit calls the "headline gap": before this there
was no labeled set and no accuracy metric anywhere in the repo, so no truthful
claim about classifier correctness was possible.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

INTENTS = ["POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN"]


@dataclass(frozen=True)
class EvalCase:
    id: str
    message: str
    expected: str
    tags: tuple[str, ...] = ()


def load_dataset(path: str | Path) -> list[EvalCase]:
    """Load a JSONL eval set into EvalCase rows, skipping blank lines."""
    cases: list[EvalCase] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if obj["expected"] not in INTENTS:
            raise ValueError(f"case {obj.get('id')!r} has unknown expected={obj['expected']!r}")
        cases.append(
            EvalCase(
                id=obj["id"],
                message=obj["message"],
                expected=obj["expected"],
                tags=tuple(obj.get("tags", [])),
            )
        )
    return cases


@dataclass
class IntentScore:
    intent: str
    precision: float
    recall: float
    f1: float
    support: int  # number of expected==intent cases


@dataclass
class ScoreReport:
    n: int
    accuracy: float
    macro_f1: float
    per_intent: dict[str, IntentScore]
    confusion: dict[str, dict[str, int]]
    misses: list[tuple[str, str, str]] = field(default_factory=list)  # (id, expected, predicted)

    def format_table(self) -> str:
        lines = [
            f"n={self.n}  accuracy={self.accuracy:.3f}  macro_f1={self.macro_f1:.3f}",
            f"{'intent':10} {'prec':>6} {'rec':>6} {'f1':>6} {'support':>8}",
        ]
        for intent in INTENTS:
            s = self.per_intent[intent]
            lines.append(
                f"{intent:10} {s.precision:6.3f} {s.recall:6.3f} {s.f1:6.3f} {s.support:8d}"
            )
        if self.misses:
            lines.append("misses:")
            for cid, exp, pred in self.misses:
                lines.append(f"  {cid}: expected {exp}, got {pred}")
        return "\n".join(lines)


def _safe_div(a: float, b: float) -> float:
    return a / b if b else 0.0


def score(pairs: list[tuple[EvalCase, str]]) -> ScoreReport:
    """Score a list of (case, predicted_intent) pairs.

    Returns a ScoreReport with accuracy, per-intent P/R/F1, macro-F1, the full
    confusion matrix, and the list of misses for debugging.
    """
    confusion: dict[str, dict[str, int]] = {e: {p: 0 for p in INTENTS} for e in INTENTS}
    correct = 0
    misses: list[tuple[str, str, str]] = []

    for case, pred in pairs:
        if pred not in INTENTS:
            pred = "UNKNOWN"  # any out-of-enum prediction counts as UNKNOWN
        confusion[case.expected][pred] += 1
        if pred == case.expected:
            correct += 1
        else:
            misses.append((case.id, case.expected, pred))

    per_intent: dict[str, IntentScore] = {}
    f1s: list[float] = []
    for intent in INTENTS:
        tp = confusion[intent][intent]
        fn = sum(confusion[intent][p] for p in INTENTS if p != intent)
        fp = sum(confusion[e][intent] for e in INTENTS if e != intent)
        support = tp + fn
        precision = _safe_div(tp, tp + fp)
        recall = _safe_div(tp, tp + fn)
        f1 = _safe_div(2 * precision * recall, precision + recall)
        per_intent[intent] = IntentScore(intent, precision, recall, f1, support)
        f1s.append(f1)

    n = len(pairs)
    return ScoreReport(
        n=n,
        accuracy=_safe_div(correct, n),
        macro_f1=_safe_div(sum(f1s), len(f1s)),
        per_intent=per_intent,
        confusion=confusion,
        misses=misses,
    )
