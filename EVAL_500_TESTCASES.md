# 500-Case Evaluation Dataset — Test Cases & Results

Full-pipeline test suite (`classify → negotiate → draft`) that exercises the AI
system the way a real creator would reply to a brand outreach email. **Exactly
500 cases**, every one machine-asserted. This is the dataset that closes the
HARD-T1 acceptance criterion ("every case machine-asserted, ≥500-case dataset").

- **Location:** `agent/tests/negotiation_eval/dataset_500/`
- **Runner:** `run_eval_500.py` (full) / `audit_live.py <category>` (per-bank)
- **Model under test:** qwen3:8b via Ollama (the system's brain); the dataset is
  the fixed *creator* side driving it.
- **Band/campaign:** AeroSoft hybrid deal — fixed fee negotiable in a hidden
  $200–$500 band, fixed 10% commission, 1 Reel + 3 Stories, live by Oct 10 2026,
  net-30, 30-day usage/attribution, no exclusivity, Cloudstride shoes + socks.

---

## Composition — all 500 cases

| # | Bank / section | Cases | What the creator does | Live status |
|---|----------------|------:|-----------------------|-------------|
| A | **Money math** | 90 | Rate discovery, in-band / at-ceiling / above-ceiling / below-floor asks, explicit accept, **no-number accept** (false-accept guard), mid-band counter | ⏳ not run live |
| B | **Multi-question** | 70 | 2–4 distinct questions in one reply; every one must be answered | 🟡 1/70 run — see findings |
| C | **Answerable** | 70 | One campaign question with a real answer | ✅ **68/70 PASS (97%)** |
| D | **Deferred** | 45 | Campaign question we can't answer yet → honest defer, no fabrication | ⏳ not run live |
| E | **Unrelated** | 45 | Off-topic question (career advice, other brands, chit-chat) → stay on the deal | ⏳ not run live |
| F | **Escalate** | 40 | Over-ceiling-firm, out-of-scope, legal, hostile, equity, advance, unbridgeable → route to human | ⏳ not run live |
| F | **Opt-out** | 12 | CAN-SPAM stop requests → never keep selling | ⏳ not run live |
| F | **Negative** | 10 | Genuine declines (not opt-out) | ⏳ not run live |
| F | **Injection** | 18 | Prompt-injection / band-leak / force-accept / impersonation → neutralized | ⏳ not run live |
| H | **Fixed-term** | 30 | Pushes on non-negotiable commission % or product perk → held + restated | ⏳ not run live |
| — | **Classify** | 40 | `/classify` intent routing (POSITIVE/NEGATIVE/QUESTION/OPT_OUT/UNKNOWN) | ⏳ not run live |
| — | **Conversations** | 30 | Full multi-turn arcs (converge, escalate, walk-away, opt-out midway, injection mid-convo, flip-flop, below-floor) | ⏳ not run live |
| | **TOTAL** | **500** | | |

`430 single-turn /negotiate→/draft + 40 /classify + 30 multi-turn = 500`

---

## Validation status (model-independent — always green)

These run with **no model** and gate CI (`tests/test_dataset_500.py`, 9 tests):

| Check | Result |
|-------|--------|
| Exactly 500 cases (430 + 40 + 30) | ✅ PASS |
| No duplicate case IDs | ✅ PASS |
| No duplicate reply/message text (no question type repeats) | ✅ PASS — 470 distinct texts, 0 exact dupes |
| No normalized near-duplicates | ✅ PASS — 0 collisions |
| Every single-turn case machine-asserted | ✅ PASS — 1,175 checks across 430 cases |
| All assertion regexes compile | ✅ PASS |
| No source reply leaks both band bounds | ✅ PASS |
| **Offline fact coverage** — every question topic backed by a fact in the draft prompt | ✅ PASS — 9/9 topics, 291/291 checks, 0 gaps |

**Run it:** `cd agent/tests/negotiation_eval/dataset_500 && python validate.py`

---

## Live results so far

### Answerable bank (C) — ✅ 68 / 70 PASS (97%)

All 70 cases run against qwen3:8b (`/negotiate → /draft`). The 9 answerable
question sections all verified — the model answers usage rights, payment terms,
commission %, deliverables, timeline, reward, attribution, exclusivity, and echoes
the creator's fee correctly.

**2 fails, both resolved:**

| Case | Class | Issue | Fix |
|------|-------|-------|-----|
| C-02 exclusivity | **ASSERT** (false negative) | Model answered correctly ("won't lock you out of other footwear/athletic brands") but the regex required literal "other brands" | Broadened the answer pattern — no code change |
| C-32 commission-additive | **CODE** (real) | Model **echoed the yes/no question back verbatim** instead of confirming "yes, 10% is on top of the fee" | Added anti-echo clause to the draft question-checklist (`app/routes/negotiate.py`) — verified fixed |

### Multi-question bank (B) — 🟡 1 / 70 run, 1 real finding

Only the first case ran before the audit was interrupted. It exposed a **real
code gap**:

| Case | Class | Issue | Fix |
|------|-------|-------|-----|
| B-01 usage + payment | **CODE** (real) | Creator asked two questions (usage + "when do I get paid"); the email answered usage but **deferred payment** ("we'll confirm timing later") even though net-30 is a KNOWN fact | Added a `_deferred_known_facts` post-draft verifier that detects a known fact was deferred and forces it into a re-draft with the actual value (`app/routes/negotiate.py`) — committed & unit-tested; **live re-verify pending a fresh server** |

---

## Fixes applied (code changes driven by the audit)

All committed on branch `refactor/production-hardening`:

1. **C-32 anti-echo** — the offer prompt's question checklist now requires a
   direct answer to yes/no/confirmation questions and forbids repeating the
   question text as the answer.
2. **B-01 known-fact-deferral guard** — the post-draft verifier now treats a
   deferral of a *known* campaign fact (payment/usage/exclusivity/attribution)
   as a miss and re-drafts with the exact value supplied. Deferring is only
   valid when we genuinely don't know the answer.
3. **C-02 assertion broadening** — dataset pattern fix (not a code gap).

Detailed per-fix log: `agent/tests/negotiation_eval/dataset_500/QUESTION_COVERAGE.md`.

---

## What's left to run live

- Multi-question bank (B): 69 remaining
- Fixed-term (H, 30), Deferred (D, 45), Unrelated (E, 45), Escalate/Opt-out/
  Negative/Injection (F, 80), Money (A, 90), Classify (40), Conversations (30)

**Blocker:** the running agent on :8001 serves stale code and is auto-respawned
by another Claude session; a fresh restart (loading the committed fixes) is
needed before the B-01/C-32 fixes can be re-verified live and the remaining banks
run cleanly. On local qwen3:8b a full 500-case run is long (~35s/case × 2 calls),
so banks are run one at a time.

**Run a bank live:**
```
cd agent/tests/negotiation_eval/dataset_500
python audit_live.py multi-question     # 70 cases
python audit_live.py fixed-term         # 30 cases
python watch.py                         # live monitor in another terminal
```
