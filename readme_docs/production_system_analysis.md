# Pluvus AI Outreach System
## Technical Architecture & Production Readiness Report

**Date:** 2026-07-14 · **Scope:** entire repository at branch `main` (tip `91013da`, plus the uncommitted HARD-O1 telemetry work in the working tree) · **Reviewer role:** Principal AI Systems Architect / Staff Engineer / Technical Due Diligence
**Method:** full read of `agent/` (Python AI service), `server/` (TypeScript orchestration), `web/` (React dashboard), `shared/`, all documentation (`README.md`, `TESTING_LANDSCAPE.md`, `MERGE_READINESS.md`, `readme_docs/`, `docs/`, `.claude/spec/`), CI, Docker, all 23 migrations, all 70 test files, and the recorded eval artifacts. Every claim in this document carries a `file:line` citation or names the artifact it came from.

**Out of scope by agreement** (accepted upcoming changes, not treated as findings): the Claude Opus swap for negotiation/classification, DeepSeek for drafting, production env/deployment configuration, and parent-Pluvus merge work (tracked separately in `MERGE_READINESS.md`). Intentionally absent platform features (auth, billing, creator dashboards, click tracking) are likewise not criticized.

> **✅ Status update (2026-07-14 → 15):** All five Severity-1 findings (§6 W-1…W-5) are **fixed and independently re-verified** — see the dated ✅ note under each item. Evidence: server suite **116/116** (including the new W-2 and W-4 tests), agent suite **421 passed / 5 skipped**, `tsc` clean, `pip install --dry-run -e .` resolves the agent package, and the queue-injection endpoints answer 404 outside test/opt-in. One provider decision accompanied the fixes: the hosted LLM path is **OpenRouter-only** — a single `OPENROUTER_API_KEY` gateway serving both Claude Opus (decision path) and DeepSeek (drafting) via per-role `OPENROUTER_MODEL_<ROLE>` — which elevates the W-16 price-table gap (OpenRouter-labelled calls currently record `est_cost_usd=None`) to the top of the follow-up list. With Severity-1 cleared, the §11 conditional-go condition is met: **supervised pilot unblocked; effective score 7/10.** The §1/§5 numbers below are preserved unchanged as the point-in-time audit snapshot.

> **✅ Status update 2 (2026-07-15):** The five Severity-2 findings (§6 W-6…W-10) are now also **fixed and verified** — version-scoped SQL observability with a workflow picker (W-6), transactional step commits + cascade deletes (W-7), a Redis leader lease on the scheduler (W-8), agent hardening: pool-saturation fail-fast, trusted-identity rate limiting, gated `/metrics`, fail-closed deployed-env auth (W-9), and the flagship-README rewrite verified claim-by-claim against the code (W-10). Evidence: server suite **119/119** (three new PGlite/unit test files), agent suite **430 passed / 5 skipped** (nine new tests), `tsc` clean in both server and web. Remaining pre-autonomy work: alerting on the four existing signals, durable blob storage for uploads, the W-16 OpenRouter price-table entry, and the Severity-3 hygiene list.

---

## 1. Executive Summary

### What this system accomplishes

This repository is a working V1 of an autonomous creator-outreach pipeline: given a campaign and a CSV of creators, the system drafts and sends personalized outreach emails, follows up on silence, receives real inbound replies over a webhook, classifies each reply's intent, negotiates fees inside brand-configured guardrails across multiple rounds, answers creator questions from campaign knowledge, escalates anything risky to a human queue, and — on agreement — sends a contract-forming confirmation, collects payout information through a tokenized hosted form, and delivers the campaign brief PDF. A human touches the process only when the AI deliberately hands off.

### Architecture in one paragraph

Three services with clean seams. A **Python FastAPI "agent"** (`agent/`) owns everything probabilistic: four endpoints (`/classify`, `/negotiate`, `/draft`, `/parse-brief`), a multi-provider LLM abstraction with per-role routing and failover (`agent/app/llm.py`), heavily engineered versioned prompts, and a battery of deterministic guards that sit before and after every model call. A **TypeScript Node server** (`server/`) owns everything that must be correct: a 16-state workflow state machine (`server/src/engine/stateMachine.ts`), node executors dispatched by a runtime with optimistic concurrency control (`server/src/engine/runtime.ts`), BullMQ queues over Redis, an in-process scheduler, Drizzle ORM over Neon Postgres, Nylas email in/out with HMAC-verified webhooks, and idempotency keys on every send. A **React dashboard** (`web/`) gives operators a drag-and-drop workflow builder, CSV enrollment, launch controls, live monitoring, a manual-escalation queue, and a per-instance inspector with full email threads, AI decisions, and per-call LLM token/cost telemetry. A single `shared/classifier-spec.json` keeps the deterministic classification gates byte-identical across Python and TypeScript.

### Why the architecture is good

The organizing principle — stated in `.claude/spec/audit-remediation/PRINCIPLES.md` and genuinely enforced in code — is **"the LLM decides, the code guards."** No dollar figure the model produces reaches a creator without passing through: rate coercion and literal-substring validation (`agent/app/routes/negotiate.py:449-542`), band clamping and false-acceptance guards (`negotiate.py:1033-1137`), adapter-side finite-number validation (`server/src/adapters/negotiation/LangGraphNegotiationProvider.ts:58-63`), an executor exhaustiveness backstop, and finally an output guard that scans every rendered email for the confidential floor/ceiling in digits *and* English words, and blocks any dollar amount that was not deliberately placed (`server/src/engine/guards/outputGuard.ts:202-266`). Every failure mode — model outage, malformed JSON, low confidence, injection attempt, missing ceiling, missing agreed fee — terminates at `MANUAL_REVIEW`, never at a guess. That invariant held through a 500-case adversarial eval and a 30-case run on the production model tier.

### Strengths at a glance

- Defense-in-depth money path with five independent layers, each separately tested.
- Reply-loss engineering that is coherent across four layers (webhook dedupe → deterministic job IDs → idempotent persist → lock-retry rather than drop) (`server/src/workers/inboundEmailWorker.ts`, `server/src/engine/runtime.ts:307-320`).
- OCC-based state transitions verified against real migration DDL on PGlite (`server/src/db/instances.occ.test.ts`) — an unusually strong safety net for a young codebase.
- A real evaluation culture: a 500-case machine-asserted dataset (≈97% on the local model, `readme_docs/EVAL_500_TESTCASES.md`), a cost-efficient 30-case subset run on the production tier (26/30, $0.93 billed, `readme_docs/report/OPUS_SUBSET_RUN_2026-07-13.md`), and CI tripwires that pin the money-safety invariants.
- End-to-end LLM telemetry (tokens, latency, estimated cost per call, attributed to instance and role via AsyncLocalStorage) landing in a queryable `LlmCall` table and surfaced in the dashboard (`server/src/observability/llmUsage.ts`, `web/src/components/LlmUsagePanel.tsx`).
- ~700 automated test cases across three suites, including adversarial "escalation trap" matrices on both sides of the HTTP seam.

### Production confidence

**Overall production score: 6.5 / 10.**

Decomposed: AI decision safety **8.5/10** (the strongest part of the system, validated empirically); orchestration correctness **7.5/10** (OCC + idempotency are solid; a few reachable stranding/crash-loop gaps remain); operations & deployability **4/10** (the committed Dockerfile does not build, CI contains stale steps, uploads live on local disk, the frontend has no serving story); documentation **5/10** (excellent recent docs, but the flagship README describes the previous generation of the system).

**Recommendation:** ready for a **supervised pilot** with real creators today — a human watching the Manual Queue, modest volume, mock-free email. Not yet ready for unattended autonomous operation, primarily for operational (not AI-safety) reasons enumerated in §6. The gap between "pilot" and "production" is roughly two focused engineering weeks, and none of it requires redesign.

---

## 2. Repository Walkthrough

*This section is written as the definitive onboarding guide for a senior engineer joining the project.*

### 2.1 Top-level layout

| Path | What it is |
|---|---|
| `agent/` | Python 3.11 FastAPI service — the AI layer. All LLM calls happen here. |
| `server/` | TypeScript Node (ESM, NodeNext) — workflow engine, queues, DB, email, HTTP API. |
| `web/` | Vite + React 18 + TypeScript dashboard (builder + observability). |
| `shared/` | One file: `classifier-spec.json`, the cross-language deterministic-gate spec (MED-A2). |
| `readme_docs/`, `docs/`, `.claude/spec/` | Eval reports, testing runbooks, founder-alignment spec, audit-remediation spec. |
| `README.md` | 69 KB flagship doc — **stale by one product generation** (see §6, D-docs). |
| `TESTING_LANDSCAPE.md` | Current five-tier testing overview (accurate, 2026-07-14). |
| `MERGE_READINESS.md` | The parent-Pluvus merge plan (hazards H1–H9, milestones M1–M7). |
| `docker-compose.yml` | postgres:16 + redis:7 + an `app` profile running one server image as `api` / `worker` / `scheduler` roles. |
| `.github/workflows/ci.yml` | Two jobs: agent pytest, server node:test. |

