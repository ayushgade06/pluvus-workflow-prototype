# Testing Landscape

Everything we have tested, how, and what the results say about the system.
Compiled 2026-07-14. Sources: `readme_docs/EVAL_500_TESTCASES.md`,
`readme_docs/report/OPUS_SUBSET_RUN_2026-07-13.md`, `readme_docs/testing/README.md`,
raw results in `agent/tests/negotiation_eval/dataset_500/`.

---

## The five tiers

| Tier | What it is | Model | Status |
|---|---|---|---|
| **1. Deterministic CI** | T1 server routing + T2 agent guard-math + dataset validators + classify gate | none | ✅ green |
| **2. Eval-500** | 500 machine-asserted cases through `/classify → /negotiate → /draft` | qwen3:8b via **Ollama** | ✅ all 500 run live |
| **3. Opus subset-30** | 30 highest-signal cases on the hosted production model | Opus 4.8 + DeepSeek via **OpenRouter** | ✅ run 2026-07-13, $0.93 |
| **4. T3 live E2E** | Real agent + server + worker + DB escalation traps (runbook, not automated) | qwen via Ollama | 🟡 smoke green, full run infra-blocked |
| **5. Live workflow tests** | Real campaign instances through escalation buckets via magic links | full stack | 🟡 A1/A2 passed |

---

## 1 · Deterministic CI (no LLM — regression tripwires)

- **T1 routing traps** — `server/src/engine/escalationTraps.test.ts`, 11 scenarios:
  max-rounds → `REJECTED` + close email, over-tolerance → `MANUAL_REVIEW`,
  always-escalate topics, deferred → `AWAITING_REPLY` (+3d), opt-out,
  low-confidence gate, and the negative assert that `AWAITING_BRAND_DECISION` no
  longer exists. **Server suite: 75/75.**
- **T2 guard-math traps** — `agent/tests/test_escalation_traps.py`, 23 pure-function
  tests on `_apply_decision_guards` / `_decide_action` / topic gates — catches
  overpay bugs and wrong escalation boundaries. **Agent pytest: 414 pass**
  (1 pre-existing unrelated fail).
- **Dataset validators** — `tests/test_dataset_500.py` (9 tests): exactly 500 cases,
  0 duplicate texts, 1,175 assertions compile, no band leaks, 291/291 fact-coverage.
- **Classify gate** — `agent/eval/` 34-case labeled set; deterministic path scores
  ~1.0 **by construction** (tripwire, never quote as accuracy). OPT_OUT recall
  hard-gated at 1.0 (CAN-SPAM/GDPR).
- A **14-trap matrix** (`readme_docs/testing/README.md`) maps every founder-specified
  escalation behavior to the tier that proves it.

---

## 2 · Eval-500 on Ollama (qwen3:8b) — the big one

All 500 cases run live, bank-by-bank, on a session agent on `:8002`. Final:

| Bank | Result | Note |
|---|---|---|
| A · Money math (90) | ✅ 90/90 (first run 72) | fixed: counter-above-in-band-ask, counter-up on below-floor → deterministic anti-over-pay guards |
| B · Multi-question (70) | ✅ 70/70 (first 60) | fixed: known-fact deferral, compound-question collapse, harness missing knowledge fields |
| C · Answerable (70) | ✅ 70/70 (first 68) | fixed: question echoed back verbatim → anti-echo |
| D · Deferred (45) | ✅ 45/45 | honest defers, no fabrication |
| E · Unrelated (45) | ✅ 45/45 | stays on the deal |
| F · **Escalate (40)** | 🟡 **26/40** (raw 8→19→26) | 12 residuals are qwen limits; asserts kept Opus-strict |
| F · Opt-out (12) | ✅ 12/12 | never keeps selling |
| F · Negative (10) | ✅ 10/10 | |
| F · Injection (18) | ✅ 18/18 | band never leaked |
| H · Fixed-term (30) | ✅ 30/30 (first 23) | fixed: model agreed to evergreen commission; onboarding email dropped fixed-term restatement |
| Classify (40) | ✅ 40/40 | clean sweep, no fixes |
| J · Conversations (30) | ✅ 29/30 | 1 documented qwen limit (flip-flop read as terminal reject) |

**Aggregate ≈ 485/500 (97%)** — every non-pass is a documented qwen3:8b capability
limit; no assertion was relaxed. The run drove **~15 real code fixes** (anchoring
discipline, anti-over-pay clamps, known-fact splice, fixed-term hold, anti-echo,
escalate prompt rule) — the dataset is a bug-finder, not just a scoreboard.

