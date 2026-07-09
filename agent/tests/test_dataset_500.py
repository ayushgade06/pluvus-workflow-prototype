"""
CI guard for the 500-case eval dataset (HARD-T1).

Model-independent: it loads the dataset banks and asserts structural integrity
(count == 500, no duplicate texts, every case machine-asserted, regexes compile,
no band leaks in source, valid classify intents). It does NOT call the model —
running the cases against qwen is run_eval_500.py's job.
"""

from __future__ import annotations

import os
import re
import sys

import pytest

_DS = os.path.join(os.path.dirname(__file__), "negotiation_eval", "dataset_500")
sys.path.insert(0, _DS)


@pytest.fixture(scope="module")
def loader():
    import loader as _loader  # noqa: PLC0415
    return _loader


def test_total_is_exactly_500(loader):
    assert loader.TOTAL == 500
    assert loader.SINGLE_TURN == 430
    assert loader.CLASSIFY == 40
    assert loader.CONVOS == 30


def test_no_duplicate_ids(loader):
    ids = ([c["id"] for c in loader.CASES]
           + [c["id"] for c in loader.CLASSIFY_CASES]
           + [c["id"] for c in loader.CONVERSATIONS])
    assert len(ids) == len(set(ids)), "duplicate case ids"


def test_no_duplicate_reply_text(loader):
    texts = [c["reply"] for c in loader.CASES] + [c["message"] for c in loader.CLASSIFY_CASES]
    assert len(texts) == len(set(texts)), "duplicate reply/message text (a question type repeats)"


def test_every_single_turn_case_is_asserted(loader):
    for c in loader.CASES:
        assert c["id"] in loader.ASSERTS, f"{c['id']} has no machine assertions"
        assert loader.ASSERTS[c["id"]], f"{c['id']} has an empty assertion list"


def test_all_body_regexes_compile(loader):
    for cid, checks in loader.ASSERTS.items():
        for chk in checks:
            for pat in chk.get("body_has_all", []):
                re.compile(pat)  # raises on bad regex


def test_no_source_reply_leaks_both_bounds(loader):
    both = [c["id"] for c in loader.CASES
            if re.search(r"(?<!\d)200(?!\d)", c["reply"])
            and re.search(r"(?<!\d)500(?!\d)", c["reply"])]
    assert not both, f"replies stating both bounds: {both}"


def test_classify_intents_valid(loader):
    valid = {"POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN"}
    for c in loader.CLASSIFY_CASES:
        assert c["expect_intent"] in valid, f"{c['id']}: bad intent"


def test_conversations_well_formed(loader):
    for c in loader.CONVERSATIONS:
        assert len(c["turns"]) >= 2
        assert all(t.strip() for t in c["turns"])
        assert c["maxRounds"] >= 2


def test_offline_fact_coverage_has_no_gaps():
    """Every answerable/multi-question/fixed-term question topic must be backed by
    a fact that actually appears in the assembled /draft prompt — otherwise the
    model cannot answer it no matter how good it is. Model-independent (assembles
    the prompt via the real helpers, no network). Guards against a future edit
    dropping a knowledge field out of the prompt."""
    import audit_coverage  # noqa: PLC0415
    assert audit_coverage.audit() == 0, "a question topic has no backing fact in the draft prompt"