Root is an npm workspace (`web` + `server`); the agent is pip-installed separately.

### 2.2 The Python agent (`agent/`)

**Endpoints** (`agent/app/main.py`, `agent/app/routes/`): `GET /health`, `GET /metrics` (telemetry summary), `POST /classify` (reply → one of six intents `POSITIVE|NEGATIVE|QUESTION|OPT_OUT|UNKNOWN|DEFERRED` with confidence, `classify.py:45`), `POST /negotiate` (reply + history + band → `{action, proposedTerms, creatorQuestions, pushedFixedTerms, creatorRequestedRate, ...}`, `negotiate.py:3498-3528`), `POST /draft` (25+ field request → `{subject, body}`, `negotiate.py:3531-3547`), `POST /parse-brief` (PDF base64 → text, never 500s, `negotiate.py:3562-3581`). All AI endpoints carry Bearer/X-API-Key auth (no-op with a warning when `AGENT_API_KEY` unset) and a fixed-window rate limiter (`agent/app/security.py`).

**LLM abstraction** (`agent/app/llm.py`, 565 lines): four providers — `ollama`, `anthropic` (default model `claude-opus-4-8`), `deepseek`, `openrouter` — selected globally by `LLM_PROVIDER` with per-role overrides (`LLM_PROVIDER_NEGOTIATE|CLASSIFY|DRAFT`) and an optional two-candidate failover chain (`FailoverChat`, `llm.py:387-461`). Each candidate runs under its own wall-clock budget (default 60 s) enforced through a shared thread pool (`agent/app/structured.py:47-112`). Ollama gets genuine determinism (seed 42, `top_p=1.0`, `format="json"`, `keep_alive=-1`); hosted providers rely on temperature-0 prompting plus JSON repair re-asks (`structured.py:181-249`). Every call emits a telemetry record (model, prompt version, latency, tokens, estimated cost) into a per-request ContextVar capture that becomes the `llmUsage` block on every response (`agent/app/telemetry.py:229-255`).

**Guard stack** (the heart of the system):

1. *Pre-model deterministic gates* — opt-out detection that injection cannot suppress, an injection-pattern battery, and a topic gate that force-escalates legal/dispute/pricing-exception/usage-rights topics and honestly defers payment-timing questions (`agent/app/injection.py`, `agent/app/topic_gate.py:54-63`). Gates scan normalized text while the model receives sanitized text (`classify.py:210-215`).
2. *Prompt-level rules* — the negotiation prompt (v1.3, ~315 lines, `negotiate.py:1163-1479`) carries confidential band figures with a never-reveal rule, anchoring discipline, "ACCEPT only with a real rate," fixed-vs-negotiable term boundaries, an extensive escalation taxonomy, and a strict JSON output contract with literal-only rate extraction.
3. *Post-model money guards* (`_apply_decision_guards`, `negotiate.py:1033-1137`) — clamp COUNTER/PRESENT_OFFER into the band, escalate ACCEPT above the tolerance ceiling, convert final-round COUNTER to ACCEPT only when the creator's ask is inside tolerance (the CRITICAL-4 anti-false-acceptance rule), and never over-pay (ask ≤ floor → accept at the ask). If guards changed the decision, the model's pre-guard email draft is discarded and re-drafted.
4. *Draft verification-with-repair* (`negotiate.py:3305-3375`) — after drafting, a checklist verifies every creator question was answered and every known campaign fact was stated; one reinforced re-draft, then deterministic splicing of still-missing known facts into the body.

**Strategy switch:** `NEGOTIATION_STRATEGY=llm` (code default) lets the model choose action+rate from full history inside the guards; a deterministic rules ladder (`_decide_action`, `negotiate.py:672-842`) is both the alternative strategy and the automatic fallback whenever the LLM path throws — a model outage never 500s a negotiation (`negotiate.py:1880-1895`).

**Tests:** 23 pytest files, 305 test functions (~414 collected with parametrization) — guard math, injection, failover, telemetry, security, and a 17-case escalation-trap matrix (T2). **Eval:** a 34-case classification gate wired into CI, plus the 500-case negotiation dataset with loader/validator/runner and per-bank live-result JSON artifacts (`agent/tests/negotiation_eval/dataset_500/`).

### 2.3 The TypeScript server (`server/`)

**Engine.** Workflows are authored as graphs in the UI but executed as a **flat ordered node list**: publish snapshots `draftNodes` into an immutable `WorkflowVersion.nodeGraph` (`src/routes/workflows.ts:327-392`); the builder's graph positions live in a `_graph` config sidecar the runtime ignores. `WorkflowRuntime.stepInstance` (`src/engine/runtime.ts:175-295`) loads context, dispatches the executor for the current node inside an AsyncLocalStorage LLM-attribution scope, validates the transition against the state machine, and commits via **optimistic concurrency** (`UPDATE ... WHERE currentState = expected`, `src/db/instances.ts:126-143`); a stale write throws and the job retries. Every transition appends a `STATE_TRANSITION` event carrying `{from, to, source, worker, queueJobId}` — the `Event` table is the audit log and, for negotiation, the **money trail**: the agreed fee is recovered exclusively by replaying `NEGOTIATION_TURN` events (`src/engine/executors/agreedFee.ts:32-39`), and contract-forming emails escalate with `no_agreed_fee` rather than fall back to a configured band value.

**State machine** (`src/engine/stateMachine.ts:7-85`) — 16 states. Main path: `ENROLLED → OUTREACH_SENT → AWAITING_REPLY ⇄ FOLLOWED_UP → REPLY_RECEIVED → NEGOTIATING (self-loop) → ACCEPTED → PAYMENT_PENDING → CONTENT_BRIEF_SENT` (success terminal), with a legacy `REWARD_PENDING → REWARD_CONFIRMED → PAYMENT_RECEIVED` chain still supported. Terminals: `CONTENT_BRIEF_SENT`, `REJECTED`, `OPTED_OUT`, `NO_RESPONSE`, `MANUAL_REVIEW`. `DEFERRED` replies loop back to `AWAITING_REPLY` with a future `dueAt`.

**Executors** (dispatch table `runtime.ts:719-788`): `IMPORT_CREATOR_LIST`, `INITIAL_OUTREACH` (AI draft with template fallback, output-guard scan, `sendOnce`), `FOLLOW_UP` (three-phase send/schedule/give-up with `maxCount → NO_RESPONSE`), `REPLY_DETECTION` (opt-out gate → active-negotiation short-circuit → classify → topic override → confidence threshold → route), `NEGOTIATION` (§3.7), `REWARD_SETUP`/`PAYMENT_INFO` (legacy split nodes), `CONTENT_BRIEF` (merged terminal node: agreed fee + payout link + brief PDF in one guarded email), `END`.

**Provider seams.** `IEmailProvider` (mock + Nylas) and `IAgentProvider` (mock + LangGraph-HTTP) are constructed by an env-aware factory that fails fast on unset email provider and warns loudly on prod-mock (`src/engine/providerFactory.ts:45-144`). The `AgentProviderAdapter` is the degradation seam: classify failure → `UNKNOWN@0` → `MANUAL_REVIEW`; negotiate failure → escalate; draft retried 3× then template-fallback or escalation. HTTP calls carry a circuit breaker (5 failures / 30 s cooldown) and role-appropriate timeouts (120 s negotiate/draft, 45 s classify) (`src/adapters/agentServiceClient.ts`). Both LangGraph adapters validate the wire shape field by field — the intent allowlist is **derived from the DB enum** with a drift-guard test (`src/adapters/classification/LangGraphClassificationProvider.ts:24-26`), a structural fix for the exact bug class that once dropped `DEFERRED` replies in live testing.

**Email.** Nylas outbound with base64 PDF attachments and a threadId re-fetch fallback; inbound via `POST /webhooks/nylas` mounted on `express.raw` *before* the JSON parser so the HMAC-SHA256 signature verifies over raw bytes, fail-closed when the secret is missing (`src/providers/nylas/verifySignature.ts:30-49`). Replies correlate by stored threadId; outbound echoes are filtered at both webhook and worker; every outbound send goes through `sendOnce` reserve-before-send keyed on a unique `idempotencyKey` (`src/engine/executors/idempotentSend.ts:66-109`). Deterministic opt-out gating runs on *every* inbound path, including post-agreement replies (MED-W1).

**Persistence** (`src/db/schema.ts`): 11 tables — `Campaign` (with the HARD-K1 knowledge fields: usage rights, exclusivity, payment terms, attribution window), `Workflow`, `WorkflowVersion`, `Creator`, `ExecutionInstance` (unique per version+creator, `(currentState, dueAt)` index), `Message` (unique `externalMessageId` and `idempotencyKey`), `Event` (append-only), `OutboxJob` (scaffold, unused), `BrandNotification`, `PaymentInfo` (unique token, 30-day TTL), and the new `LlmCall` (per-call tokens/latency/cost, instance-attributed, migration `20260714093000` applied). Drizzle over Neon serverless; 23 SQL migrations retained under `prisma/migrations/` as the migration-SQL owner (the Prisma *runtime* is fully removed — M1).

