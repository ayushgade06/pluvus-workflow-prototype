# HARD — Structural Redesigns

These are multi-file redesigns or require infrastructure/data that doesn't exist yet. They lift the
lowest-scoring areas (Prompts, Negotiation, Architecture, Scalability, Observability, Knowledge, Testing)
toward 8. Do these after the Criticals.

Naming: `HARD-N*` negotiation, `HARD-P*` prompts, `HARD-A*` architecture, `HARD-R*` reliability,
`HARD-K*` knowledge, `HARD-S*` scalability, `HARD-O*` observability, `HARD-T*` testing.

---

## [HARD-N1] Redesign the decision seam: LLM comprehends, code guards, ONE draft after guards

**Where**
- `agent/app/routes/negotiate.py:559-606` — `_apply_decision_guards` clamps only to `[floor, ceiling]`;
  takes no `prior_offer` or `creator_ask`.
- `agent/app/routes/negotiate.py:906` — `resp.responseDraft = parsed.response` stores the model's
  **pre-guard** email verbatim; when guards rewrite the action/rate, the email is not re-drafted.
- `agent/app/routes/negotiate.py:670-671` — the "never regress / never exceed ask" rule is prompt-only.
- `agent/app/routes/negotiate.py:337-345` — the rules path's `_decide_action` never receives `floor_rate`,
  so it can ACCEPT below floor while the LLM path clamps up (`negotiate.py:595`). Split invariant.

**Problem (this is the philosophy fix — read `PRINCIPLES.md` first)**
The drafted email and the recorded decision are produced separately and routinely disagree: guards change
`action`/`rate` but `responseDraft` still reads as the model's original move (e.g. email says "would $550
work?" while state says ACCEPT at $500). Anti-regression / anti-over-ask are unenforced, and the two
strategies disagree on the floor invariant.

**Fix** (per `PRINCIPLES.md`: hard money bounds are code-clamped; soft negotiation discipline stays in the
prompt — do NOT code-clamp it)
1. **Hard bounds (code):** keep the `[floor, ceiling]` enforcement in `_apply_decision_guards` — over
   ceiling → escalate, below floor → clamp up, unreadable/absent rate → escalate. These protect the brand
   from a bad/hostile decision.
2. **Soft discipline (prompt, NOT code):** "never regress below our prior offer" and "never offer above the
   creator's ask" are negotiation *tactics* the LLM owns. Strengthen them in the prompt
   (`negotiate.py:670-671`) and give the model `prior_offer` and the creator's ask in context so it can
   obey them. Do NOT add `max(rate, prior_offer)` / `min(rate, creator_ask)` clamps in code — that
   re-introduces the rule tree Project Deal argues against and fights the model's reasoning. (This reverses
   an earlier draft of this spec; see the note in `PRINCIPLES.md`.)
3. Pass `floor_rate` into `_decide_action` so the fallback path also clamps up below-floor accepts,
   unifying the floor invariant across the LLM path and its rules fallback.
4. **Never store a pre-guard `response` as the outgoing email (load-bearing).** When guards change action
   or rate, either (a) regenerate the email via `/draft` from the *guarded* decision, or (b) blank
   `responseDraft` so the executor is forced to draft. Treat `responseDraft` as advisory only. This is the
   seam where "code overrode the number" must not become "email states a different number than the deal."

**Verify**
- Test: model returns ACCEPT at $600 (over ceiling 500) → decision ESCALATE AND no acceptance email ships.
- Test: model returns a below-floor number → clamped up to floor AND the sent email states the floor number
  (re-drafted), never the model's original below-floor number.
- Test (soft, prompt-level): given `prior_offer` in context, the model does not counter below it — asserted
  as an eval expectation, not a code invariant.

**Blast radius**
`negotiate.py` guard signature + call sites (882), `_decide_action` signature (337), the executor's draft
flow (`server/src/engine/executors/negotiation.ts`), and the `/draft` contract. Largest single change;
dissolves CRITICAL-4, the draft/action divergence, and the below-floor accept at once.

---

## [HARD-N2] Thread negotiation history + creator's own messages into /draft

**Where**
- `agent/app/routes/negotiate.py:199-243` — `DraftRequest` has no history field; `/draft` gets only the
  latest reply + this turn's rate.
