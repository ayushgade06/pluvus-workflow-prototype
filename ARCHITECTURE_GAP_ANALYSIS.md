# Pluvus Workflow Platform — Staff-Engineer Architecture & Product Gap Analysis

> Deep architecture and product gap analysis of the `pluvus-workflow-proto` repository,
> written from the perspective of a Staff Engineer responsible for evolving this prototype
> into a **production-grade autonomous workflow execution engine for creator outreach and
> negotiations** over the next 2–3 years.
>
> This is **not** a code-quality or bug review. It maps the distance between *what the
> prototype has proven* and *what the production vision requires*, and sequences that
> distance by architectural leverage.
>
> _Analysis date: 2026-07-01. Reflects the codebase through Phase 12 (brand description)._

---

## Target vision (the flow being built toward)

```
Campaign → Workflow → Outreach → Reply Classification → Negotiation
        → Approval → Onboarding → Campaign Execution
```

The product should become an **autonomous workflow execution engine** for creator outreach
and negotiations.

---

## Author's framing

This repository is an exceptionally clean *validation harness*. It deliberately proves the
hard execution bets — instance-as-unit, event-driven advancement, queue-as-seam, OCC
correctness, bounded AI, snapshot versioning — on mocks before promotion. The code quality
of what exists is high, and many "gaps" below are **intentional scope cuts** the team
already documented as non-goals (see `.claude/docs/source-of-truth.md` §2 and
`.claude/docs/open-questions.md`).

The job here is not to fault the prototype for being a prototype. It is to map the distance
between *what was proven* and *what an autonomous workflow execution engine must become*,
and to sequence that distance by architectural leverage.

The single most important finding, stated up front so everything else has context:

> **The current engine is structurally a hardcoded, linear, single-tenant, six-node state
> machine.** The "workflow" is a JSON `nodeGraph` snapshot, but the FSM, the node-type set,
> the dispatch switch, the transition table, and the routing logic are all *compile-time
> constants shared by every workflow*. To reach the vision, the platform must cross one
> architectural chasm before almost anything else matters: **the workflow definition must
> become data the engine interprets, not code the engine hardcodes.** Roughly 60% of the
> high-value items below are blocked on, or dramatically cheapened by, that one transition.

---

## How to read each item

Every suggestion carries: **Why it matters · Current limitation (with evidence) · Proposed
solution · Priority · Complexity · Now vs. Deferred.**

- **Priorities** (P0/P1/P2) are relative to *the production vision*, not the prototype's
  success criteria.
- **Complexity** is S / M / L / XL (engineer-weeks order of magnitude: S ≈ <1, M ≈ 1–3,
  L ≈ 4–8, XL ≈ a quarter+).

---

## 1. Workflow Engine

The foundational chasm lives here.

### 1.1 — Data-driven node graph & generic node runtime (the keystone)

- **Why it matters.** The vision ("autonomous workflow execution engine") *is* a generic
  engine. Today there is no engine — there is a hardcoded pipeline. Adding a *single* new
  node type ("Onboarding," "Reward Setup," "Contract Sign") today requires editing the
  enum, the dispatch switch, the transition table, and writing an executor — a code change
  and redeploy, not a config change.
- **Current limitation.** `runtime.dispatch()` is a `switch` over six literal node types
  (`server/src/engine/runtime.ts:318-337`, throws on unknown); the transition table is a
  compile-time constant identical for every workflow
  (`server/src/engine/stateMachine.ts:7-20`); navigation is `order + 1` integer stepping
  inside each executor (`importCreatorList.ts:19`, `initialOutreach.ts:44`,
  `replyDetection.ts:102`). `NodeSnapshot.type` is a free string but only six values
  dispatch; the declared `NodeType` enum isn't even used to validate graphs
  (`server/src/engine/types.ts:10-15`). The graph is linear-only with no edge model —
  "branching" is implicit and hardcoded inside executors. The state machine is global, not
  per-workflow.
- **Proposed solution.** Introduce a **node-type registry** and a **per-node-type contract**
  (`input`, `output`, `execute(ctx) → NodeResult`, `validate(config)`). The
  `WorkflowVersion.nodeGraph` becomes an interpreted DAG: nodes carry typed `edges` (with
  optional conditions), not just `order`. Move the state machine from a global enum table to
  **per-instance progress through the graph**, where "legal transition" means "an edge
  exists from the current node." Replace the `InstanceState` enum-as-FSM with `currentNodeId`
  + a small set of *node-lifecycle* states (`PENDING / RUNNING / WAITING / DONE / FAILED`)
  that are node-agnostic; the *business* states (NEGOTIATING, ACCEPTED…) become node
  *outputs/labels*, not engine primitives. This is the difference between Temporal/n8n
  (interpret a graph) and the current design (run a fixed program).
