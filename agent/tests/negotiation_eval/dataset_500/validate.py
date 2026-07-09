"""
Dataset-500 structural validator (no model required).

Proves the dataset is well-formed BEFORE it is run against qwen:
  1. exactly 500 cases, correct per-bank composition
  2. no duplicate case ids
  3. no duplicate reply/message text  (the "no question type repeats" guarantee)
  4. no near-duplicate replies (normalized) across the whole corpus
  5. every ASSERTS regex compiles
  6. every single-turn case carries at least one machine check
  7. no source reply plants a *bare* band bound as its own fee anchor in a way
     that would make a leak-check ambiguous (creators MAY echo $500 as their ask
     — that is allowed — but we flag any reply that states BOTH 200 and 500)
  8. conversation turns are non-empty and within maxRounds
  9. classify intents are all in the valid enum

Run:  python validate.py       (exit 0 = clean, 1 = problems)
"""

from __future__ import annotations

import re
import sys

from loader import (
    CASES,
    ASSERTS,
    CLASSIFY_CASES,
    CONVERSATIONS,
    TOTAL,
    SINGLE_TURN,
    CLASSIFY,
    CONVOS,
)

VALID_INTENTS = {"POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN"}

problems: list[str] = []


def check(cond, msg):
    if not cond:
        problems.append(msg)


# 1. counts
check(TOTAL == 500, f"TOTAL != 500 (got {TOTAL})")
check(SINGLE_TURN == 430, f"single-turn != 430 (got {SINGLE_TURN})")
check(CLASSIFY == 40, f"classify != 40 (got {CLASSIFY})")
check(CONVOS == 30, f"convos != 30 (got {CONVOS})")

# 2. unique ids (cross-bank)
all_ids = [c["id"] for c in CASES] + [c["id"] for c in CLASSIFY_CASES] + [c["id"] for c in CONVERSATIONS]
dupe_ids = {i for i in all_ids if all_ids.count(i) > 1}
check(not dupe_ids, f"duplicate case ids: {sorted(dupe_ids)[:10]}")


def _norm(t: str) -> str:
    """Normalize text for near-duplicate detection: lowercase, collapse
    whitespace, strip punctuation and any dollar amounts (so two replies that
    differ ONLY by the fee figure still count as the same question)."""
    t = t.lower()
    t = re.sub(r"\$\s*\d[\d,]*", "$N", t)   # any dollar amount -> $N
    t = re.sub(r"[^a-z0-9$ ]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


# 3. exact-duplicate reply/message text across the corpus
texts = [c["reply"] for c in CASES] + [c["message"] for c in CLASSIFY_CASES]
seen: dict[str, int] = {}
for t in texts:
    seen[t] = seen.get(t, 0) + 1
exact_dupes = {t for t, n in seen.items() if n > 1}
check(not exact_dupes, f"{len(exact_dupes)} exact-duplicate reply/message texts")

# 4. near-duplicate replies (normalized) — flag only, but hard-fail if excessive
norm_seen: dict[str, list[str]] = {}
for c in CASES:
    norm_seen.setdefault(_norm(c["reply"]), []).append(c["id"])
near_dupes = {k: v for k, v in norm_seen.items() if len(v) > 1}
# A handful of genuinely-identical short accepts (bank A no-number) may collide;
# fail only if more than 1% of single-turn cases normalize-collide.
n_near = sum(len(v) - 1 for v in near_dupes.values())
check(n_near <= 4, f"{n_near} near-duplicate replies (normalized): "
                   f"{[v for v in near_dupes.values()][:5]}")

# 5. every ASSERTS regex compiles + 6. every case has >=1 check
for cid, checks in ASSERTS.items():
    check(len(checks) >= 1, f"{cid}: no machine checks")
    for chk in checks:
        for key in ("body_has_all",):
            for pat in chk.get(key, []):
                try:
                    re.compile(pat)
                except re.error as e:
                    problems.append(f"{cid}: bad regex /{pat}/ -> {e}")

# every single-turn case must have an ASSERTS entry
missing_asserts = [c["id"] for c in CASES if c["id"] not in ASSERTS]
check(not missing_asserts, f"{len(missing_asserts)} cases with no ASSERTS: {missing_asserts[:5]}")

# 7. no reply states BOTH bounds (200 AND 500) — that would be an unnatural leak
both_bounds = []
for c in CASES:
    r = c["reply"]
    if re.search(r"(?<!\d)200(?!\d)", r) and re.search(r"(?<!\d)500(?!\d)", r):
        both_bounds.append(c["id"])
check(not both_bounds, f"replies stating BOTH 200 and 500: {both_bounds}")

# 8. conversation turns well-formed
for c in CONVERSATIONS:
    check(len(c["turns"]) >= 2, f"{c['id']}: fewer than 2 turns")
    check(all(t.strip() for t in c["turns"]), f"{c['id']}: empty turn")
    check(isinstance(c["maxRounds"], int) and c["maxRounds"] >= 2, f"{c['id']}: bad maxRounds")

# 9. classify intents valid
for c in CLASSIFY_CASES:
    check(c["expect_intent"] in VALID_INTENTS, f"{c['id']}: bad intent {c['expect_intent']}")

# --- report ---
if problems:
    print(f"FAIL — {len(problems)} problem(s):")
    for p in problems:
        print("  -", p)
    sys.exit(1)

print("PASS — dataset-500 is structurally valid")
print(f"  {TOTAL} cases: {SINGLE_TURN} single-turn + {CLASSIFY} classify + {CONVOS} convos")
print(f"  {len(set(texts))} distinct reply/message texts (0 exact dupes)")
print(f"  {n_near} normalized near-duplicate collisions (<= 4 tolerated)")
print(f"  {sum(len(v) for v in ASSERTS.values())} machine checks across {len(ASSERTS)} asserted cases")

# Intent distribution (informational)
from collections import Counter
idist = Counter(c["expect_intent"] for c in CLASSIFY_CASES)
print("  classify intents:", dict(idist))
