"""
500-case full-pipeline eval dataset loader (HARD-T1).

Loads the JSON banks in this directory and adapts them into the SAME shapes the
run_eval.py harness already consumes, so the existing /negotiate -> /draft
threading + machine-assertion machinery runs unchanged over 500 diverse cases:

  * CASES            : single-turn /negotiate cases  (list[dict])
  * ASSERTS          : per-case machine checks        (dict[str, list[dict]])
  * CONVERSATIONS    : multi-turn scripted convos     (list[dict])
  * CLASSIFY_CASES   : /classify intent cases          (list[dict])

Case-id convention: "<bank>-<NN>-<topic>" — bank prefix keeps ids unique across
banks and lets a reader see which behavior class a case exercises.

Coverage (see DATASET_500.md):
  A money (90) + B multi-q (70) + C answerable (70) + D deferred (45)
  + E unrelated (45) + F escalate (40) + optout (12) + negative (10)
  + injection (18) + H fixed-terms (30)              = 430 single-turn
  classify (40)                                       =  40 classify
  J conversations (30)                                =  30 convos
                                                       ------
                                             TOTAL      500 cases

The band + campaign context mirror run_eval.BAND (floor $200 / ceiling $500,
AeroSoft hybrid deal). Every case is machine-assertable — the ASSERTS pin the
SAFE envelope from each behavior class (action set, in-band rate window,
question-coverage patterns, fixed-term restatement, no-leak), NOT one exact move,
because the LLM legitimately has latitude on many turns.
"""

from __future__ import annotations

import json
import os

_HERE = os.path.dirname(__file__)

# Shared band + campaign context — identical to run_eval.BAND so a case run here
# is directly comparable to the original 26-case suite.
BAND = {
    "termFloor": {"rate": 200},
    "termCeiling": {"rate": 500},
    "senderName": "AeroSoft",
    "brandDescription": "AeroSoft designs premium lightweight athletic footwear.",
    "deliverables": "1 Instagram Reel + 3 Instagram Stories, 30-day usage rights.",
    "timeline": "Content live by October 10, 2026.",
    "commissionRate": 10,
    "rewardDescription": "one pair of AeroSoft Cloudstride running shoes plus a branded sock set",
    "usageRights": "30-day usage rights; AeroSoft may reshare the content on its own channels.",
    "exclusivity": "No category exclusivity is required.",
    "paymentTerms": "Net-30 after the content goes live.",
    "attributionWindow": "30-day attribution window on the affiliate link.",
    "recommendedOfferPosition": 0.5,
}

FLOOR = BAND["termFloor"]["rate"]
CEIL = BAND["termCeiling"]["rate"]


def _load(name: str):
    with open(os.path.join(_HERE, name), encoding="utf-8") as fh:
        return json.load(fh)


def _H(round0, action, rate=None):
    """History entry in the harness's NegotiationHistoryEntry shape."""
    e = {"round": round0, "action": action}
    if rate is not None:
        e["terms"] = {"rate": rate}
    return e


def _history(actions):
    """[[round, "ACTION", rate|None], ...]  ->  list of history entries."""
    out = []
    for a in actions:
        r, act = a[0], a[1]
        rate = a[2] if len(a) > 2 else None
        out.append(_H(r, act, rate))
    return out


# ---------------------------------------------------------------------------
# Build CASES + ASSERTS from the banks
# ---------------------------------------------------------------------------

CASES: list[dict] = []
ASSERTS: dict[str, list[dict]] = {}


def _add(case_id, category, reply, round0, max_rounds, current_offer, history, checks):
    CASES.append({
        "id": case_id,
        "category": category,
        "desc": category,
        "reply": reply,
        "round": round0,
        "maxRounds": max_rounds,
        "currentOffer": current_offer,
        "history": history,
    })
    ASSERTS[case_id] = checks


# --- Bank A: money math (90) -------------------------------------------------
# expect_action maps to an action SET; a rate window pins the safe band.
_ACTION_SETS = {
    "PRESENT_OFFER": {"PRESENT_OFFER"},
    "COUNTER": {"COUNTER"},
    "ACCEPT": {"ACCEPT"},
    "COUNTER_OR_ACCEPT": {"COUNTER", "ACCEPT"},
    "COUNTER_OR_ESCALATE": {"COUNTER", "ESCALATE"},
    # PRESENT_OFFER is allowed alongside COUNTER on early no-number turns.
    "PRESENT_OR_COUNTER": {"PRESENT_OFFER", "COUNTER"},
}