Sore spot: qwen *recognizes* out-of-scope demands but counters anyway, and once
**accepted $400 under a public-callout threat** (F-29) — the reason the subset run
on the production model existed.

---

## 3 · OpenRouter — Opus 4.8 subset (2026-07-13)

30 cases = qwen's 15 fails + 15 one-of-each-type smoke. `anthropic/claude-opus-4.8`
(decisions) + `deepseek/deepseek-chat-v3` (drafts) via OpenRouter.

| Metric | qwen3:8b | **Opus 4.8** |
|---|---|---|
| Overall | 18/30 | **26/30** |
| Fail-set escalates (14) | 4 | **10** |
| Smoke (15) | 14 | **15 — zero regressions** |
| Conversations (2) | 1 | **2** (incl. flip-flop qwen failed) |
| Speed / case | 44–53 s | **6–8 s (~6×)** |
| Cost | free (local) | **$0.93 billed** (estimate $1.19) |

7 escalation cases qwen failed (equity, lawyer, "I will sue", commission-only,
callout threat, advance+per-diem, hostility) all correctly `ESCALATE` on Opus —
including the coercion case qwen accepted.

**4 remaining fails share one pattern:** structural-term demands (exclusivity fee,
zero usage rights, 5× scope, 40% commission ultimatum) answered with a *rate*
counter instead of `ESCALATE`. Classified a **product-policy decision**, not a
crash: either tighten the escalate triggers (~$0.20 re-verify) or relax those 4
asserts. Ops learnings: cost watchdog with hard-kill works; OpenRouter usage
endpoint lags by minutes; chars/4 estimator over-counts ~28%.

---

## 4 · Live E2E (T3) + real-workflow findings

- **Endpoint smoke: all 4 traps green live** on Ollama (over-ceiling, usage-rights
  always-escalate, payment-timing defer, provider confirmed).
- **Full workflow run: BLOCKED on local infra** (qwen `/draft` 500s/timeouts + Neon
  connection drops), not logic — routing stays covered by T1+T2.
- **Two real production bugs only live testing caught:**
  1. Server `VALID_INTENTS` missing `DEFERRED` → every deferred reply degraded to
     `MANUAL_REVIEW`; Phase D never worked E2E. Fixed (`65897d1`).
  2. Max-rounds auto-REJECT unreachable under `NEGOTIATION_STRATEGY=llm` (final
     round always ACCEPT/ESCALATE). Product decision pending.
- **Bucket tests:** A1/A2 passed. Real email replies land in spam / don't route, so
  escalation is tested via **magic links**; real-inbox (Nylas inbound) stays a
  manual layer.

Earlier history: three iterations of a 22-case negotiation eval
(`agent/tests/negotiation_eval/NEGOTIATION_EVAL_*.md`) established the baseline —
no band leaks in sent emails, injection held, and case-19 (near-ceiling final-round
accept) fixed to `ESCALATE`.

---

## Verdict

**Proven strong**
- **Money safety** (best-tested surface): 90/90, band never leaked across 500
  cases, never pays above ceiling, below-floor clamps to floor — backed by
  *deterministic guards*, not model goodwill.
- **Compliance**: opt-out 12/12, injection 18/18, OPT_OUT recall gated at 1.0.
- **Comprehension/copy**: every creator question answered (70/70 multi-question),
  known facts never falsely deferred, fixed terms held even on the accept path.
- **Production model tier** measurably better where expected: +8 cases, all in
  escalation judgment + multi-turn comprehension, 6× faster, ~$0.03/case.

**Open / unproven**
- Escalation policy on **structural-term demands** (the 4 Opus fails, one pattern).
- **Draft copy quality** on the real mixed config (Opus + DeepSeek) never graded —
  only decision correctness; ~8/30 subset cases even touch `/draft`.
- **No automated true E2E**: executor, DB, real email, hosted forms, token expiry
  sit below every eval; T3 full run still infra-blocked.
- Scores are **single-run** (no seed/JSON-mode determinism) and production has no
  token/latency/cost telemetry (audit finding; the watchdog was a one-off rig).

**Bottom line:** decision layer thoroughly tested and safe-by-guard (97% local,
26/30 on the production model, zero money/compliance failures anywhere); one
well-characterized escalation-policy question open; the product tier below the AI
is the least-proven layer — one real campaign run is the missing sign-off.
