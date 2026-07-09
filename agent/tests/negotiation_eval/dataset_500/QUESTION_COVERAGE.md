# Question Coverage — audit & fixes log

Tracks the work of making the system answer **every** creator question in the
500-case dataset properly. Two layers of audit:

1. **Offline fact audit** (`audit_coverage.py`, no model) — does the assembled
   `/draft` prompt even *contain* the fact needed to answer each question? If a
   fact is missing, the model cannot answer it — a definitive code/data gap.
2. **Live answer audit** (`audit_live.py`, real model) — running each case
   through the real `/negotiate → /draft`, does the sent email actually *answer*
   each question (the dataset `body_has_all` coverage checks)?

Every gap found is fixed in the code immediately and logged in the CHANGE LOG
below.

---

## Coverage scoreboard

| Question topic (section) | Source fact in code | Offline audit | Live answer audit | Status |
|--------------------------|---------------------|:-------------:|:-----------------:|--------|
| Usage rights             | `usageRights` field / ctx → `_knowledge_block` | ✅ present | _pending_ | DONE (offline) |
| Category exclusivity     | `exclusivity` field / ctx → `_knowledge_block` | ✅ present | _pending_ | DONE (offline) |
| Payment terms / schedule | `paymentTerms` field / ctx → `_knowledge_block` | ✅ present | _pending_ | DONE (offline) |
| Attribution / cookie win | `attributionWindow` field / ctx → `_knowledge_block` | ✅ present | _pending_ | DONE (offline) |
| Commission %             | `campaignContext.commissionRate` → commission bullet | ✅ present | _pending_ | DONE (offline) |
| Deliverables            | `deliverables` field / ctx → `_scope_lines` | ✅ present | _pending_ | DONE (offline) |
| Timeline / go-live       | `timeline` field / ctx → `_scope_lines` | ✅ present | _pending_ | DONE (offline) |
| Reward / product perk    | `rewardDescription` field / ctx → `_scope_lines` | ✅ present | _pending_ | DONE (offline) |
| Fee echo (creator's ask) | `proposedTerms` / `creatorRequestedRate` (executor-threaded) | ✅ present | _pending_ | DONE (offline) |

**Offline fact audit result:** `PASS — every classified question topic
(291 checks) is backed by a fact in the assembled prompt` — 9/9 topics, 0 gaps,
0 unclassified. See `audit_coverage.py` output.

**Question types (sections) covered:** 9 / 9
**Dataset question-checks backed by a real fact:** 291 / 291

---

## What "answering properly" requires (the mechanism)

The `/draft` route already has the full machinery — this audit confirms it and
tightens it where the live model reveals a gap:

- **Fact threading** — `_knowledge_block` (usage/exclusivity/payment/attribution),
  `_scope_lines` (deliverables/timeline/reward), the commission bullet, and the
  offer-rate line all fold the KNOWN campaign facts into the prompt so a question
  is answered from real data, never invented (HARD-K1).
- **Must-answer checklist** — `creatorQuestions` extracted by `/negotiate` are
  rendered as a numbered checklist the email MUST answer each of; earlier-round
  unanswered questions are re-surfaced via `openQuestions` (HARD-N2).
- **Post-draft verification + re-draft** — `_unanswered_questions` checks each
  required question is topically addressed (or honestly deferred); a silent drop
  triggers ONE reinforced re-draft (`_missed_questions_reinforcement`). Verified
  live to catch a dropped attribution question.
- **Honest defer** — when a fact is genuinely absent, the prompt instructs a
  one-sentence "we'll confirm together" rather than a fabricated answer. This is
  what the deferred-question bank (D, 45 cases) exercises.

---

## CHANGE LOG

_Code changes made in response to a found gap. Each entry: what failed, the fix,
and the file:line._

- _(none yet — offline fact audit found 0 gaps; live audit in progress. Fixes
  land here as live failures surface a genuinely unanswerable / mis-answered
  question type.)_

---

## How to reproduce

```
cd dataset_500
python audit_coverage.py                 # offline fact audit (instant)
python audit_live.py answerable          # live answer audit, bank C (70, ~40min)
python audit_live.py multi-question      # bank B (70)
python audit_live.py fixed-term          # bank H (30)
```
Results land in `audit_live_results.json`. The offline audit is also wired into
CI via `tests/test_dataset_500.py`.