**Workers & scheduling.** Two BullMQ queues (`node-execution`, `inbound-email`), 3 attempts with exponential backoff, deterministic job IDs for producer-side dedupe, concurrency env-tunable (default 5). A 30 s in-process poller (single `scheduler` role by convention) runs the HARD-R1 reconciliation sweep (re-enqueues instances stuck >10 min in transient states) and enqueues due `AWAITING_REPLY`/`FOLLOWED_UP` instances, batch-capped at 200 (`src/scheduler/poller.ts`, `src/scheduler/reconciliation.ts`). Redis distributed locks are fencing-token-based and are an optimization only — OCC is the correctness guarantee.

**Observability.** Six read-only DTO endpoints (`src/routes/observability.ts`): workflow summary, instance list/detail, timeline, transition logs, queue metrics, and the HARD-O1 `/observability/llm` aggregate (totals, last-24 h, by-role, by-model, computed in SQL). Guard-hit payloads mask band values on write *and* re-mask on read for legacy rows (`src/observability/repository.ts:75-83`).

**Tests:** 45 files, ~374 test-case invocations — the 14-scenario T1 escalation-trap suite, OCC against real DDL on PGlite, the 26-case output-guard suite, adapter/degradation suites, route tests for payment/uploads, and an intent-allowlist drift guard.

### 2.4 The web dashboard (`web/`)

Vite + React 18 + TanStack Query, hash-based routing, dark-theme design-token system with a 20-component in-house DS (`web/src/components/ds/`). Two surfaces:

- **Builder** (`components/builder/`): campaign wizard (brand description, deliverables, timeline, reward blurb, physical-product toggle, escalation notify email) → template pick → a genuinely editable React Flow graph editor with palette drag-drop, single-linear-path validation (17 rule codes, `web/src/workflow/graphValidation.ts`), debounced autosave, publish gating, CSV creator import (hand-rolled RFC-4180 parser with 13 tests), enroll, a launch checklist with a "real emails will be sent" confirm, per-workflow monitoring, and the Manual Queue tab (escalation reason, age, brand-notification status, re-notify action).
- **Observability** (`components/`): a state-machine canvas with live per-state counts → per-state creator drilldown → a five-tab instance inspector (Timeline / Messages with intent+confidence badges / AI Decisions with reasoning / **AI Usage** per-call token+cost rows / transition Logs), plus a global LLM-usage strip. All views poll at 6 s with `placeholderData` anti-flicker.

Types are a disciplined hand-mirror of the server DTOs ("the server is the source of truth", `web/src/api/types.ts:4-5`). Accessibility is notably strong for an internal tool (focus-trapped modals, real tablists, `aria-live` save status, reduced-motion support). Zero `dangerouslySetInnerHTML` — all LLM/creator content renders as text nodes.

### 2.5 Lifecycles

**Request lifecycle (inbound reply):** Nylas → `POST /webhooks/nylas` (raw-body HMAC verify, GET/HEAD challenge echo) → dedupe by `externalMessageId` → BullMQ job `inbound|<messageId>` → inbound worker: echo-guard → per-instance lock (throws to retry rather than drop) → idempotent message persist → `runtime.injectReply` → state transition → auto-chain node-execution job → executor (classify/negotiate/draft via agent HTTP) → guarded `sendOnce` outbound → OCC commit → event append → `processedAt` stamp in `finally`.

**AI lifecycle:** every agent call runs under a versioned prompt (classify v1.1, LLM-negotiate v1.3, extraction v2.0, offer v1.4, onboarding v1.1), structured-output enforcement with one JSON-repair re-ask, per-candidate timeout, failover chain, telemetry record → response `llmUsage` block → server-side `recordAgentLlmUsage` (ALS-attributed, fire-and-forget) → `LlmCall` row → dashboard.

**Data lifecycle:** campaign → workflow → immutable version → instance per creator → append-only events (audit + money trail) → messages (both directions, dedupe keys) → payment info (tokenized) → LlmCall telemetry. Nothing on the money path is ever updated in place; the agreed fee is a replay, not a column.

---

## 3. Complete Workflow Analysis

Each stage below names the code that implements it.

**Stage 1 — Campaign creation.** Operator completes the two-step wizard (`web/src/components/builder/CampaignWizard.tsx`): identity, brand description ("the AI uses this to answer creator questions… without making things up"), deliverables, timeline, reward description, `shipsPhysicalProduct`, escalation `notifyEmail`, plus the four HARD-K1 knowledge fields on the campaign row (`server/src/db/schema.ts:210`). `POST /campaigns` persists; a workflow is created from one of three templates (affiliate / hybrid / fixed-fee).

**Stage 2 — Workflow building & publish.** The builder edits `draftNodes` (autosaved via `PUT /workflows/:id/draft`); validation enforces a single linear path with correct phase ordering (payment cannot precede approval, `graphValidation.ts:96-122`); `POST /workflows/:id/publish` snapshots an immutable `WorkflowVersion` (`routes/workflows.ts:327-392`). Published versions are never mutated — in-flight instances are isolated from later edits.

**Stage 3 — Creator selection & enrollment.** CSV upload → client-side parse → `POST /creators/import` (row-level error reporting, unknown columns folded into metadata) → roster selection → `POST /workflows/:id/enroll` creates one `ExecutionInstance` per creator, unique on (version, creator) so re-enrollment cannot double-run anyone.

**Stage 4 — Launch & initial outreach.** `POST /workflows/:id/launch` enqueues each `ENROLLED` instance. `INITIAL_OUTREACH` asks the agent for a draft (brand-neutral prompt — only the sender may be named, no dollar amounts, mandatory product paragraph, `negotiate.py:2083-2133`); on agent failure it falls back to a deterministic template; the rendered email is scanned by the output guard with *nothing* allowlisted (any dollar figure blocks the send, `executors/initialOutreach.ts:64`); `sendOnce` keyed `outreach:<instance>` guarantees exactly-once; state → `OUTREACH_SENT`.

**Stage 5 — Follow-up loop.** `FOLLOW_UP` schedules `dueAt`; the 30 s poller enqueues due instances; each cycle sends a guarded, keyed follow-up (≤90-word nudge prompt) until `maxCount`, then transitions to `NO_RESPONSE` (`executors/followUp.ts:43-142`).

**Stage 6 — Conversation tracking.** Inbound replies flow through the webhook/queue path described in §2.5 with four layers of loss protection. Early and mid-negotiation replies are accepted from `OUTREACH_SENT` and `NEGOTIATING` (`stateMachine.ts:18,32`), so a fast-replying creator is buffered, not dropped.

**Stage 7 — Classification & routing.** `REPLY_DETECTION` (`executors/replyDetection.ts:55-276`): (1) deterministic opt-out gate first — CAN-SPAM compliance cannot be LLM-suppressed; (2) if a negotiation is already active, skip classification and go straight to `NEGOTIATING`; (3) otherwise `/classify` (agent-side: injection gate → topic gate → force-gates that make "here's my rate: $500" always POSITIVE and questions always QUESTION); (4) server-side Phase E always-escalate topic override; (5) confidence < 0.50 → `UNKNOWN`; (6) route: POSITIVE/QUESTION → `NEGOTIATING`, NEGATIVE → `REJECTED`, OPT_OUT → `OPTED_OUT`, DEFERRED → `AWAITING_REPLY` + 3-day follow-up, UNKNOWN → `MANUAL_REVIEW(low_confidence_reply)`.