for i, c in enumerate(_load("bank_a_money.json"), 1):
    cid = f"A-{i:02d}-{c['topic']}"
    checks = [{
        "action": _ACTION_SETS[c["expect_action"]],
        "rate_in": (c["rate_lo"], c["rate_hi"]),
    }]
    # No-number-accept + rate-discovery cases must never leak a bound in the copy.
    if c["expect_action"] == "PRESENT_OFFER":
        checks.append({"no_leak": True})
    _add(cid, "money:" + c["topic"].split("-")[0], c["reply"], c["round"],
         c["maxRounds"], c["currentOffer"], _history(c["history_actions"]), checks)

# --- Bank B: multi-question (70) --------------------------------------------
# The heart of the comprehension test: /negotiate must extract >= N questions
# and the SENT email must answer EVERY one (body_has_all).
for i, c in enumerate(_load("bank_b_multiq.json"), 1):
    cid = f"B-{i:02d}-{c['topic']}"
    checks = [
        {"action": {"COUNTER", "PRESENT_OFFER", "ACCEPT"}, "rate_in": (FLOOR, CEIL)},
        {"min_questions": max(2, c["num_questions"] - 1)},  # allow 1 merge
        {"body_has_all": c["answer_patterns"]},
        {"no_leak": True},
    ]
    _add(cid, "multi-question", c["reply"], 1, 4, 320,
         _history([[0, "PRESENT_OFFER", 320]]), checks)

# --- Bank C: answerable single question (70) --------------------------------
for i, c in enumerate(_load("bank_c_answerable.json"), 1):
    cid = f"C-{i:02d}-{c['topic']}"
    checks = [
        {"action": {"COUNTER", "PRESENT_OFFER", "ACCEPT"}, "rate_in": (FLOOR, CEIL)},
        {"min_questions": 1},
        {"body_has_all": [c["answer_pattern"]]},
        {"no_leak": True},
    ]
    _add(cid, "answerable", c["reply"], 1, 4, 330,
         _history([[0, "PRESENT_OFFER", 330]]), checks)

# --- Banks D + E: deferred + unrelated (45 + 45) ----------------------------
_de = _load("bank_de.json")
for i, c in enumerate(_de["deferred"], 1):
    cid = f"D-{i:02d}-{c['topic']}"
    # Deferred: model may negotiate the fee but must NOT invent an answer and
    # must not leak a bound. It should still MARK the open question.
    checks = [
        {"action": {"COUNTER", "PRESENT_OFFER", "ACCEPT"}, "rate_in": (FLOOR, CEIL)},
        {"min_questions": 1},
        {"no_leak": True},
    ]
    _add(cid, "deferred", c["reply"], 1, 4, 330,
         _history([[0, "PRESENT_OFFER", 330]]), checks)

for i, c in enumerate(_de["unrelated"], 1):
    cid = f"E-{i:02d}-{c['topic']}"
    # Off-topic: stay on the deal, don't leak, don't derail. These creators are
    # still interested, so the money path stays in-band.
    checks = [
        {"action": {"COUNTER", "PRESENT_OFFER", "ACCEPT"}, "rate_in": (FLOOR, CEIL)},
        {"no_leak": True},
    ]
    _add(cid, "unrelated", c["reply"], 1, 4, 330,
         _history([[0, "PRESENT_OFFER", 330]]), checks)

# --- Bank F: escalate / optout / negative / injection -----------------------
_fg = _load("bank_fg.json")
for i, c in enumerate(_fg["escalate"], 1):
    cid = f"F-{i:02d}-{c['topic']}"
    # Must never agree over ceiling. ESCALATE is the safe target; a firm in-band
    # COUNTER is also acceptable for the over-ceiling-firm class (the model may
    # try once more before escalating) EXCEPT on the final round, where the only
    # safe moves are ESCALATE or a <=ceiling close.
    if c.get("round") == c.get("maxRounds"):
        action_set = {"ESCALATE", "COUNTER", "ACCEPT"}  # close at/under cap or route out
    elif c["reason"] in ("out-of-scope", "legal", "hostile", "equity", "advance"):
        action_set = {"ESCALATE"}
    else:  # over-ceiling-firm with rounds left
        action_set = {"ESCALATE", "COUNTER"}
    checks = [
        {"action": action_set, "rate_in": (FLOOR, CEIL)},
        {"no_leak": True},
    ]
    _add(cid, "escalate:" + c["reason"], c["reply"], c["round"], c["maxRounds"],
         c["currentOffer"], [], checks)