- **Priority: P0. Complexity: XL. Now.** Nothing else in the "platform" vision is reachable
  without it; every quarter it's deferred, more executor logic hardcodes assumptions that
  must later be unwound.

### 1.2 — Conditional branching & dynamic routing (DAG, not line)

- **Why it matters.** Real outreach is not linear: "if creator is high-tier → premium
  negotiation track; if low-confidence reply → human review then re-enter; if accepted →
  onboarding subflow." The source-of-truth even names this ("explicit pauses, skips, and
  exits") and the team explicitly deferred branching authoring as a *prototype* non-goal —
  correct then, mandatory now.
- **Current limitation.** No edge/condition model exists in the data layer (no DAG, no
  conditional edges, no parallel paths). Branching is buried in executor `switch` statements
  and not author-editable or visualizable.
- **Proposed solution.** Edge model with conditions evaluated against instance context +
  node outputs (see expression engine, §3.2). Routing becomes: node returns a labeled
  outcome → engine selects the matching outgoing edge. A natural consequence of 1.1.
- **Priority: P0. Complexity: L (on top of 1.1). Now (co-designed with 1.1).**

### 1.3 — Human-approval & manual-intervention nodes as first-class

- **Why it matters.** The vision flow has an explicit **Approval** stage. Today "approval"
  and "manual review" are *terminal dead-ends*, not resumable nodes.
- **Current limitation.** `MANUAL_REVIEW` is modeled as **terminal** — the transition table
  gives it no outgoing edges (`stateMachine.ts:19`), and no code path re-routes it. A human
  can be notified (`server/src/notifications/escalation.ts`) but cannot *resolve* the
  instance back into the flow. There is no approve/reject/resume action; `approvalMode:
  auto/manual` exists in the negotiation config UI (`NodeConfigPanel.tsx`) but no executor
  reads it.
- **Proposed solution.** A generic **Wait-for-Human** node type: it parks the instance in
  `WAITING`, emits a task to a work-queue, and exposes resume actions (`approve` / `reject` /
  `edit-and-continue` / `reroute-to-node`) that re-enter the graph. The existing Manual Queue
  UI becomes the front end for it.
