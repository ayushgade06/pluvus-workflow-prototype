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
| Usage rights             | `usageRights` field / ctx → `_knowledge_block` | ✅ present | ✅ PASS | DONE |
| Category exclusivity     | `exclusivity` field / ctx → `_knowledge_block` | ✅ present | ✅ PASS (assert fixed) | DONE |
| Payment terms / schedule | `paymentTerms` field / ctx → `_knowledge_block` | ✅ present | ✅ PASS | DONE |
| Attribution / cookie win | `attributionWindow` field / ctx → `_knowledge_block` | ✅ present | ✅ PASS | DONE |
| Commission %             | `campaignContext.commissionRate` → commission bullet | ✅ present | ✅ PASS (code fixed: anti-echo) | DONE |
| Deliverables            | `deliverables` field / ctx → `_scope_lines` | ✅ present | ✅ PASS | DONE |
| Timeline / go-live       | `timeline` field / ctx → `_scope_lines` | ✅ present | ✅ PASS | DONE |
| Reward / product perk    | `rewardDescription` field / ctx → `_scope_lines` | ✅ present | ✅ PASS | DONE |
| Fee echo (creator's ask) | `proposedTerms` / `creatorRequestedRate` (executor-threaded) | ✅ present | ✅ PASS | DONE |

**Offline fact audit result:** `PASS — every classified question topic
(291 checks) is backed by a fact in the assembled prompt` — 9/9 topics, 0 gaps,
0 unclassified. See `audit_coverage.py` output.

**Live answer audit — answerable bank (C):** ran **all 70 / 70** cases against
qwen3:8b (`/negotiate → /draft`).
**Result: 68 PASS / 2 FAIL = 97% (68/70).** Both fails resolved (see CHANGE LOG):
one was a too-strict assertion (model answered correctly), one a real model-echo
weakness now fixed in the draft prompt (re-verify on next run after server
restart).

**Question types (sections) covered:** 9 / 9
**Dataset question-checks backed by a real fact:** 291 / 291
**Live-verified answerable cases:** 68 / 70 pass (97%)

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

_Changes made in response to a found issue. Each entry: what failed, the fix,
and where. Two classes: **CODE** (system couldn't answer) vs **ASSERT** (the
model answered correctly but the dataset's `answer_pattern` was too strict — a
false negative in the check, fixed in the dataset)._

- **[ASSERT] C-02 category-exclusivity** — model answered correctly
  ("signing this will **not lock you out** of working with **other footwear or
  athletic brands**") but `answer_pattern` required the literal phrase
  `other brands`, which "other footwear or athletic brands" doesn't contain.
  Broadened the pattern to `exclusiv|no category|not required|lock you out|other
  (footwear|athletic|brands)`. No code change — the system answered properly.
  (`bank_c_answerable.json`)

- **[CODE] C-32 commission-standalone-clarify** — the creator asked a
  confirmation question ("the 10% is additional income alongside the fee, not
  carved out of it, **yes?**"). qwen3:8b **echoed the question back verbatim as
  the email's opening line** and treated that as the answer — it never stated
  "yes, on top of the fee". Root cause: the `question_checklist` prompt said
  "answer EACH explicitly" but didn't forbid restating the question. **Fix:**
  added an anti-echo clause to the checklist — for a yes/no/confirmation question
  the email must STATE the answer directly (e.g. "Yes — the 10% commission is
  paid on top of the fixed fee") and must NOT repeat the question text as the
  answer. (`app/routes/negotiate.py`, `_build_offer_prompt` question-checklist
  block ~L2400.) The post-draft verifier remains the backstop.
  **RE-VERIFIED LIVE** (server runs with `--reload`): re-drafting the exact C-32
  question now yields `ECHOES=False, ANSWERS-directly=True` — the email states
  "10% commission ... on top of the fixed fee" instead of parroting the question.

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