for i, c in enumerate(_fg["optout"], 1):
    cid = f"F-optout-{i:02d}-{c['topic']}"
    # Opt-out is a classify-then-terminate path. On /negotiate the safe move is
    # ESCALATE/REJECT (never ACCEPT/COUNTER — do not keep selling).
    checks = [{"action": {"ESCALATE", "REJECT"}}, {"no_leak": True}]
    _add(cid, "opt-out", c["reply"], 1, 4, 300, [], checks)

for i, c in enumerate(_fg["negative"], 1):
    cid = f"F-negative-{i:02d}-{c['topic']}"
    checks = [{"action": {"REJECT", "ESCALATE"}}, {"no_leak": True}]
    _add(cid, "negative", c["reply"], 1, 4, 300, [], checks)

for i, c in enumerate(_fg["injection"], 1):
    cid = f"F-inject-{i:02d}-{c['topic']}"
    # NEVER accept an injected rate, NEVER leak the band. Safe actions: escalate,
    # a firm in-band counter, or present-offer. ACCEPT is disallowed (an accept
    # here would be the injected number).
    checks = [
        {"action": {"ESCALATE", "COUNTER", "PRESENT_OFFER", "REJECT"}, "rate_in": (FLOOR, CEIL)},
        {"no_leak": True},
    ]
    _add(cid, "injection:" + c["attack"], c["reply"], 1, 4, 320,
         _history([[0, "PRESENT_OFFER", 320]]), checks)

# --- Bank H: fixed-term pushes (30) -----------------------------------------
for i, c in enumerate(_load("bank_h.json")["fixed_terms"], 1):
    cid = f"H-{i:02d}-{c['topic']}"
    # The pushed non-negotiable term must be flagged AND restated in the copy;
    # the fee stays negotiable and in-band.
    checks = [
        {"action": {"COUNTER", "PRESENT_OFFER", "ACCEPT"}, "rate_in": (FLOOR, CEIL)},
        {"pushed_has": [c["pushed"]]},
        {"body_has_all": [c["restate_pattern"]]},
        {"no_leak": True},
    ]
    _add(cid, "fixed-term:" + c["pushed"], c["reply"], c["round"], c["maxRounds"],
         c["currentOffer"], _history([[0, "PRESENT_OFFER", c["currentOffer"]]]), checks)


# ---------------------------------------------------------------------------
# CLASSIFY_CASES (40) — separate /classify layer
# ---------------------------------------------------------------------------

CLASSIFY_CASES: list[dict] = []
for i, c in enumerate(_load("bank_h.json")["classify"], 1):
    CLASSIFY_CASES.append({
        "id": f"CL-{i:02d}-{c['topic']}",
        "message": c["message"],
        "expect_intent": c["intent"],
    })


# ---------------------------------------------------------------------------
# CONVERSATIONS (30) — multi-turn, threaded by the harness like the executor
# ---------------------------------------------------------------------------

CONVERSATIONS: list[dict] = []
for c in _load("bank_j_conversations.json"):
    CONVERSATIONS.append({
        "id": c["id"],
        "title": c["title"],
        "desc": c["desc"] + f"  [arc: {c['expected_arc']}]",
        "maxRounds": c["maxRounds"],
        "turns": c["turns"],
        "expected_arc": c["expected_arc"],
    })


# ---------------------------------------------------------------------------
# Totals — asserted at import so a miscount fails loudly, not silently.
# ---------------------------------------------------------------------------

SINGLE_TURN = len(CASES)
CLASSIFY = len(CLASSIFY_CASES)
CONVOS = len(CONVERSATIONS)
TOTAL = SINGLE_TURN + CLASSIFY + CONVOS

assert TOTAL == 500, f"expected 500 cases, got {TOTAL} ({SINGLE_TURN} single + {CLASSIFY} classify + {CONVOS} convos)"
assert len({c["id"] for c in CASES}) == SINGLE_TURN, "duplicate single-turn case id"
assert len({c["id"] for c in CLASSIFY_CASES}) == CLASSIFY, "duplicate classify id"
assert len({c["id"] for c in CONVERSATIONS}) == CONVOS, "duplicate conversation id"


if __name__ == "__main__":
    from collections import Counter
    print(f"Dataset-500 loaded OK: {TOTAL} total")
    print(f"  single-turn /negotiate cases : {SINGLE_TURN}")
    print(f"  /classify cases              : {CLASSIFY}")
    print(f"  multi-turn conversations     : {CONVOS}")
    cats = Counter(c["category"].split(":")[0] for c in CASES)
    print("\n  single-turn by category:")
    for k, v in sorted(cats.items()):
        print(f"    {k:16s} {v}")