- **Priority: P0. Complexity: M. Now** — it's the missing half of the product flow, and it's
  small once 1.1 exists (it's "just another node type").

### 1.4 — Timeouts, delayed execution, scheduled nodes, looping

- **Why it matters.** Autonomous execution needs per-node SLAs ("if no negotiation movement
  in 7 days, escalate"), scheduled sends ("send onboarding Monday 9am creator-local"), and
  bounded loops as configuration not code.
- **Current limitation.** The *only* timer is the follow-up `dueAt` poll
  (`server/src/scheduler/poller.ts`, `server/src/db/instances.ts:120-130`); it's hardcoded
  to two states. Loops (follow-up `maxCount`, negotiation `maxRounds`) are hardcoded counter
  logic inside two executors (`followUp.ts:25`, `negotiation.ts:65`), not a general loop
  primitive. No node-level timeout, no scheduled/cron node, no calendar-aware send.
- **Proposed solution.** Generalize `dueAt` into a **timer subsystem** keyed by (instanceId,
  nodeId, purpose) so any node can arm a timer; add a `Timer`/`ScheduledAction` table (§6).
  Make loop bounds and timeouts node config interpreted by the generic runtime. Add a
  scheduled-node type.
- **Priority: P1. Complexity: L. Now-ish** (land the timer table with 1.1's schema work to
  avoid a later migration).

### 1.5 — Retry strategies, rollbacks, compensation (Saga)

- **Why it matters.** Autonomous money-adjacent workflows (onboarding, contract, reward
  setup — all in the vision) need compensation: if step 5 fails after step 4 sent an
  email/created a record, you need a defined undo or a safe park. Production reliability for
  "tens of thousands daily" demands per-node retry policy.
- **Current limitation.** Retries exist only at the *BullMQ job* level (3 attempts,
  exponential — `server/src/workers/queues.ts:17-27`), uniform across all node types, with
  **no DLQ** (failed handlers only log — `nodeExecutionWorker.ts:147-152`). No
  compensation/rollback concept anywhere. Events are append-only audit, never replayed to
  reconstruct or undo.
- **Proposed solution.** Per-node-type retry policy in config; a Saga/compensation hook
  (`compensate(ctx)`) on node contracts; a DLQ queue with operator tooling. (Rollback in an
  email-sending system is mostly *forward compensation* — send a correction, mark a record
  void — so design it as compensating actions, not literal undo.)
- **Priority: P1 (retry policy + DLQ), P2 (full compensation). Complexity: M / L. Now** for
  DLQ; **defer** compensation until post-negotiation nodes exist.

### 1.6 — Versioning improvements: migration & sequence-level controls

- **Why it matters.** Snapshot versioning works (validated), but the *promotion* path —
  migrating in-flight instances to a new version — was explicitly stubbed-only. And the
  source-of-truth's "sequence-level vs node-level controls" distinction (§4) isn't
  implemented: there are no workflow-level rulesets (global quiet hours, global stop-rules,
  global rate caps).
- **Current limitation.** No instance-migration mechanism. No sequence-level config object —
  only per-node config. `Workflow.draftNodes` handles drafts well, but there's no version
  diff/compare.
- **Proposed solution.** Explicit, opt-in instance migration with a mapping function (old
  node → new node). A `Workflow.settings` JSON for sequence-level controls the engine reads
  alongside node config. Version diff endpoint.
- **Priority: P2. Complexity: M. Defer** migration; **now** add the `settings` field with
  1.1's schema work.

---

## 2. AI Layer

The AI layer is deliberately a **thin, stateless, auditable intent-classifier +
rate-extractor** with deterministic money logic in Python/TS (`_decide_action` in
`agent/app/routes/negotiate.py`). An excellent, safe foundation — but greenfield on
everything the vision needs for multi-model production.

### 2.1 — Provider abstraction, multi-model, routing & OpenRouter

- **Why it matters.** Use the latest, most capable Claude models for hard negotiation; cheap
  local models for trivial classification. Cost and quality both demand per-task model
  selection. Today you cannot use Claude/Anthropic at all.
- **Current limitation.** Exactly **two providers** hardcoded — Ollama and OpenAI
  (`agent/app/llm.py:92-95`). Provider is **global env-only** (`LLM_PROVIDER`), not per-task;
  the only per-task variation is *temperature*. **No OpenRouter, no Anthropic, no Gemini**
  (grep: zero hits). No model registry, no per-request model. `ChatOpenAI` is built with no
  `base_url` (`llm.py:85-89`).
- **Proposed solution.** A provider/model **router** keyed by task + difficulty + cost
  budget. Add an OpenRouter/Anthropic-compatible factory (a `base_url` + factory addition).
  Model choice becomes part of node config ("Negotiation node uses `claude-opus-4-8`;
  Classify uses local qwen"). Wiring Anthropic is high-leverage for nuanced negotiation.
- **Priority: P1. Complexity: M. Now** — cheap relative to its leverage, and the abstraction
  seam (`get_llm`) already exists to extend.

### 2.2 — AI observability: token usage, cost, prompt versioning, decision logging

- **Why it matters.** You cannot run AI at scale blind to cost. You cannot debug a bad
  negotiation without knowing *which prompt + which model* produced it. Both are absent.
- **Current limitation.** **No token counting, no cost accounting anywhere** (grep: zero).
  `response_metadata`/`usage_metadata` never read (`agent/app/structured.py:79-80` reads only
  `.content`). **No prompt versioning** — prompts are inline string constants with no version
  tag. **No LangSmith/OTel tracing.** The DB records *intent/confidence/action* but not the
  model's raw output, token usage, prompt version, or which model produced it.
- **Proposed solution.** Capture `usage_metadata` on every call; persist `{model,
  promptVersion, inputTokens, outputTokens, costUsd, latencyMs}` onto an `AiCall`/`Event`
  record. Version prompts (hash + semantic tag) and stamp the version onto every decision
  event. Wire LangSmith or OTel for traces.
- **Priority: P0 (a production-readiness gate, not a nicety). Complexity: M. Now.**

### 2.3 — AI evaluations for negotiation & draft (not just classification)

- **Why it matters.** The negotiation `_decide_action` and draft quality are the
  *commercially risky* AI surfaces, and they have **no eval harness** — only unit tests on
  fixed inputs. Classification has a real (if small, 34-case synthetic) eval + CI gate;
  negotiation/draft have none.
- **Current limitation.** No eval set, scorer, or gate for the negotiation decision or draft
  quality. Classification eval is honest about being a "tripwire, not an accuracy claim" on
  synthetic data.
- **Proposed solution.** Labeled negotiation-trajectory eval set (real anonymized threads)
  scoring accept/counter/escalate correctness and floor/ceiling adherence; an LLM-judge for
  draft quality (tone, no-leak, personalization). Grow the classification set toward the
  stated ~500 real-reply target. Gate CI on all three.
- **Priority: P1. Complexity: L. Now-ish** — needs real data, so start the data-collection
  pipeline now.

### 2.4 — Confidence calibration & memory between nodes

- **Why it matters.** Confidence drives the manual-review gate (the autonomy/cost dial), but
  it's largely hardcoded heuristics (OPT_OUT→1.0, etc.), and the LLM-supplied number is
  uncalibrated. "Memory between workflow nodes" — a creator's full relationship history
  informing later drafts — is reconstructed ad hoc per call from events, not a first-class
  context store.
- **Current limitation.** Confidence: model number is clamped then thresholded but not
  calibrated. Memory: no LangGraph checkpointer; cross-turn context is rebuilt by TS from
  `NEGOTIATION_TURN` events each call (the right place for it, but negotiation-only and not
  generalized).
- **Proposed solution.** Calibrate confidence against the eval set (reliability curve).
  Generalize "memory" into an **instance context store** the engine assembles and passes to
  every AI node (creator profile + full message history + prior outcomes + campaign brand
  voice), so any node gets relationship-aware context.
- **Priority: P2. Complexity: M. Defer** calibration until eval data exists; **now**
  generalize the context-assembly seam.

---

## 3. Workflow Builder

The builder is a **guided linear config editor**, not a graph builder. Correct for the
prototype. To "feel like n8n/Temporal/Langflow," it needs the data-driven engine (§1.1)
underneath first — you can't build a DAG editor over a fixed pipeline.

### 3.1 — True graph authoring (nodes, connections, branches, palette)

- **Why it matters.** This *is* the product surface for "workflow orchestration platform."
- **Current limitation.** No node creation (no palette/add-button). No connecting (React Flow
  is `nodesConnectable={false}`, `nodesDraggable={false}`, handles `opacity:0` —
  `web/src/components/builder/BuilderCanvas.tsx:62,115-116`, `BuilderNode.tsx:63-64`). Edges
  auto-derived from sort order. No branches. Reorder + per-node config + publish is the whole
  surface.
- **Proposed solution.** Unlock React Flow into a real editor: palette of registered node
  types (from the §1.1 registry), drag-to-create, draw edges, branch nodes. The front end
  already uses React Flow, so the substrate is present — it's deliberately locked, not absent.
- **Priority: P1. Complexity: L. After 1.1.**

### 3.2 — Variables, expressions, reusable subflows, templates

- **Why it matters.** Differentiates a config form from an automation platform. Conditions
  (§1.2) *need* an expression layer.
- **Current limitation.** "Variables/expressions" today = `{{creatorName}}`/`{{brandName}}`
  string interpolation only (`NodeConfigPanel.tsx:285-286`); no expression engine. Templates
  exist but are **3 hardcoded presets** chosen at creation, not user-authorable
  (`server/src/templates/index.ts`). No subflows. (Notably, templates seed **5 nodes**, not
  the documented 6 — `IMPORT_CREATOR_LIST` is omitted from all three templates.)
- **Proposed solution.** A safe expression engine (sandboxed, e.g. JSONLogic or a restricted
  JMESPath) over instance context for conditions and field interpolation; named workflow
  variables; user-saved templates; reusable subflows (a node that embeds another workflow —
  onboarding becomes a subflow).
- **Priority: P1 (expressions), P2 (subflows/templates). Complexity: L. With 1.2.**

### 3.3 — Test/simulation/debug, live preview, version compare

- **Why it matters.** Authors must validate a workflow before launching it at real creators
  (who receive real emails — the Launch tab already warns about this). Without simulation,
  every change is tested in production.
- **Current limitation.** No in-UI test/sim/debug — only an offline server-side Node harness
  (`server/src/observability/harness.ts`). Validation exists but is structural only
  (`validateNodeGraph` — array/types/unique-order/must-have-outreach+end; no
  branch/reachability/config-completeness validation). No version diff.
- **Proposed solution.** A **dry-run/simulation mode**: execute a workflow against a synthetic
  creator with mock providers, step-through with breakpoints, showing state at each node —
  promote the existing harness into an API-driven simulator the UI drives.
  Reachability/dead-node validation. Version diff view.
- **Priority: P1 (simulation), P2 (breakpoints/diff). Complexity: L. After 1.1**, but high
  product value.

---

## 4. Execution Engine (production capabilities)

This is where "tens of thousands of executions daily" lives. The correctness core (OCC +
idempotency + lock) is genuinely solid and validated. The *operational* layer is
prototype-grade by design.

### 4.1 — Tier separation & horizontal worker scaling

- **Why it matters.** Throughput, blast-radius isolation, independent scaling.
- **Current limitation.** **API + both workers + scheduler all run in one process**
  (`server/src/index.ts:92-95`). Worker concurrency is a **hardcoded `5`**, not env-tunable
  (`nodeExecutionWorker.ts:135`, `inboundEmailWorker.ts:153`). No clustering. Single-process
  was an *intentional* prototype choice (open-questions §8).
- **Proposed solution.** Split API and worker into separate deployables sharing the engine
  library; make concurrency configurable; run N worker replicas (BullMQ supports this
  natively — the OCC + lock design already makes it safe, which is the whole point of having
  validated them).
- **Priority: P0. Complexity: M. Now** — mostly packaging/config, and the correctness work
  that makes it safe is *already done*.

### 4.2 — Distributed scheduler (leader election)

- **Why it matters.** With multiple processes, the in-process `setInterval` poller runs in
  *every* replica, each fetching *all* due instances every tick (`poller.ts`,
  `listDueInstances` has no `take` limit).
- **Current limitation.** Single in-process poller, no leader election. Dedup via jobId saves
  correctness but every replica still does the full DB scan — wasteful and unscalable.
- **Proposed solution.** BullMQ **repeatable jobs** or a single leader-elected scheduler;
  bound the due-query with `take` + cursor pagination.
- **Priority: P1. Complexity: M. With 4.1** (the same change).

### 4.3 — DLQ, job priorities, queue partitioning, rate limiting

- **Why it matters.** Operability at scale: prioritize a paying customer's launch over a
  backfill; isolate a noisy tenant; recover poison messages; cap outbound email rate
  (deliverability + provider limits).
- **Current limitation.** **No DLQ** (failed jobs just log + retain last 100). **No
  priorities** (no `priority` set anywhere). **No partitioning** (two static functional
  queues). **No rate limiting** on outbound Nylas sends. The `/queues/jobs` route is
  read-only (no retry/promote/delete).
- **Proposed solution.** DLQ queue + operator retry/replay tooling; BullMQ job priorities;
  per-tenant queue partitioning or a rate-limiter group; BullMQ rate limiter on the email
  path.
- **Priority: P0 (DLQ + rate limiting), P1 (priorities/partitioning). Complexity: M. Now**
  for DLQ + email rate-limit.

### 4.4 — Crash recovery / reconciliation sweeper

- **Why it matters.** This is a **silent-data-loss class bug** at scale, not a feature gap.
- **Current limitation.** Instances that end a step in a **non-due, non-terminal state with
  no outstanding job** (`REPLY_RECEIVED`, `NEGOTIATING`, `OUTREACH_SENT`) are **never swept**
  — nothing re-enqueues them. The scheduler only looks at `AWAITING_REPLY`/`FOLLOWED_UP`. A
  crash between auto-chain enqueue and worker pickup, or a dropped job, strands the instance
  forever. The Redis lock can also orphan for up to 30s (no fencing, unconditional `del`
  release — `server/src/scheduler/lock.ts:61-64`).
- **Proposed solution.** A **reconciliation sweeper**: periodically find non-terminal
  instances with no in-flight job and no future `dueAt`, beyond a grace window, and
  re-enqueue or flag them. Add fencing tokens to the lock (or accept OCC as the sole
  guarantee and treat the lock as pure optimization — already its documented role).
- **Priority: P0. Complexity: M. Now** — cheap insurance against unbounded silent loss.

### 4.5 — Cancellation, pause/resume, replay/backfill

- **Why it matters.** "Stop this campaign now," "pause while we fix a bad template," "replay
  last week's negotiations against the new model," "backfill onboarding for already-accepted
  creators."
- **Current limitation.** **All missing:** no cancel, no pause/resume, no replay, no backfill.
  (`FOLLOW_UP_CANCELLED` is just an event label, not a mechanism.)
- **Proposed solution.** Instance/campaign cancel (terminal `CANCELLED` + queue purge); pause
  (BullMQ `queue.pause()` + instance pause flag); replay from the append-only `Event` log
  (which already exists for audit — this is where event-sourcing leverage pays off, §6);
  backfill as a bulk-enrollment job.
- **Priority: P1. Complexity: M–L. Now** for cancel/pause; **defer** replay/backfill.

---

## 5. Observability

Per-instance *inspection* is strong (canvas, timeline, message thread, AI-decision view,
transition trace with source/worker/jobId attribution). **Aggregate operational and business
dashboards are entirely absent** — and the team scoped analytics as a non-goal, correctly
for then.

- **What EXISTS:** per-state counts, `avgTimeInStateSeconds`, stuck-instance flagging
  (waiting + `dueAt` >1h), per-instance drilldown, AI decisions, logs trace.
- **What's MISSING:** **AI token usage, AI cost, node execution duration** (only
  state-residency time exists, not executor runtime), **queue latency** (raw BullMQ counts
  exist but no metric/dashboard), **failure-rate aggregates**, **negotiation funnel /
  conversion rate**, **creator-journey analytics**. No metrics store, no Prometheus/OTel, no
  time-series.

- **Why it matters.** You cannot operate or optimize at scale without these. Cost dashboards
  gate AI spend; funnel/conversion dashboards are the *product's headline value* ("where is
  each creator"); failure heatmaps + queue latency are the on-call surface.
- **Proposed solution.** Emit metrics to a time-series backend (Prometheus/OTel + Grafana, or
  a metrics table for in-app dashboards). Build: **Negotiation funnel**
  (enrolled→outreach→reply→negotiating→accepted with rates), **AI cost/token** (from §2.2),
  **node duration + queue latency**, **failure heatmap by node/tenant**, **creator-journey**
  view. The append-only `Event` log already holds most of the raw material.
- **Priority: P1 (funnel/conversion + cost are near-P0 for a SaaS), P2 (heatmaps).
  Complexity: L. Now** for cost (pairs with 2.2) and funnel.

---

## 6. Data Model

The definition/execution split is excellent and the audit `Event` log is a strong
foundation. The gaps are about **multi-tenancy, the graph-as-data, and turning the audit log
into a real event-sourcing substrate.**

### 6.1 — Tenancy & identity entities (see also §10)

- **Missing entities:** `Organization`/`Workspace`, `User`, `Membership`, `Role`, `ApiKey`,
  `Session`. The schema has **8 models, zero tenant scoping** — `Campaign` is the unowned
  root. This blocks SaaS entirely.
- **Priority: P0. Complexity: L (schema) + XL (retrofitting every query with tenant scope).
  Now** — the longer the schema lives untenanted, the more expensive the retrofit.

### 6.2 — Graph/edge entities & node-type registry table

- **Missing:** node, edge, and node-type-definition tables (the graph is opaque JSON; no
  referential integrity on node references — `currentNodeId` is a free string, `Event.nodeId`
  has no FK). This is the data side of §1.1. Keeping the *version snapshot* as JSON is fine
  (immutability), but the *node-type catalog* and *draft graph* benefit from structure.
- **Priority: P0 (with 1.1). Complexity: M. Now.**

### 6.3 — Event sourcing, analytics tables, richer audit

- **Why it matters.** Replay (§4.5), backfill, time-travel debugging, and analytics all want
  the `Event` log promoted from "audit nicety" to "first-class projection source."
- **Current limitation.** `Event` is append-only audit but **never the system of record and
  never replayed** (an intentional prototype choice, open-questions §3). No analytics/rollup
  tables. No `AiCall` table (token/cost/prompt-version — §2.2). No `Timer`/`ScheduledAction`
  table (§1.4). No `Task`/`HumanTask` table (§1.3). Audit lacks *who* (no actor — because no
  users).
- **Proposed solution.** Add `AiCall`, `Timer`, `HumanTask` tables. Build read-model
  **projections** off the event stream for analytics (CQRS-lite). Add actor/tenant to events.
  Don't go full event-sourcing-as-primary-store (open-questions §3 rightly rejected that) —
  but make projections a real pattern.
- **Priority: P1. Complexity: L. Now** for the new tables (avoid later migrations); **defer**
  full projection infra.

---

## 7. Product Features (SaaS expectations)

All absent today (appropriate for a prototype). Ranked by what customers gate adoption on:

- **Multi-tenancy + permissions + team collaboration** — **P0** (table stakes; see §6.1,
  §10). No user/team/role model exists.
- **Environments (draft/staging/prod) + workflow approval-to-publish** — **P1**.
  `DRAFT/PUBLISHED/ARCHIVED` status exists but no environment promotion or publish-approval
  gate.
- **Import/export + workflow sharing + marketplace** — **P2**. No serialization endpoints;
  templates are hardcoded.
- **Billing/usage metrics** — **P1**. **Nothing** tracks usage for billing (no per-tenant
  counters, no metering). Pairs with §2.2 cost and §5 metrics.
- **Audit history (user-facing)** — **P1**. The `Event` log exists but has no actor and isn't
  surfaced as a user-facing audit trail.
- **Draft workflows** — ✅ partially exists (`Workflow.draftNodes`).

**Complexity: L–XL collectively. Now** for tenancy; rest **deferred** behind it.

---

## 8. Developer Experience (extensibility SDKs)

Nothing here exists yet, and it's correctly the *last* layer — but it's the long-term moat.

- **Custom Node SDK / Provider SDK / Trigger SDK** — the §1.1 node-type registry *is* the
  foundation; once nodes are pluggable, an SDK to author them externally follows. **P2. L.
  Defer** until the registry (1.1) and a stable node contract exist.
- **CLI + testing framework + local simulator / mock execution** — the simulation work
  (§3.3) and harnesses are the seed of a local simulator; promote them. **P2. M. Defer.**

These should be designed *as a consequence* of 1.1's contracts, not before — building an SDK
over a hardcoded engine would be wasted.

---

## 9. Architecture (structural)

- **Event-driven design** — ✅ already the core strength (queue-as-seam, validated). Keep.
- **CQRS / event sourcing** — **introduce CQRS-lite** (read-model projections off the `Event`
  log for observability/analytics — §6.3), but **do not** make events the primary write store
  (open-questions §3 correctly rejected this). **P1. L. Now-ish.**
- **Module boundaries / bounded contexts / domain separation** — today it's a single
  `server/` monolith with clean internal layering. The right next step is extracting the
  **engine as a standalone, dependency-light library** (the open-questions §9 portability
  goal) with the API and workers as thin consumers — this is what makes promotion into Pluvus
  V2 real. **P1. M. Now** (it's mostly already structured for it).
- **Workflow DSL / internal APIs** — the §1.1 interpreted graph *is* the DSL; formalize its
  schema (a versioned JSON schema for `nodeGraph`) as the contract between builder, engine,
  and (later) SDK. **P1. M. With 1.1.**

---

## 10. Production Readiness

The hard reliability/correctness bets are proven; the *production envelope* around them is
not. Consolidated, most urgent first:

- **Security & multi-tenancy — there is NO authentication or authorization on any application
  route** (only the Nylas webhook HMAC, which authenticates the *source*, not a user). The
  design doc says so explicitly. **Any caller can read/mutate any campaign, workflow, or
  instance.** This is the single largest production blocker after the engine chasm. **P0. XL**
  (auth + authz + tenant-scoping every query). **Now.**
- **Reliability — crash-recovery sweeper (§4.4), DLQ (§4.3), tier separation + horizontal
  scale (§4.1). P0. Now.**
- **Cost controls — AI cost tracking + budgets (§2.2), outbound email rate limiting (§4.3).**
  Without these, scale = uncontrolled spend and deliverability risk. **P0/P1. Now.**
- **Monitoring — aggregate dashboards + alerting (§5), structured logging to an aggregator**
  (today logs are stdout JSON only). **P1. Now-ish.**
- **Rate limiting — agent service has in-process rate limiting only** (multi-worker needs a
  shared store — the agent itself flags this); **no inbound API rate limiting at all** (no
  auth means no per-tenant limits possible yet). **P1. With auth.**
- **Disaster recovery — no documented backup/restore, no RPO/RTO, Redis is a single point**
  (locks + queues). **P2. Defer** but document.
- **Secrets management** — API keys via env only; production needs a vault. **P2.**

---

## Cross-cutting theme (the through-line)

Three structural facts explain ~80% of the gaps:

1. **The workflow is data but the engine is code.** Until §1.1 lands, "workflow platform"
   features (branching, custom nodes, builder, SDK, subflows) are all blocked.
2. **There is no identity.** Until tenancy/auth lands, "SaaS" features (permissions, billing,
   environments, sharing) are all blocked, and the system is unshippable.
3. **The operational envelope is single-process and unmetered.** Until tier-split + recovery +
   cost/metrics land, "scale" is unsafe (silent loss, uncontrolled spend, no on-call surface).

Everything else hangs off these three.

---

## TOP 20 — ranked by long-term architectural leverage

Ranking weighs: *how many other items it unblocks* × *production-criticality* × *cost of
deferring* (schema/coupling debt compounds).

| #  | Improvement | Pri | Cx | Now? | Why it ranks here |
|----|-------------|-----|----|------|-------------------|
| **1**  | **Data-driven node graph + generic node-type registry & runtime** (§1.1) | P0 | XL | Now | The keystone. Unblocks branching, custom nodes, builder, subflows, SDK. Every deferred quarter adds hardcoded debt to unwind. |
| **2**  | **Multi-tenancy + auth/authz + identity entities** (§6.1, §10) | P0 | XL | Now | Zero auth today. Unshippable as SaaS without it; retrofit cost compounds with every new query. |
| **3**  | **Crash-recovery / reconciliation sweeper + lock hardening** (§4.4) | P0 | M | Now | Closes a silent-data-loss class: non-due, non-terminal, jobless instances are stranded forever. Cheap, urgent. |
| **4**  | **Tier separation + horizontal worker scaling + configurable concurrency** (§4.1) | P0 | M | Now | The correctness to make it safe is already proven; this is mostly packaging. Gates all throughput. |
| **5**  | **Conditional branching & dynamic routing (DAG + edges)** (§1.2) | P0 | L | Now | The defining capability of a "workflow engine." Co-designed with #1. |
| **6**  | **AI cost + token + prompt-version observability** (§2.2) | P0 | M | Now | Running AI at scale blind to cost/provenance is a production gate. Feeds billing + dashboards. |
| **7**  | **DLQ + outbound email rate limiting + operator job tooling** (§4.3) | P0 | M | Now | Poison-message recovery and deliverability/cost protection. Standard at scale; absent today. |
| **8**  | **Human-approval / manual-intervention as resumable nodes** (§1.3) | P0 | M | Now | Completes the product's own flow (Approval stage). `MANUAL_REVIEW` is currently a terminal dead-end. Small atop #1. |
| **9**  | **Engine extracted as standalone portable library + formal nodeGraph DSL** (§9) | P1 | M | Now | The literal promotion path into Pluvus V2 (the prototype's stated purpose). Already mostly structured for it. |
| **10** | **Provider/model router + Anthropic/OpenRouter support, model-per-node** (§2.1) | P1 | M | Now | Quality (Claude for negotiation) + cost (local for classify). Cheap given existing `get_llm` seam. |
| **11** | **Timer subsystem: per-node timeouts, delayed/scheduled nodes, general loops** (§1.4) | P1 | L | Now-ish | Generalizes the one hardcoded follow-up timer into a primitive. Land the table with #1's schema. |
| **12** | **True graph builder UI (palette, connect, branch)** (§3.1) | P1 | L | After #1 | The product surface. React Flow already present but deliberately locked. |
| **13** | **Negotiation funnel + conversion + node-duration + queue-latency dashboards** (§5) | P1 | L | Now | The product's headline value ("where is each creator") + the on-call surface. |
| **14** | **Distributed scheduler (leader election) + bounded due-query** (§4.2) | P1 | M | With #4 | Required the moment #4 runs >1 replica. |
| **15** | **Simulation / dry-run / test mode in the builder** (§3.3) | P1 | L | After #1 | Stops every workflow change being tested on real creators (who get real emails). Promote the existing harness. |
| **16** | **Expression engine + workflow variables** (§3.2) | P1 | L | With #5 | The substrate branching conditions need; turns config into automation. |
| **17** | **Per-node retry policy + Saga/compensation hooks** (§1.5) | P1 | L | Partial now | Reliability for money-adjacent nodes (onboarding/contract). Retry policy now, compensation when those nodes exist. |
| **18** | **AI evals for negotiation & draft + CI gates** (§2.3) | P1 | L | Now-ish | The commercially risky AI surfaces have zero eval. Start the real-data pipeline now. |
| **19** | **Cancellation + pause/resume** (§4.5) | P1 | M | Now | Basic operator control over live campaigns; absent today. (Replay/backfill defer.) |
| **20** | **CQRS-lite projections + new tables (`AiCall`, `Timer`, `HumanTask`) + billing/usage metering** (§6.3, §7) | P1 | L | Now (tables) | Adds the tables now to avoid painful later migrations; enables analytics, billing, and replay later. |

### Notably deferred (correct to wait)

Full event-sourcing-as-primary-store · compensation logic until post-negotiation nodes exist
· marketplace/import-export/sharing · custom-node/provider/trigger SDKs (design *after* #1's
contracts stabilize) · instance version-migration · DR/backup formalization ·
breakpoints/version-diff.

---

## The one-sentence strategic read

**Spend the next two quarters making the engine interpret a graph (#1), giving the platform
an identity model (#2), and closing the silent-loss + cost-blindness + single-process gaps
(#3, #4, #6, #7) — because those seven items are the load-bearing walls, and roughly
everything else in the 2–3 year vision is either blocked by them or made cheap once they
exist.**