- `server/src/engine/executors/negotiationHistory.ts:46-83` — history stores only `{round, our-action,
  our-rate, our-sent-message}`; the creator's prior messages are never retained as context.

**Problem**
The copywriter model can contradict earlier emails (it can't see them), and "never repeat identical
wording across rounds" is unverifiable. The agent forgets the creator's own words and prior questions.

**Fix**
1. Retain creator inbound messages in the history model (or pass the last N creator+our turns).
2. Add a compact `history` field to `DraftRequest` and render it in the offer/onboarding prompts.
3. Add an "answered-questions ledger" so a question asked in round 1 and unanswered is re-surfaced.

**Blast radius**
History assembly, `DraftRequest` schema, offer/onboarding prompts, wire contract between engine and agent.

---

## [HARD-N3] Fix opening-offer anchoring ($0 offer bug)

**Where**
- `agent/app/routes/negotiate.py:1083-1091` — `recommendedOfferPosition` defaults to `0.0` = open at floor.
- `server/src/templates/index.ts:69` — affiliate template has `minBudget: 0`; with position 0.0 the
  recommended opening offer computes to **$0**.
- `server/src/templates/index.ts:66-75,133-143,202-211` — no template sets a position.
- `negotiation.md:386` — stale doc still claims "midpoint".

**Problem**
A bare "I'm interested" gets PRESENT_OFFER at $0 on the affiliate template.

**Fix**
1. Validate `floor > 0` when a fee exists; reject/repair `minBudget: 0` campaigns.
2. Set an explicit `recommendedOfferPosition` per template (e.g. 0.5 for band midpoint).
3. Update `negotiation.md` to match actual behavior.

**Blast radius**
Template definitions, band computation, campaign validation, one doc.

---

## [HARD-P1] Rearchitect `_NEGOTIATE_PROMPT` into a pure extraction module

**Where**
- `agent/app/routes/negotiate.py:922-1060` — the default rules-mode prompt is a "negotiator persona that
  also gets parsed": it embeds floor/ceiling (944-946) it never needs, instructs a strategy the code
  overrides (1016-1046 vs `_decide_action`'s stepping at 443-446), drafts copy that contradicts the
  computed action, and requests a dead `confidence` field (1055, read nowhere).

**Problem**
Systemic prompt-vs-code contradiction, needless secret exposure (~60-70% of the tokens are leak surface
and overridden strategy), and a generation that fights the deterministic decision.

**Fix**
Convert it to pure extraction — return only `intent`, `creatorRateMentioned`, `creatorQuestions`,
`pushedFixedTerms`. Remove floor/ceiling/recommended entirely, delete the Response Strategy / Counteroffer
/ Escalation sections and the `confidence` field. Move ALL copy to `/draft` (which already has the facts
and the checklist). Add a hard rule: `creatorRateMentioned` is only a number the creator literally wrote
as their fee; null for ranges ("400-500"), per-unit prices, followers, or percentages — never infer,
average, or convert. Pair with a code check that the extracted number's substring occurs in the reply.

A full sketch of the replacement prompt is in the audit; the key structure:
```
You are an information-extraction module. You do NOT decide the deal and do NOT write the reply.
Extract from the creator's latest message only. Return ONLY:
{"intent": "...", "creatorRateMentioned": <number|null>,
 "creatorQuestions": [...], "pushedFixedTerms": ["commission|perk|deliverables|timeline"]}
```

**Migration note**
`_rules_negotiate` currently returns `parsed.response` as `responseDraft` (`negotiate.py:1233`). After this
change the executor must always render the email via `/draft`, or keep a neutral placeholder in
`responseDraft`. This overlaps with HARD-N1's "always draft after guards".

**Blast radius**
The default (most-used) negotiation prompt, `_NegotiateLLMOutput` schema, `_rules_negotiate` return path,
the executor draft flow. Also fixes the leak surface counted in Security.

---

## [HARD-P2] Add "defer honestly on unknowns" to the LLM-mode prompt + few-shots

**Where**
- `agent/app/routes/negotiate.py:609-808` — `_LLM_NEGOTIATE_PROMPT` demands "address EACH question"
  (739-742) but, unlike `_OFFER_PROMPT` (1379-1401), never says what to do when the answer is unknown.
- No prompt anywhere has few-shot examples.

**Problem**
Payment schedule, usage rights, exclusivity are supplied nowhere in the context → the model hallucinates
answers by construction. A local 7-8B model at this instruction density also drops rules.

**Fix**
Add an explicit deferral clause ("if a fact isn't in Campaign Context, say it'll be confirmed — never
invent payment terms, usage rights, or exclusivity"). Add 2-3 few-shot examples to the extraction and
offer prompts for small-model stability. Add a `promptVersion` constant (see HARD-T2).

**Blast radius**
Prompt text, token budget (`num_predict` — see MED-L2).

---

## [HARD-A1] Split process topology (API / workers / scheduler)

**Where**
- `server/src/index.ts:104-105` — API + both workers + scheduler run in one process.

**Problem**
Cannot scale workers independently; N replicas = N schedulers/pollers. This is the prerequisite for
Scalability.

**Fix**
Make each a separately deployable entrypoint sharing the same code. Run the scheduler as a single leader
(lock or dedicated deployment), not per-replica.

**Blast radius**
Process bootstrap, deployment config, docker-compose.

---

## [HARD-A2] Collapse the dual legacy-vs-merged funnel + de-duplicate ladders

**Where**
- Legacy REWARD_SETUP/PAYMENT_INFO nodes vs merged CONTENT_BRIEF path — triples the conditional surface in
  `runtime.ts` dispatch, both workers' auto-chain ladders, and the state table.
- Duplicated logic: `blockedByGuard` (`negotiation.ts:25-38` vs `guardEscalation.ts:14-27`); `nextNodeAfter`
  (`paymentInfo.ts:64-68`, `rewardReply.ts:191-195`); auto-chain ladders
  (`nodeExecutionWorker.ts:117-198`, `inboundEmailWorker.ts:123-137,176-189`, `payment.ts:247-264`);
  brand-as-Creator send hack (`escalation.ts:240`, `brandDecision.ts:162`); rate-extraction regex
  triplicated (`negotiation.ts:100-126`, `MockNegotiationProvider.ts:78-82`, `MockClassificationProvider.ts:73-81`).

**Fix**
Pick one funnel (merged Content Brief) and delete the legacy path + its states. Extract the duplicated
helpers to single modules. Introduce a node registry so adding a node type is one entry, not 7 touch points
(`runtime.ts` dispatch + loadContext resolution + runUntilWaiting + both workers + state table + route).

**Blast radius**
Wide but mechanical; strongly improves Maintainability and Architecture scores.

---

## [HARD-R1] Reconciliation sweep for all non-terminal states + transactional outbox

**Where**
- `server/src/scheduler/poller.ts:19-72` + `server/src/db/instances.ts:120-130` — poller covers only
  `AWAITING_REPLY`/`FOLLOWED_UP`; 10 of 12 non-terminal states have no recovery.
- `server/src/routes/payment.ts:247-264` — best-effort catch: crash between OCC commit and follow-on
  enqueue strands ACCEPTED/REWARD_CONFIRMED/PAYMENT_RECEIVED/NEGOTIATING.

**Problem**
Any crash/Redis blip between committing a state and enqueuing the next job strands the instance invisibly.

**Fix**
1. Add a periodic stuck-state sweep that re-enqueues instances by `currentState` (with an age threshold).
2. Add a transactional outbox so state commit + enqueue are atomic (write the intended job to a DB table
   in the same transaction; a relay enqueues it).
3. Add an index on `(currentState, dueAt)` and a LIMIT to the poller's `findMany`.

**Blast radius**
Scheduler, DB schema (outbox table + index), enqueue call sites.

---

## [HARD-R2] Make the Redis lock sound (or lean fully on OCC)

**Where**
- `server/src/scheduler/lock.ts:14` — TTL 30s; a negotiation step can take 120s×3 draft retries
  (`agentServiceClient.ts:51`, `providerFactory.ts:350`).
- `server/src/scheduler/lock.ts:61-64` — `releaseLock` deletes unconditionally (can delete another
  holder's lock); no fencing token.

**Fix**
Token-checked release (only delete if you own it), TTL ≥ worst-case step or a lock heartbeat, and document
that OCC + `sendOnce` are the real correctness guarantee (the lock is an optimization). Interacts with
CRITICAL-6 (lock-busy handling).

**Blast radius**
Lock module, all lock acquire/release call sites.

---

## [HARD-K1] Add knowledge fields + parse the brief PDF + post-draft verification

**Where**
- `agent/app/routes/negotiate.py:85-107` (`CampaignConstraints`) and `199-243` (`DraftRequest`) — no fields
  for usage rights, exclusivity, payment terms/schedule, attribution window.
- `server/src/templates/index.ts:326-340` — the campaign brief PDF is an attachment only, never parsed.

**Fix**
1. Add the missing campaign fields and thread them to draft time.
2. Parse the brief PDF (or add a structured FAQ store) into LLM context.
3. Add a post-draft verification pass that confirms every `creatorQuestion` was answered or explicitly
   deferred — no silent drop.

**Blast radius**
Campaign schema, agent request schemas, prompts, a PDF parse step, a verification step in the executor.

---

## [HARD-S1] Scalability — worker fleet + load evidence *(cannot reach 8 by code alone)*

**Where**
- `server/src/workers/nodeExecutionWorker.ts:205` — concurrency 5/queue/process; each step holds a slot for
  a 45-120s LLM call → ~5 in-flight LLM calls/process.

**Fix (code scaffolding)**
Separate high-concurrency worker fleet (depends on HARD-A1), raise BullMQ concurrency, add queue-depth and
stuck-state metrics. **Score only moves to 8 with an actual multi-instance deployment + load test to 1,000
concurrent + capacity-matched agent service.** Document the load-test result as the acceptance criterion.

---

## [HARD-O1] Observability — metrics/tracing/alerting stack *(cannot reach 8 by code alone)*

**Where**
- No token/latency/cost telemetry anywhere; `usage_metadata` never read (`agent/app/llm.py`).
- `/observability` tracks workflow transitions only.

**Fix (code scaffolding)**
Instrument OpenTelemetry (or equivalent): model latency/error-rate/token-cost per call, queue depth,
stuck-state counts, per-turn negotiation outcomes (deal closed? rate? rounds used?). Add a `promptVersion`
and `{model, promptVersion, rawOutput}` stamp per AI call. **Score only moves to 8 with a running
monitoring backend + dashboards + alert routing** (error rate, breaker-open, manual-queue growth, stranded
instances) and drift monitoring on classification/negotiation distributions.

---

## [HARD-T1] Testing — real dataset + CI-gated eval + flow tests *(cannot reach 8 by code alone)*

**Where**
- `agent/tests/negotiation_eval/run_eval.py` — 22 synthetic cases, only 4 machine-asserted, not in CI.
- `.github/workflows/ci.yml` — runs pytest + npm test; `run_eval.py` and live-model tests
  (`RUN_LLM_EVAL=1`) are never invoked.
- `server/src/engine/executors/negotiation.ts` — 565-line core executor has no flow-level test.
- `server/src/adapters/negotiation/LangGraphNegotiationProvider.ts:51-64` — field-dropping adapter bug
  class has no TS regression test.

**Fix (code scaffolding)**
1. Machine-assert **all** eval cases (action, rate bounds, no-leak, question-coverage), including Case 19
   (must be ESCALATE — see CRITICAL-4). Wire a gated eval into CI.
2. Add a flow-level test for `executeNegotiation` and a regression test for the adapter field-copy.
3. Add an LLM-as-judge email-quality eval and adaptive simulated-creator multi-turn evals with
   run-to-run variance bars.
**Score only moves to 8 with a real anonymized dataset (repo's own criterion: ≥~500 real replies) — a
data-collection effort, not a diff.**

---

## [HARD-T2] Prompt versioning

**Where**
- No `promptVersion`/`PROMPT_VERSION` anywhere; only proposed in `ARCHITECTURE_GAP_ANALYSIS.md:277`.

**Fix**
Add a `PROMPT_VERSION` constant per prompt, stamp it on every AI call and every event/log line, so eval
results and production behavior are attributable to a prompt revision. Prerequisite for regression gates
and drift monitoring.