**Stage 8 — Negotiation.** `executeNegotiation` (`executors/negotiation.ts:335-802`): precondition guards first — floor-without-ceiling escalates *before* any model call (H1), max-rounds hard-stops to auto-`REJECTED` with a best-effort idempotent close email (founder rule #15). Otherwise the agent's `/negotiate` decides ACCEPT / COUNTER / PRESENT_OFFER / REJECT / ESCALATE with a guard-clamped rate; `PRESENT_OFFER` answers questions without consuming a round (capped at 3 consecutive frees); every turn appends a `NEGOTIATION_TURN` event — the money trail. The reply email is drafted with the full question ledger, pushed-fixed-term acknowledgments, campaign knowledge, and conversation history threaded through `/draft`, then verified for completeness, guard-scanned, and sent once.

**Stage 9 — Escalation.** Any escalate outcome, guard hit, low confidence, injection, always-escalate topic, missing config, or missing agreed fee transitions to `MANUAL_REVIEW` with a machine-readable reason. Entry into `MANUAL_REVIEW` fires an idempotent brand-notification email (campaign `notifyEmail` → `BRAND_NOTIFY_EMAIL` → operator fallback), recorded in `BrandNotification` with SENT/FAILED/SKIPPED status and a manual re-send action in the dashboard queue (`server/src/notifications/escalation.ts:223-305`, `web/src/components/builder/ManualQueueTab.tsx`). Per the founders' Phase A decision, escalation is a terminal one-way handoff — the old in-band brand-decision loop was deliberately removed.

**Stage 10 — Agreement & confirmation.** On ACCEPT, the agreed fee is resolved *only* from event replay (`agreedFee.ts:32-39`); if unresolvable, the system escalates rather than inventing a number (CRITICAL-3). The contract-forming confirmation email asks the creator to reply "I agree"; confirmation matching is a deterministic literal allowlist with renegotiation suppression — "I agree but can you do $600" never closes the deal at the old rate (`executors/rewardReply.ts:37-73`).

**Stage 11 — Payout & brief.** The merged `CONTENT_BRIEF` node mints a unique bearer token (30-day TTL), renders fee + commission + deliverables + payout-form link + attached brief PDF in one guarded email (fee explicitly allowlisted), and moves to `PAYMENT_PENDING`. The hosted Express form (`server/src/routes/payment.ts`) validates the token on GET and POST, collects payout method and — only when the campaign's stamped flag says so — a shipping address (anti-spoof, `payment.ts:203-213`). Submission drives the instance to the `CONTENT_BRIEF_SENT` success terminal.

**Stage 12 — Completion & failure routing.** Five terminals: success (`CONTENT_BRIEF_SENT`), explicit decline (`REJECTED`), compliance exit (`OPTED_OUT`), silence (`NO_RESPONSE`), human handoff (`MANUAL_REVIEW`). Stuck transient instances are re-enqueued by the reconciliation sweep; a down agent trips the circuit breaker and converts new work to `MANUAL_REVIEW` instead of stranding it.

---

## 4. Architectural Strengths

1. **Layered money-path safety that is actually independent.** Five guard layers (prompt rules → agent decision guards → adapter validation → executor backstop → output guard) fail separately and are tested separately. The output guard's *allowlist-only* dollar rule inverts the usual blocklist mistake: an email may contain only dollar figures the system deliberately placed (`outputGuard.ts:239-243`), including word-number forms ("four hundred fifty").
2. **Fail-to-human as a system invariant.** Every degradation path — circuit-breaker open, malformed JSON, low confidence, guard hit, missing ceiling, missing fee — terminates at `MANUAL_REVIEW` with a reason code and a brand notification. There is no code path that guesses on money.
3. **Correctness without distributed-systems machinery.** OCC conditional writes as the single guarantee, Redis locks as optimization with fencing tokens, deterministic queue job IDs, unique-key `sendOnce`, append-only events. Each mechanism is simple enough to reason about, and their composition is tested (the OCC test runs against the real migration DDL on PGlite).
4. **Structural prevention of a bug class that actually occurred.** The live DEFERRED outage (server allowlist missing a new intent) was fixed not with a patch but by deriving both runtime allowlists from the DB enum and pinning it with a drift-guard test (`LangGraphClassificationProvider.ts:24-26`) — the same philosophy as `shared/classifier-spec.json`, which keeps Python and TypeScript deterministic gates identical via a shared fixture both suites assert on.
5. **Evaluation as an engineering practice, not a demo.** A 500-case dataset with 1,175 machine assertions and a structural validator (dup detection, leak-ambiguity checks); per-bank live-result JSON artifacts; a cost-modeled 30-case production-tier subset ($0.93 measured vs $75+ full-run avoided); CI tripwires that hard-gate OPT_OUT recall at 1.0. The evals demonstrably drove ~15 real code fixes.
6. **Prompt engineering with product judgment.** The negotiation prompt encodes negotiation *discipline* (anchor below ask, small concessions, never counter above the ask, never reveal the band), an escalation taxonomy tuned from observed production-tier failures (v1.3 after the Opus subset), honest-deferral rules for unknowns, and worked examples. The extraction prompt (rules path) deliberately excludes the band entirely — leak-surface removal by construction.
7. **Draft completeness verification-with-repair.** The checklist → reinforced re-draft → deterministic fact-splice loop (`negotiate.py:3305-3375`) is an unusually complete answer to "the model ignored the creator's question," a failure mode most systems only discover in production.
8. **Observability built into the data model.** Append-only `STATE_TRANSITION` events with worker and queue-job attribution make every instance's history reconstructible; the `LlmCall` table closes the loop from "the AI did something" to "it cost $0.031 and took 6.2 s, attributed to this instance and role." Band values are masked in stored payloads and re-masked on read.
9. **Clean deployment topology on paper.** One server image, three roles (`PROCESS_ROLE=api|worker|scheduler`), horizontally scalable workers, explicit single-leader scheduler, mock providers gated to test env with loud prod warnings, fail-fast on unset email provider.
10. **Type discipline end to end.** `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` genuinely honored; DTO-only boundary between DB and API; the frontend treats server DTOs as the source of truth; zero HTML injection surface in the UI.
11. **Testing strategy with correct layering.** Pure-function guard math (fast, exhaustive) → seam tests with fakes (adapter reconstruction, degradation) → routing traps on real state machines → live-model evals (opt-in) → manual runbooks for what automation can't reach (real inbox deliverability). The suites encode *why* via audit item IDs in test names.
12. **Honest engineering culture visible in artifacts.** Docs distinguish "asserted" from "observed," label the classify gate "a tripwire, never quote as accuracy," record known divergences (D-1/D-2) with named pinning tests, and the founder-questions doc frames open product decisions instead of hiding them.

---

## 5. Production Readiness Evaluation

| Category | Rating | Assessment |
|---|---|---|
| **Reliability** | **7.5/10** | OCC + idempotency + reconciliation + circuit breaker + degrade-to-human form a coherent whole. Deductions: the FOLLOWED_UP stranding gap and the stale-`dueAt` crash loop (§6 W-2, W-3) are reachable in normal operation; state-commit and event-append are not atomic. |
| **Fault tolerance** | **7.5/10** | Agent outage, email-provider hiccup, Redis blip, and worker crash all have designed behaviors, and none corrupts money state. The residual risks convert failures into human tickets (safe) or silent stalls (not safe — W-2). |
| **Failure recovery** | **6/10** | The HARD-R1 sweep recovers most stranding; payment recovery via re-submit is deliberate (EASY-W3). But `RECONCILE_STATES` excludes FOLLOWED_UP (`instances.ts:182-190`), the reserve-before-send crash window causes a *missed* send with no repair job, and `MANUAL_REVIEW` has no re-route API — recovery from human-reviewed states is entirely out-of-band. |
| **Observability** | **7/10** | Instance-level forensics are excellent (timeline, thread, decisions, per-call cost). Aggregates are weaker: `getWorkflowSummary` full-scans all instances and transition events per 6 s dashboard poll (`repository.ts:120-141`), logs are raw stdout JSON lines, there is no metrics exporter, alerting, or tracing — the `/metrics` surfaces exist but nothing consumes them. |
| **Scalability** | **5/10** | The queue/worker split scales horizontally by design; the scheduler, the observability queries, the agent's in-process thread pool and rate limiter (MERGE_READINESS H4), and single-inbox email do not. Fine to ~1k creators/mo; needs the §9 work beyond that. |
| **Maintainability** | **6.5/10** | Strong test coverage, DTO boundaries, versioned prompts, and self-documenting guard code. Deductions: `negotiate.py` is a 3,582-line monolith mixing prompts, guards, heuristics, and routes; eval-bank-specific regexes are baked into production code; the flagship README documents the previous system generation. |
| **Extensibility** | **7/10** | Provider seams, executor registry, per-role LLM routing, and immutable versioning make additive change cheap (phases 11–16 were all added without engine changes — good evidence). The linear-only execution model and the hand-rolled state→node resolution overrides (`runtime.ts:101-141`) are the walls V2 will hit. |
| **Security assumptions** | **6/10** (within stated scope) | What exists is good: HMAC-verified webhooks (fail-closed), bearer payment tokens with TTL, magic-byte upload validation, injection gates, band masking, anti-spoof shipping flag. Deductions are internal-surface issues, not missing auth: unauthenticated `/queues/*` endpoints can fabricate inbound replies with forced intents; the agent ran unauthenticated in practice (its own logs warn `AGENT_API_KEY is not set`); the agent rate limiter keys on the *presented* credential, so it is bypassable exactly when auth is off (`security.py:150-164`). |
| **Operational complexity** | **Moderate** | Five moving parts (api, worker, scheduler, agent, web) + Postgres + Redis + Nylas + LLM APIs. The role-based single image keeps this manageable; the broken Dockerfile and absent web/agent serving story currently prevent exercising it. |
| **Developer experience** | **7.5/10** | Excellent: npm workspaces, `tsx watch`, eight phase harnesses, PGlite DB tests, injectable clocks, one-command compose for infra. Deductions: CI runs a stale `npx prisma generate`, never runs web typecheck/tests/build, and the live-eval CI condition references an env var that is never defined, so it can never fire (`.github/workflows/ci.yml:57-61`). |

---

## 6. Remaining Weaknesses

*Only real, currently-open issues. Accepted upcoming changes (model swap, deployment config, merge work) are excluded. Items the team has already explicitly triaged and parked with founder visibility — H9 inbound-attachment blindness (deferred to merge milestone M3), the max-rounds auto-REJECT being unreachable under the LLM strategy (open product decision P1/Q3), and the utility-curve concession math (P2, TODO at `negotiate.py:655-665`) — are acknowledged as tracked decisions, not re-litigated here.*

### Severity 1 — fix before any production traffic

**W-1. The committed Docker build is broken.**
`server/Dockerfile:16` runs `npm run db:generate --workspace server`, a script deleted with Prisma in M1 — no `db:generate` exists anywhere in the repo (verified). `docker build` fails at that layer, and `.github/workflows/ci.yml:81-82` still runs `npx prisma generate` against the leftover schema, downloading an unpinned Prisma every run to generate a client nothing imports.
*Why it matters:* the only defined path from source to a running production artifact does not work; CI green does not mean the image builds.
*Impact:* deployment blocked at the first step; silent CI drift.
*Improvement:* delete the dead Dockerfile line and CI step; add a `docker build` smoke job so this class of rot is caught structurally.
✅ **RESOLVED (2026-07-14; re-verified 2026-07-15).** The dead `db:generate` line is removed — `RUN npm run build` (tsc) is now the entire build layer — and the image additionally ships `server/prisma/` so the migration SQL and `apply-migration.ts` runner deploy inside the same image (closing a gap §7 of this report flagged separately). In CI, the stale `npx prisma generate` step is deleted and a new `docker-build` smoke job builds the server image on every push/PR — exactly the structural fix demanded above. Verification: the build-layer command (`npm run build --workspace server`) exits clean, both suites green; a full local `docker build` was attempted but the review machine's Docker Desktop engine crashed mid-`npm ci` and would not restart (environment failure, unrelated to the Dockerfile) — the CI smoke job supplies the full-image proof on the next push.

**W-2. Silent permanent stall in the follow-up chain.**
`executeFollowUp` commits `FOLLOWED_UP` with `dueAt: null` (`followUp.ts:124-136`) and relies on the worker's auto-chain enqueue to continue. If that enqueue is lost (crash, Redis blip), the instance sits forever: the due-poller requires `dueAt <= now` (`instances.ts:163-166`) and the reconciliation sweep deliberately excludes `FOLLOWED_UP` (`instances.ts:182-190`) — its comment claims the due poller covers it, which is false for the null-`dueAt` window.
*Why it matters:* this is the one stranding mode with *no* recovery mechanism, and it strands creators mid-funnel invisibly.
*Impact:* lost deals with no alert; only the coarse stuck-metrics counter would hint at it.
*Improvement:* add `FOLLOWED_UP` to `RECONCILE_STATES`, or write the next `dueAt` in the same commit as the state change.
✅ **RESOLVED (2026-07-14).** `FOLLOWED_UP` added to `RECONCILE_STATES` (`server/src/db/instances.ts`) — it is transient (committed with `dueAt=null` and auto-chained), so the sweep is the only possible recovery, and re-execution is a pure reschedule that is safe to re-run. Locked by a new positive assertion in `reconciliation.coverage.test.ts` (and `FOLLOWED_UP` moved out of that test's waiting-states exclusion list).

**W-3. Stale `dueAt` survives onto the reply path and causes a recurring crash loop.**
No reply-path transition clears `dueAt` (`runtime.ts:373-376`, `replyDetection.ts:193-198`, `negotiation.ts:766-782`). After a mid-negotiation counter parks the instance at `AWAITING_REPLY` on the NEGOTIATION node, the outreach-era `dueAt` eventually lapses, the poller enqueues a job, and `executeNegotiation` throws `NEGOTIATION expects NEGOTIATING state` (`negotiation.ts:347-351`) — repeatedly, on every retry cycle. A side effect: there is no working follow-up nudge for a creator who goes silent *mid-negotiation*.
*Why it matters:* failed-job noise masks real failures, and mid-funnel silence — the most valuable moment to nudge — is unhandled.
*Impact:* operational noise now; lost conversions structurally.
*Improvement:* clear or reset `dueAt` on every reply-path transition; design a mid-negotiation follow-up as a product feature.
✅ **RESOLVED (2026-07-14)** — bug half. `injectReply` now sets `dueAt: null` on the `REPLY_RECEIVED` transition (`server/src/engine/runtime.ts`) — the front door of the entire reply path, so every downstream transition (classification routing, negotiation counters) starts from a cleared schedule and the stale-`dueAt` crash loop is killed at its source. The mid-negotiation silence *nudge* remains an open product feature, as this report framed it.

**W-4. Internal queue-injection endpoints can drive real state machines.**
The `/queues/*` routes accept unauthenticated posts, including inbound-email jobs with a forced `mockIntent` — anyone who can reach the API can fabricate a creator's "acceptance." Within the no-auth prototype scope this was a legitimate dev tool, but unlike the dashboard's read paths, this surface *forges money-path inputs*.
*Impact:* a single exposed port turns into fraudulent deal closure.
*Improvement:* compile these routes out (or key-gate them) outside `NODE_ENV=test` — a one-day change that removes the worst asymmetric risk before pilot.
✅ **RESOLVED (2026-07-14).** Both POST injection routes now sit behind `requireInjectionEnabled` (`server/src/routes/queues.ts`): they answer **404** unless `NODE_ENV=test` or an explicit `ENABLE_QUEUE_INJECTION=true` dev opt-in (now documented in `.env.example` with a "never set in a deployed environment" warning). Read-only GET diagnostics stay open. The gating predicate is pure and unit-tested (`queues.injectionGate.test.ts`, 5 cases); no existing test or harness POSTed these routes over HTTP, so nothing broke.

**W-5. The accepted DeepSeek plan does not install.**
`agent/app/llm.py:250,307` imports `langchain_openai` for the `deepseek` and `openrouter` providers, but the package is declared nowhere (`agent/requirements.txt` has only anthropic/ollama variants — verified). Relatedly, `agent/pyproject.toml:40` declares `build-backend = "setuptools.backends.legacy:build"`, which is not a real backend — `pip install -e .` fails; and all deps are unpinned `>=` ranges with no lockfile.
*Why it matters:* this is not a critique of the DeepSeek decision — it is a packaging defect that breaks that accepted plan on any fresh environment, and it is invisible today only because dev machines have the package transitively.
*Improvement:* declare `langchain-openai`, fix the backend string to `setuptools.build_meta`, pin with a lockfile (`pip-tools`/`uv`).
✅ **RESOLVED (2026-07-14)** — with one provider decision attached. `langchain-openai>=0.2.0` is now a declared, required runtime dep (`agent/requirements.txt`), the build backend is corrected to `setuptools.build_meta`, and an explicit `[tool.setuptools.packages.find]` fixes a latent flat-layout multi-package discovery error the broken backend had masked; CI now installs the package so the hosted provider is exercised offline. Verified: `pip install --dry-run -e .` → `Would install pluvus-agent-0.1.0`. **Provider decision:** the hosted production path is **OpenRouter-only** — one `OPENROUTER_API_KEY` gateway serving both Claude Opus (decision path) and DeepSeek (drafting) via per-role `OPENROUTER_MODEL_<ROLE>` — not direct Anthropic/DeepSeek accounts. Dependency pinning (lockfile) remains open as a Severity-3 hygiene item.

### Severity 2 — fix before scaling past a pilot

**W-6. Observability aggregates are wrong with >1 workflow and unbounded with any scale.**
`getWorkflowSummary` labels the dashboard with the newest published version but aggregates **all** execution instances with no version filter (`repository.ts:113-128` — verified: `.from(executionInstances)` with no `where`), so two campaigns produce cross-contaminated counts under one workflow's name. The same query loads every instance and every transition event into memory per 6 s dashboard poll, and the manual queue loads full event logs per escalated instance (`manualQueue.ts:148-158`).
*Impact:* operators see wrong numbers the day a second campaign launches; DB load grows quadratically with fleet size.
*Improvement:* add the version filter and a workflow selector; move counts and time-in-state to SQL aggregates.
✅ **RESOLVED (2026-07-15).** `getWorkflowSummary(workflowVersionId?)` now scopes every count, waiting/stuck flag, and time-in-state to ONE version (default = newest published), computed in SQL: a single `GROUP BY currentState` for counts + a stuck `filter (…)` clause, and a two-level subquery (per-instance entered-at → avg per state) for time-in-state — so ~16 rows come back per poll instead of the whole table + every transition event. Cross-campaign contamination is gone (a version filter on the instance set). A new `GET /observability/workflows` selector endpoint (`listWorkflowOptions`) + `?workflowVersionId=` on `/workflow` and `/instances` let the dashboard scope both the canvas and the drilldown; the frontend renders a scope picker in the observability topbar (shown once >1 workflow exists). The manual queue now fetches only the three escalation-relevant event types, not the full per-instance log. Locked by `workflowSummary.scoping.test.ts` (5 cases on PGlite + real migrations: A/B isolation, newest-version default, SQL stuck/avg paths, selector counts). tsc clean both; server 119/119; web build green.

**W-7. No atomicity between state commit and money-trail append.**
`stepInstance` commits the OCC state write and then appends the `NEGOTIATION_TURN`/transition events as separate statements (`runtime.ts:227-252`). A crash in between loses the ACCEPT's rate; downstream fee resolution then escalates `no_agreed_fee`. Safe — the system never fabricates — but a crash becomes a human ticket and an orphaned money figure. `deleteCampaign`'s multi-table cascade is likewise non-transactional (`campaigns.ts:57-107`).
*Improvement:* wrap step commit + event append in one transaction; same for cascade deletes. Longer-term, denormalize `agreedRate` onto the instance at ACCEPT time (the event replay stays as audit).
✅ **RESOLVED (2026-07-15).** `stepInstance` now runs the OCC state write and BOTH event appends (domain event + `STATE_TRANSITION`) inside a single `db.transaction`, so a crash between them rolls the whole step back — an ACCEPT can never commit without its `NEGOTIATION_TURN` money-trail event, and the `no_agreed_fee` escalation can no longer be triggered by a mid-step crash. The stdout trace + best-effort brand notification stay OUTSIDE the transaction (side effects, emitted only after durable commit). `appendEvent` and `updateInstanceStateConditional` now accept an injected `Db | DbTx` client so both enlist in the tx (same injectable-client pattern the OCC test already used). `deleteCampaign`'s multi-table cascade is likewise wrapped in one transaction. Locked by `stepCommit.atomicity.test.ts` (3 cases on PGlite + real migrations: happy-path co-commit, crash-before-append rolls both back, append-failure rolls back the state write). The denormalized-`agreedRate` column is left as the report's stated *longer-term* option — the atomic commit fully closes the described crash-window, and keeping the event log as the single source preserves the CRITICAL-3 "never fabricate a fee" design. *Independent review (same day) found and closed one more instance of the identical window:* `injectReply`'s `REPLY_RECEIVED` transition (OCC write + `INBOUND_REPLY_RECEIVED` + `STATE_TRANSITION` appends) is now wrapped in the same single transaction; the remaining standalone `appendEvent` sites (reward/payment replies, escalation notice) have no paired state write and were verified safe.

**W-8. Scheduler single-leadership is convention, not mechanism.**
Nothing prevents two `PROCESS_ROLE=scheduler` processes (`processRole.ts:12-18`); deterministic job IDs blunt most double-fire, but reconciliation buckets can double-enqueue across drifted clocks, and — more practically — duplicate executor side effects mean **duplicate LLM spend** even where `sendOnce` prevents duplicate emails (agent calls run before the OCC check, `runtime.ts:201-206`).
*Improvement:* a Redis leader lock on the scheduler role — a few dozen lines with the fencing-lock code already present.
✅ **RESOLVED (2026-07-15).** A renewable Redis leader lease (`acquireOrRenewLeadership` / `releaseLeadership` in `scheduler/lock.ts`, keyed `scheduler:leader`, `SCHEDULER_LEADER_TTL_MS` default 90 s) now gates the entire poll cycle: each tick the poller acquires-or-renews the lease and returns early if it isn't the leader (or if Redis errors), so of N `PROCESS_ROLE=scheduler` processes exactly one polls/reconciles — killing the duplicate-executor / duplicate-LLM-spend path. Same fencing-token compare-and-extend/compare-and-delete pattern as the per-instance lock (a stalled ex-leader can neither renew nor steal back the standby's lease). Leadership is handed back on graceful shutdown so a standby takes over immediately. Single-node `PROCESS_ROLE=all` is unaffected (it always wins the uncontended lease). Locked by `leaderLock.test.ts` (5 cases over a fake shared Redis: acquire, renew, contention, stalled-leader takeover, fencing). The `index.ts` "scheduler started (single leader)" log is now actually enforced.

**W-9. Agent-side operational hardening gaps.**
(a) Timed-out generations keep holding pool threads — `future.cancel()` is a no-op after start (`structured.py:104-112`); 16 concurrent hangs silently saturate `_LLM_EXECUTOR` and defeat the timeout entirely. (b) The rate limiter buckets by the presented, unvalidated key (`security.py:150-164`), so it is bypassable precisely when `AGENT_API_KEY` is unset — which is how the service actually ran in live tests per its own logs. (c) `/metrics` is unauthenticated. (d) These compound with MERGE_READINESS H4 (in-process limiter/globals) to block horizontal agent scaling.
*Improvement:* enforce `AGENT_API_KEY` outside dev, key rate limits on client identity, move the pool to per-request budget accounting or async cancellation.
✅ **RESOLVED (2026-07-15).** (a) A capacity `BoundedSemaphore` sized to the invoke pool is now acquired *within the wall-clock budget* before submitting and released in a `future.add_done_callback` — so an orphaned (timed-out but still-running) generation holds its permit until it genuinely finishes, and a new call on a saturated pool fails fast with `LLMTimeoutError` (→ classify degrades to UNKNOWN, negotiate escalates) instead of blocking on `.submit()` and defeating the timeout. Each call binds the executor+semaphore instance locally so a release always targets the semaphore it acquired from. (b) `_client_id` uses the presented key as the rate-limit bucket key ONLY when `AGENT_API_KEY` is set (i.e. after `require_api_key` has validated it); with auth off it keys on the peer IP, so a caller can no longer dodge the limit by rotating a random key per request. (c) `/metrics` now carries `Depends(require_api_key)` (health stays open). Plus: a new `AGENT_ENV` — when it names a deployed env (`prod`/`production`/`staging`) and no key is set, `require_api_key` FAILS CLOSED with 503 rather than serving the money-path endpoints open ("enforce outside dev"). Locked by 9 new tests across `test_security.py` (unvalidated-key bypass, validated-key bucket, fail-closed vs dev-open, `/metrics` gating) and `test_llm_timeout.py` (saturated-pool fail-fast, permit-not-leaked). Full agent suite 430 passed / 5 skipped. The H4 in-process-globals coupling stays a merge-milestone item as the report noted.

**W-10. Documentation drift concentrated in the flagship README.**
`README.md` still documents the removed brand-decision loop as "✅ Working," a 17-state machine including `AWAITING_BRAND_DECISION` (grep: zero hits in code), Prisma as the ORM, OpenAI as a provider, five intents (no DEFERRED), and universal determinism claims that hold only on Ollama. Same-day docs contradict each other on telemetry (three docs say "no telemetry backend"; the working tree contains the live `LlmCall` pipeline) and test counts (75/75 vs 103/103).
*Why it matters:* the stated purpose of this repo's docs is onboarding and diligence; the most prominent document reliably misleads on exactly the money-adjacent behaviors that changed.
*Improvement:* one focused README rewrite pass against `stateMachine.ts`, `llm.py`, and the current escalation model; delete or archive superseded claims.
✅ **RESOLVED (2026-07-15).** `README.md` reconciled against the code: the brand-decision loop is now documented as **removed** (Phase A) — no `AWAITING_BRAND_DECISION` state, `BrandDecision` model, or approval magic-links; escalation is the one-way terminal `MANUAL_REVIEW` handoff with an idempotent brand notification, and the `/brand-decision/*` route (which doesn't exist in code) is dropped from the API table. The state machine is corrected to **16 states** (diagram edges + prose), the ORM to **Drizzle** (Prisma runtime removed, 21 migrations retained as SQL owner), the providers to **Ollama / Anthropic / DeepSeek / OpenRouter** (no OpenAI; hosted-prod path is OpenRouter-only), the intents to **six** (DEFERRED added, with routing), and the determinism claim scoped to Ollama-only (hosted providers use temp-0 + JSON-repair). The telemetry section now describes the live `LlmCall` pipeline + `/observability/llm` (no longer "no telemetry backend"), and the scheduler/persistence sections reflect the W-7 transaction + W-8 leader lock landed above. `.env.example` documents the new `SCHEDULER_LEADER_TTL_MS` and `AGENT_ENV` switches.

---

> **✅ Severity-2 sweep complete (2026-07-15).** All five items (W-6…W-10) are fixed, tested, and re-verified: **server 119/119**, **agent 430 passed / 5 skipped**, tsc clean (server + web), web production build green, and the three new integration suites (`stepCommit.atomicity`, `workflowSummary.scoping`, `leaderLock`) pass on PGlite + real migrations / a fake shared Redis. This clears the §11 path from **7/10 → 8/10** — the remaining gap to full autonomous operation is now alerting on the four signals already in code, not correctness or scale defects.
>
> *Independent review pass (same day):* every diff was checked against its finding and the README's claims were verified against the code (16 states, 11 tables, 21 migrations, zero `AWAITING_BRAND_DECISION`/`@prisma/client` hits, `DEFERRED` routed). Two gaps found and fixed during review: `injectReply` had the same W-7 crash window (now transactional, see the W-7 note) and one stale README status-table line ("decision expiry") survived the W-10 rewrite. All gates re-run green after both fixes.

### Severity 3 — real but tolerable for V1

- **W-11. Eval allowlist omission repeats a known bug class:** `agent/eval/scorer.py:20` and `dataset_500/validate.py:36` both lack `DEFERRED` — the newest intent has zero eval coverage, via the same omission pattern that caused the live DEFERRED outage.
- **W-12. Missed-send crash window:** a crash between `sendOnce`'s reserve and the actual send yields a permanently missed email (documented at `idempotentSend.ts:62-64`) with no repair job; the `OutboxJob` table that would fix this exists as a schema-only scaffold with zero producers/consumers (`schema.ts:367`).
- **W-13. Frontend duplication of engine truth:** the observability canvas hand-mirrors the transition table (`WorkflowCanvas.tsx:61-85`), and the `InstanceState` union is hardcoded in four places; drilldown truncates silently at `pageSize=200` while displaying `items.length` as the total (`NodeDrilldown.tsx:56-58`).
- **W-14. CI gaps:** no web job at all (no typecheck, no build, and the 22 web test cases run nowhere); the agent job pip-installs an ad-hoc dependency list instead of `requirements.txt`; the opt-in live-eval condition can never evaluate true.
- **W-15. Maintainability hot spot:** `negotiate.py` (3,582 lines) mixes five prompts, guard math, extraction heuristics, and routes; several heuristics carry eval-bank case IDs in comments/regexes (e.g., B-34, B-61) — a mild overfit signal and a refactor magnet.
- **W-16. Dead weight to sweep:** `OutboxJob`, `Message.senderEmail` (never written), `prisma.config.ts` (imports a nonexistent package), `BuilderCanvas.tsx` (153 lines, unreferenced), `updateCampaign` (no call sites — campaigns are uneditable after creation), the unreachable `GET /workflows/` route, stale Vite `/agent` proxy pointing at the wrong port, and OpenRouter missing from the telemetry price table so the one paid path used for evals reports `est_cost_usd=None` (`telemetry.py:68-84`).

---

## 7. Cloud Deployment Architecture

The code already assumes the right topology (one server image, three roles; a separate agent service; managed Postgres/Redis). A production deployment maps cleanly onto:

**Compute.**
- `api` (Express, 2+ replicas behind a load balancer), `worker` (BullMQ consumers, horizontally scaled, the only LLM-call originators besides inbound processing), `scheduler` (exactly one, with the leader lock from W-8) — all the same container on Railway / Fly.io / Render initially, ECS/Fargate or GKE later. Health endpoints exist (`/health` both services).
- `agent` (FastAPI + uvicorn) as a separate service, per the merge plan's M4 recommendation ("keep guard code byte-identical"). CPU-only is fine once inference is fully hosted (Anthropic/DeepSeek APIs); size the invoke pool to replica count.
- `web` — static `vite build` output on Vercel / Cloudflare Pages / S3+CloudFront. **Note:** this serving path exists nowhere today (no web service in compose, no nginx config); it must be created, along with an API base-URL configuration to replace the dev proxy.

**Data.**
- **Postgres:** Neon (already the dev target — serverless driver + `ws` are wired, `db/drizzle.ts:13-32`) or RDS. Point-in-time recovery on; the append-only `Event` table is the asset to protect — it *is* the money trail.
- **Redis:** Upstash or ElastiCache for BullMQ + locks. The merge doc already flags parent-prod Redis reachability as a launch blocker; treat Redis health as a first-class alert.
- **Blob storage:** S3/R2 for brief PDFs. Today uploads write to local disk (`server/uploads/`, `storage/localFileStorage.ts`) — this **does not survive container redeploys and cannot be shared across replicas**; the storage seam exists, so this is an adapter, not a redesign.

**Email.** Nylas (wired: send, threads, attachments, webhooks). Production needs: a dedicated sending domain per brand with SPF/DKIM/DMARC, gradual warm-up (the live tests already observed replies landing in spam), the webhook endpoint on a stable public URL with the HMAC secret set (verification is fail-closed), and `PAYMENT_BASE_URL` pointed at the public API host for the hosted payout form.

**LLM providers.** Anthropic (negotiation/classification) + DeepSeek (drafting) per the accepted plan, with the failover chain already supported per role. Operationally: provision Anthropic rate tiers ahead of volume, enable prompt caching (the ~315-line negotiation system prompt is static — caching cuts the dominant input-token cost dramatically), and add the missing price-table entries so `estCostUsd` stays truthful.

**Secrets.** Doppler / AWS Secrets Manager / platform-native env stores; rotate the keys currently sitting in the working-tree `.env` at cutover (MERGE_READINESS H5 already mandates this). CI gets least-privilege keys only.

**Observability stack.** Ship stdout JSON lines (`observability/logger.ts` already emits structured `[transition]`/`[metrics]` lines) to Axiom/Better Stack/Datadog; Sentry on all three Node roles + FastAPI; a scrape or push bridge from `/observability/metrics` and the agent's `/metrics` into Grafana/CloudWatch with four starter alerts — queue depth, stuck-instance count, circuit-breaker state, and daily `LlmCall` spend (the table already supports the query). Tracing (OTel) is a V2 nicety; the ALS attribution seam is where it would attach.

**CI/CD.** Fix the stale steps (W-1), add web typecheck+build+tests and a `docker build` job, then: merge to main → build image → run migrations via the existing `apply-migration.ts` runner (copy `prisma/migrations/` into the image — currently omitted) → deploy api/worker/scheduler → deploy agent → deploy web. Rate limiting at the edge (Cloudflare) in front of the api; the dashboard and internal API live behind the parent platform's auth perimeter (per the stated merge plan — not re-invented here).

**Backups & DR.** Neon PITR + nightly logical dumps; Redis is reconstructible (queues drain, reconciliation re-enqueues — a genuine architectural benefit: losing Redis loses schedule, not state); uploads bucket versioning; runbook drill: restore DB → replay reconciliation sweep → verify stuck-count returns to baseline.

**Environments.** dev (mock providers — enforced by the factory) → staging (real Nylas on a sandbox inbox, cheap LLM tier, seeded creators) → prod. The provider factory's fail-fast on unset `EMAIL_PROVIDER` and prod-mock warnings already encode this discipline.

---

## 8. Cost Analysis

**Grounding.** The one measured datapoint: the 30-case production-tier subset consumed ~26.0k input + ~10.6k output tokens and billed **$0.93 actual** (~$0.031/case) on Opus-class pricing (~$15/M input, ~$75/M output); the full-500 was estimated at $75+ (~$0.15/case with fuller conversations). DeepSeek drafting is ~$0.27/$1.10 per Mtok — roughly 50× cheaper per token than the negotiation path.

**Per-creator LLM model** (Opus negotiate/classify + DeepSeek draft, no prompt caching):

| Item | Est. cost |
|---|---|
| Outreach + follow-up drafts (DeepSeek) | ~$0.002 |
| Classification per reply (Opus, small prompt) | ~$0.02 |
| Negotiation round (Opus decision ~4k in/400 out + DeepSeek draft) | ~$0.07–0.10 |
| **Fully negotiated creator (3–4 rounds)** | **~$0.25–0.45** |
| **Blended per contacted creator** (30% reply, 60% of replies negotiate) | **~$0.06–0.12** |

Prompt caching on the static negotiation system prompt would cut the dominant input-token line by well over half; routing classification to Haiku-class would cut the classify line ~10×. Both are configuration-level changes the per-role provider routing already supports.

**Scenario A — Small (pilot): ~1,000 creators contacted/month**

| Category | Monthly |
|---|---|
| LLM (blended, incl. retries/evals headroom) | $75–150 |
| Compute (api+worker+scheduler+agent on Railway/Fly) | $40–80 |
| Postgres (Neon Launch) | $19–39 |
| Redis (Upstash pay-as-you-go) | $5–15 |
| Nylas (1–3 connected inboxes; platform minimums often dominate at this tier) | $50–300 |
| Blob storage + bandwidth + CDN | <$10 |
| Monitoring/logging (Sentry team + log free tiers) | $0–50 |
| Domain/SSL | ~$2 |
| **Total** | **≈ $200–650/mo** |

**Scenario B — Medium: ~10,000 creators contacted/month**

| Category | Monthly |
|---|---|
| LLM | $600–1,500 |
| Compute (2× api, 3–5 workers, agent ×2) | $150–400 |
| Postgres (Neon Scale / small RDS) | $70–250 |
| Redis | $30–100 |
| Email (Nylas multi-inbox + deliverability/warm-up tooling) | $300–800 |
| Monitoring/logging | $100–250 |
| **Total** | **≈ $1,300–3,300/mo** |

**Scenario C — Large: ~100,000 creators contacted/month**

| Category | Monthly |
|---|---|
| LLM (with prompt caching + Haiku classification — otherwise 2–3×) | $5,000–12,000 |
| Compute (worker fleet, agent fleet, LB) | $600–1,500 |
| Postgres (partitioned events, read replica) | $400–1,200 |
| Redis | $100–300 |
| Email (multiple domains/IPs, warm-up, verification tooling) | $1,500–4,000 |
| Monitoring/logging/tracing | $400–1,000 |
| **Total** | **≈ $8,000–20,000/mo** |

**What drives cost:** overwhelmingly Opus input tokens on the negotiation path — the static system prompt is resent every round and conversation history grows per round. Reply rate and rounds-per-negotiation are the business multipliers. The `LlmCall` table means actual spend is queryable per instance/role/model from day one — an unusually good position for cost governance; extend the estimator's price table (W-16) so the numbers stay honest.

---

## 9. Scaling Analysis

**100 creators (pilot).** Trivial everywhere. Latency is the only observable: 5–11 s/decision on the production tier (measured), so a reply-to-response cycle of ~15–30 s including drafting. Single worker, single agent replica, one Nylas inbox.

**1,000 creators.** Comfortable. Throughput math: worker concurrency 5 × ~10 s/LLM step ≈ 30 negotiation steps/min sustained — far above need. The poller's 200-instance batch per 30 s tick (= 400/min) handles follow-up bursts. The agent's 16-thread invoke pool exceeds worker demand. Watch: the dashboard's full-scan summary query is already doing thousands of row-reads per 6 s poll, and Nylas inbox sending volume starts to matter for reputation.

**10,000 creators.** Three things break, in order:
1. **Observability queries (W-6)** — ~10k instances × ~10 transition events loaded into memory per dashboard poll saturates the DB long before the workflow engine feels anything. Must move to SQL aggregates.
2. **Email deliverability** — 10k outreach/mo from effectively one identity: needs multiple domains, warm-up, and bounce/complaint handling (no bounce processing exists today — only replies and opt-outs).
3. **Agent horizontal scaling** — the in-process rate limiter and pool (W-9/H4) mean replicas don't share budgets; fine to ~2–3 replicas, then needs a shared store.
The engine itself holds: OCC contention is per-instance (negligible), BullMQ handles this volume trivially, Neon with the `(currentState, dueAt)` index stays index-backed on the hot paths.

**100,000 creators.** Redesign-level pressure points:
- **Scheduler:** a single 30 s/200-batch poller caps due-processing at ~24k/hour and is a single point of failure — needs sharded pollers or a DB-native job queue (pg-boss/graphile-worker) with real leader election.
- **Event table:** append-only growth (~10–20 events/instance) reaches tens of millions of rows/quarter — needs partitioning + archival; per-instance fee-replay stays bounded, but analytics queries move to a warehouse.
- **LLM:** ~50–80k Opus decisions/mo is well within API capacity at enterprise tiers, but cost forces the caching/routing work of §8; the per-role provider abstraction makes this configuration, not code.
- **Email:** 3–5k sends/day is dedicated-infrastructure territory (multiple ESP identities, suppression lists, compliance tooling) — the `IEmailProvider` seam is the insertion point.
- **Parallelism correctness holds:** OCC + fencing locks + idempotency keys are exactly the primitives that survive a 100× fleet; that layer was built right the first time.

---

## 10. Future Evolution

**V2 (post-pilot, months 1–3).** Operational closure of §6: transactional step commits, FOLLOWED_UP reconciliation, `dueAt` hygiene + mid-negotiation nudges, leader-locked scheduler, aggregate observability queries with a workflow selector, gated queue endpoints, blob storage, the README rewrite, CI completion. Product-side: the three parked founder decisions (structural-term escalation policy — the only recurring production-tier failure pattern, 4/30 subset cases; max-rounds semantics under the LLM strategy; utility-curve concessions), plus an operator "resume from MANUAL_REVIEW" action so the terminal handoff has an in-product return path. Activate the `OutboxJob` scaffold to close the missed-send window. None of this touches the architecture.

**V3 (product expansion, months 3–9).** Branching workflows — the builder already models graphs and validates phase ordering; the engine's linear-order execution (`graphNav.ts:10-14`) is the deliberate simplification to replace, and immutable versioning means old instances are unaffected. Multi-tenancy (merge milestone M2) — campaign-scoped data isolation. Attachment-aware inbound (H9). Draft-quality grading loops on the DeepSeek path (flagged in the eval reports as never yet graded). A prompt-management story that moves the five prompts out of `negotiate.py` into versioned artifacts with per-version eval runs — the prompt-versioning and `LlmCall.promptVersion` plumbing already exists to support exactly this.

**Enterprise scale.** What survives unchanged, by design: the event-sourced money trail, OCC + idempotency correctness layer, the guard stack, provider seams, the eval methodology, and the three-role process topology. What gets replaced: the in-process scheduler (→ real job orchestration), in-memory observability (→ aggregates/warehouse), single-inbox email (→ sending fleet), hand-mirrored frontend types (→ codegen from DTOs), and the agent's per-process state (→ shared budgets/limits). The honest summary: **the correctness core was built to outlive the prototype; the operational shell was built to be replaced** — which is the right trade for a V1.

---

## 11. Final Assessment

**Would I ship this as a founding engineer?** As a supervised pilot — yes, this week, after W-1/W-4/W-5 (roughly two days of work: fix the build, gate the queue endpoints, fix the Python packaging). The AI layer has been adversarially tested beyond what most seed-stage systems ever attempt, and every dangerous path ends at a human. As unattended production — not yet: W-2/W-3 mean creators can silently stall mid-funnel, and no one would know because alerting doesn't exist yet.

**Confident deploying to early customers?** Yes, with a human on the Manual Queue — which is precisely the deployment mode the team's own `FOUNDER_PROD_READINESS_QUESTIONS.md` puts first (Q1: supervised pilot vs autonomous). The system's failure economics are favorable: its worst realistic failures are a missed follow-up or an unnecessary escalation, not a bad deal. The false-acceptance, band-leak, and over-pay classes — the failures that cost real money — are each blocked by multiple independent, tested layers.

**How impressed am I?** Considerably, and specifically. Three things stand out as genuinely above-bar: (1) the **money-path guard stack** — the allowlist-only dollar rule, word-number matching, and guards-changed-drop-the-draft are the marks of a team that thought adversarially about its own model; (2) the **evaluation infrastructure** — a 500-case machine-asserted dataset that demonstrably drove fixes, a cost-modeled production-tier subset, and CI tripwires, at a stage when most startups have zero evals; (3) the **degradation discipline** — circuit breaker → MANUAL_REVIEW → brand notification is wired end-to-end and trap-tested on both sides of the HTTP seam. The reply-loss engineering and the enum-derived allowlist fix (structural prevention of a bug that actually happened) show the same maturity.

**Does it achieve the V1 vision?** Yes. Every stated scope item — AI outreach, classification, negotiation, drafting, state management, escalation, complete workflow execution — is implemented, tested, and has been exercised live end-to-end (all six founder-alignment phases verified with real email, per `MERGE_READINESS.md` §2.2). The founders' 15 decisions are traceable from spec to code to trap test, with the three open items explicitly tracked rather than forgotten — that traceability is itself rare.

**What should be prioritized after launch?**
1. The Severity-1 list (§6 W-1…W-5) — days, not weeks.
2. Alerting on the four signals that already exist in code (queue depth, stuck count, breaker state, daily LLM spend).
3. The structural-term escalation policy decision — the single remaining production-tier failure pattern.
4. Observability aggregates + workflow scoping (W-6) before the second concurrent campaign.
5. One real supervised campaign as the final sign-off — the team's own testing docs correctly identify this as the missing artifact.

**Final recommendation: CONDITIONAL GO.** Approve for a supervised production pilot upon completion of the Severity-1 fixes; hold autonomous operation until the Severity-2 list and alerting land. The intelligence and safety layers of this system are ahead of its operational shell — an inversion of the usual startup failure mode, and the easier half to finish. **Production score: 6.5/10 today; a focused two weeks takes it to 8.**

> **✅ Update (2026-07-15): the condition is met.** All five Severity-1 fixes landed and were independently re-verified (suites 116/116 and 421-pass green, tsc clean, packaging resolves, injection surface gated — see the status block in §1 and the ✅ notes in §6). **Supervised pilot: GO. Effective score: 7/10.** The path to 8 is now the Severity-2 list (transactional step commits, observability aggregates + workflow scoping, scheduler leader lock, agent hardening) plus alerting and the W-16 OpenRouter price-table entry so cost telemetry isn't blind on the chosen provider.

> **✅ Update 2 (2026-07-15): Severity-2 cleared.** W-6…W-10 landed and were verified the same day — server **119/119** (three new test suites: version-scoping, step-commit atomicity, leader election), agent **430 passed / 5 skipped** (nine new hardening tests), `tsc` clean in both workspaces; see the ✅ notes in §6 for the per-item evidence. Of the path-to-8 list above, everything code-shaped is done; what now stands between the pilot and an 8 is **alerting** on the four signals that already exist in code, **durable blob storage** for uploads, the **W-16 OpenRouter price-table entry**, and **one real supervised campaign** as the final sign-off.

---

*Report generated from full-repository review on 2026-07-14. File citations reference the working tree at commit `91013da` plus uncommitted HARD-O1 telemetry work. This document is intended as permanent technical documentation: onboarding material for engineers, a diligence artifact for investors, and a prioritized worklist for the founding team.*
