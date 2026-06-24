# Pluvus Workflow Prototype

> **A validation harness for the Pluvus V2 workflow execution architecture.**
> This is not a product. It is the thing we build *before* the product, to prove the
> hard parts — the execution engine, event-driven advancement, scheduling, queues,
> AI orchestration, and email round-tripping — on mocked data before any of it is
> promoted into production Pluvus V2.

This document is the canonical engineering reference for the repository. It serves five
purposes at once:

1. **Architecture documentation** — how the system is wired and why.
2. **Progress report** — what has been built, phase by phase.
3. **Onboarding guide** — enough that a new engineer understands the whole system without reading the code first.
4. **Implementation reference** — concrete file paths, function names, and data shapes.
5. **Historical record** — the decisions, tradeoffs, and lessons from each phase.

It reflects the actual codebase **through Phase 5**. Where the original design docs
(`.claude/docs/`) and the running code diverge, this document describes the *code* and
flags the deviation explicitly.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Product Vision](#2-product-vision)
3. [Architecture Overview](#3-architecture-overview)
4. [Repository Structure](#4-repository-structure)
5. [Workflow Engine Deep Dive](#5-workflow-engine-deep-dive)
6. [Data Model Deep Dive](#6-data-model-deep-dive)
7. [Phase-by-Phase Progress Report](#7-phase-by-phase-progress-report)
8. [Phase 3 Runtime Walkthrough](#8-phase-3-runtime-walkthrough)
9. [Phase 4 Event System](#9-phase-4-event-system)
10. [Phase 5 Scheduler and Concurrency Protection](#10-phase-5-scheduler-and-concurrency-protection)
11. [Harnesses and Validation](#11-harnesses-and-validation)
12. [Current Status (After Phase 5)](#12-current-status-after-phase-5)
13. [What's Missing](#13-whats-missing)
14. [End-to-End Example](#14-end-to-end-example)
15. [Running the Code](#15-running-the-code)

---

## 1. Project Overview

### What this is

The Pluvus Workflow Prototype is a **focused validation harness for the Pluvus V2
workflow execution engine**. The current production campaign builder is a rigid,
form-based tool. Real creator-marketing operations don't fit a static form — they
depend on **per-creator state**: who replied, who needs a follow-up, who's mid-negotiation,
who opted out. Modern sequence tools (Apollo, HubSpot, Outreach) model this as explicit,
configurable steps with timing, stop rules, and per-step monitoring. Pluvus V2 wants the
same: a workflow engine where each creator advances through nodes with visible state.

Before that design is committed to production, the *execution architecture itself* needs
to be proven in isolation: the state machine, the event-driven advancement, the scheduler,
the queue seam, the AI orchestration boundary, and the email integration. This repository
exists to do exactly that, on mocked creator data, cheaply and quickly.

### Why a separate repo

| | **This prototype repo** | **Main Pluvus V2 repo** |
|---|---|---|
| **Goal** | De-risk the execution architecture | Ship the product |
| **Data** | Mocked creators, mocked email/AI | Real creator DB, real email, real AI |
| **Scope** | The linear execution path only | Full campaign lifecycle (fulfillment, payments, content, attribution…) |
| **Auth / multi-tenancy** | None | Production-grade |
| **Lifespan** | Throwaway once the architecture is validated | Long-lived |
| **Success metric** | "The architecture works and is promotable" | "Customers get value" |

The prototype deliberately strips away everything that isn't execution so the *risky*
parts can be validated without the noise of a full product. Patterns proven here —
worker-owned state, queue-as-seam, snapshot versioning, bounded AI — are then promoted
into the production codebase with confidence.

### The seven architectural bets being validated

Everything in this repo exists to confirm or refute these:

1. The **execution instance** (one creator × one workflow version) is the right unit of execution, scheduling, and audit.
2. An **event-driven model** (time triggers + inbound email triggers) cleanly drives state transitions.
3. A **queue (BullMQ/Redis)** is the right seam between scheduling/eventing and node execution.
4. **LangGraph** fits bounded AI orchestration (draft, classify, negotiate) and integrates with a TS backend.
5. **Nylas** can both send outreach and reliably ingest replies as events.
6. **Snapshot versioning** keeps in-flight instances stable while definitions evolve.
7. A **bounded negotiation loop** terminates correctly under explicit stop rules.

Bets 1, 2, 3, 6, and 7 are validated through Phase 5 on mocks. Bets 4 and 5 (real
LangGraph + real Nylas) are deferred to Phases 6–8.

---

## 2. Product Vision

The creator workflow being modeled is a linear pipeline. A creator is selected, contacted,
followed up with if silent, their reply is classified, terms are negotiated, and they're
either onboarded or exited.

```
   Creator Selected
         │
         ▼
      Outreach            (first contact email)
         │
         ▼
    Reply Handling        (wait → follow up → detect/classify reply)
         │
         ▼
    Negotiation           (bounded back-and-forth on terms)
         │
         ▼
     Approval             (terms accepted)
         │
         ▼
     Onboarding           (creator joins the campaign)
```

In the prototype, this product-level vision maps to a concrete six-node linear workflow:

```
Import Creator List → Initial Outreach → Follow-Up → Reply Detection → Negotiation → End
```

### How workflow execution is intended to work

The engine advances on exactly **two trigger families** and nothing else:

- **Time triggers** — a scheduled follow-up becomes due.
- **Inbound triggers** — an email reply arrives.

Each trigger becomes a queue job. A worker picks up the job, evaluates the current node's
completion rule and stop conditions, commits exactly one state transition, appends an
audit event, and either schedules the next time trigger or finishes. At waiting states
(`AWAITING_REPLY`, `NEGOTIATING`) the instance sits idle, consuming nothing, until a
trigger produces the next job. There is **no instance polling loop that "runs" workflows** —
progress is driven entirely by events.

```
   ⏰ Follow-up due ──┐
                      ├──► queue job ──► Worker ──► evaluate node rules
   📧 Inbound reply ──┘                              │
                                                     ▼
                                          commit ONE state transition
                                                     │
                                  ┌──────────────────┼──────────────────┐
                                  ▼                  ▼                  ▼
                          append Event       update instance     schedule next
                          (audit log)        (currentState)      trigger / finish
```

This is the core claim under validation: the **execution instance is the unit of
execution, scheduling, and audit**, advanced purely by an event-driven engine.

---

## 3. Architecture Overview

### Three tiers + shared infrastructure

- **Web tier** — React/Vite UI (currently a health dashboard; the React Flow pipeline view is Phase 9) and an Express API that exposes health checks and queue diagnostics/injection endpoints.
- **Execution tier** — BullMQ workers that are the **only** writers of execution-instance state, plus a scheduler that polls for due follow-ups. This is where all business logic lives.
- **Agent tier** — a Python FastAPI service that will host LangGraph graphs (`draft`, `classify`, `negotiate`). Currently a health-check stub; AI lives behind mock providers in the engine until Phases 7–8.

Shared infra: **PostgreSQL** (via Prisma) is the source of truth for definitions, versions, instances, messages, and events. **Redis** backs BullMQ queues and the per-instance locks.

```
┌──────────────────────── Web Tier ────────────────────────┐
│  React + Vite UI  ◄──►  Express API (health, /queues/*)   │
└───────────────────────────────┬───────────────────────────┘
                                 │ enqueue
                                 ▼
┌──────────────────── Execution Tier ──────────────────────┐
│  Scheduler (30 s poller)  ──►  BullMQ Queues (Redis)      │
│                                      │                     │
│                                      ▼                     │
│   Workers (node-execution, inbound-email)                 │
│     └─ WorkflowRuntime ─ state machine ─ node executors   │
└───────────────┬───────────────────────────┬───────────────┘
                │ read/write                 │ (mock today; real later)
                ▼                            ▼
        PostgreSQL (Prisma)          Agent Tier (FastAPI/LangGraph)
                                     Email provider (Nylas — Phase 6)
```

### Evolution across phases

The system was built strictly bottom-up: prove the engine on stubs, then make the
triggers event-driven, then make scheduling real. Each phase added a layer *in front* of
the previous one without rewriting it.

**Phase 3 — direct, synchronous:**

```
Harness  ──►  WorkflowRuntime.stepInstance()  ──►  Postgres
(test code calls the runtime directly, in-process)
```

**Phase 4 — queue + worker in front of the runtime:**

```
Producer ──► BullMQ Queue ──► Worker ──► WorkflowRuntime.stepInstance() ──► Postgres
(advancement is now a job; the runtime is unchanged underneath)
```

**Phase 5 — scheduler + concurrency protection wrapped around it:**

```
Scheduler (poller) ──► BullMQ Queue ──► Worker ──► WorkflowRuntime ──► Postgres
   (dueAt <= now)          │              │  (Redis lock + OCC guard)      ▲
                           │              └──────────────────────────────┘
                           └─ deterministic jobIds prevent double-enqueue
```

The key architectural decision visible in this evolution: **the runtime never changed.**
`WorkflowRuntime.stepInstance()` written in Phase 3 is the exact same method called by the
Phase 4 worker and triggered by the Phase 5 scheduler. The queue and scheduler are seams
*around* the engine, not modifications *to* it. That's the whole point of building the
engine on stubs first.

---

## 4. Repository Structure

This is a monorepo with three workspaces (`web`, `server`, `agent`). The `server/`
workspace holds essentially all the validated architecture.

```
pluvus-workflow-proto/
├── web/                       # React + Vite frontend (Phase 1; Phase 9 pipeline UI pending)
├── server/                    # Express API + execution engine — the heart of the prototype
├── agent/                     # Python FastAPI/LangGraph service (Phase 1 stub; AI in Phase 7–8)
├── docker-compose.yml         # Postgres + Redis for local dev
├── tsconfig.base.json         # Shared TS config
├── package.json               # npm workspaces root + run scripts
└── .claude/docs/              # Original architecture/design docs (source of truth)
```

### `server/src/` — folder by folder

#### `server/src/db/` — repository layer

A thin, typed wrapper over Prisma. No business logic — just typed CRUD functions so the
rest of the code never touches `prisma.*` directly (one exception: `replyDetection.ts`
updates a message inline). Files:

- **`client.ts`** — the singleton `PrismaClient`. Uses the `@prisma/adapter-pg` driver adapter over `pg`. Loads `.env` from the project root. Query logging is on only when `NODE_ENV=development`, which is why the harnesses run with `NODE_ENV=production` (quiet output).
- **`instances.ts`** — the most important repository. Reads (`findInstanceById`, `listInstancesByVersion`, `listInstancesByState`, `countInstancesByNode`, `listDueInstances`) and writes (`updateInstanceState`, **`updateInstanceStateConditional`** — the OCC primitive). `listDueInstances` and the conditional update are the Phase 5 additions.
- **`creators.ts`**, **`workflows.ts`**, **`messages.ts`**, **`events.ts`** — CRUD for the remaining models. `messages.ts` has `findMessageByExternalId` (the inbound-email idempotency check) and `findMessagesByThreadId` (a Phase 6 hook for Nylas reply correlation). `events.ts` has `appendEvent` (append-only — never updates or deletes).
- **`index.ts`** — barrel export.

#### `server/src/engine/` — the workflow runtime (Phase 3)

The pure execution engine. Knows nothing about queues, Redis, or HTTP.

- **`stateMachine.ts`** — the transition table (`TRANSITIONS`), `isTerminal()`, and `assertTransition()` which throws `InvalidTransitionError` on an illegal move. This is the single authority on what state changes are legal.
- **`types.ts`** — `NodeSnapshot`, `ExecutionContext`, `NodeResult` (what every executor returns), and the AI/email result types.
- **`providers.ts`** — `IEmailProvider` / `IAgentProvider` interfaces and their **mock implementations** (`MockEmailProvider`, `MockAgentProvider`). The mocks are deterministic and configurable, which is what makes the harnesses able to drive specific paths.
- **`runtime.ts`** — the `WorkflowRuntime` class: `loadContext`, `stepInstance`, `injectReply`, `runUntilWaiting`, and the executor dispatch. Also defines `StaleInstanceError` (thrown on OCC conflict — a Phase 5 addition).
- **`executors/`** — one file per node type. Each is a pure function `(ctx, email, agent) → NodeResult`. They contain the per-node completion/stop logic. See [§5](#5-workflow-engine-deep-dive).
- **`harness.ts`** — the Phase 3 acceptance harness (`npm run harness`).

#### `server/src/workers/` — BullMQ queues + workers (Phase 4)

The event-driven seam.

- **`redis.ts`** — `redisConnection()` returns a plain `{host, port, …}` object. Deliberately *not* an `ioredis` instance, to avoid a type conflict between BullMQ's bundled ioredis and the project's. Sets `maxRetriesPerRequest: null` (required by BullMQ for blocking commands).
- **`jobs.ts`** — job payload types: `NodeExecutionJobData` (`instanceId`, `expectedState`, `triggerRef`) and `InboundEmailJobData` (`instanceId`, `externalMessageId`, `threadId`, `subject`, `body`, `mockIntent?`). The doc comments here are the definitive spec for idempotency keys.
- **`queues.ts`** — queue singletons, `DEFAULT_JOB_OPTIONS` (3 attempts, exponential backoff), and the `enqueueNodeExecution` / `enqueueInboundEmail` helpers that build deterministic `jobId`s.
- **`nodeExecutionWorker.ts`** — advances one instance one step. Idempotency via `expectedState` check; serialization via Redis lock; OCC via `StaleInstanceError` catch.
- **`inboundEmailWorker.ts`** — processes a reply: `injectReply` → `stepInstance` (runs reply detection). Idempotency via `findMessageByExternalId`.
- **`index.ts`** — `startWorkers()` / `stopWorkers()` registry.
- **`harness.ts`** — the Phase 4 acceptance harness (`npm run harness:phase4`).

#### `server/src/scheduler/` — time-based scheduling + locking (Phase 5)

- **`poller.ts`** — `startPoller()` runs `poll()` every 30 s: query `listDueInstances()` (`dueAt <= now` AND state ∈ {`AWAITING_REPLY`, `FOLLOWED_UP`}), enqueue a `node-execution` job for each, with a deterministic `triggerRef` so overlapping polls don't double-enqueue.
- **`lock.ts`** — per-instance Redis locks via `SET instance:{id} NX PX 30000`. Uses the `redis` (node-redis) client directly. `acquireLock` / `releaseLock` / `closeLockClient`.
- **`scheduler.ts`** — a thin facade (`startScheduler` / `stopScheduler`) so `index.ts` only talks to one module.
- **`harness.ts`** — the Phase 5 acceptance harness (`npm run harness:phase5`).

#### `server/src/routes/` — HTTP routes

- **`queues.ts`** — `GET /queues/health` (live job counts), `GET /queues/jobs` (recent waiting/active/failed jobs), `POST /queues/node-execution` (manually advance an instance), `POST /queues/inbound-email` (inject a mocked reply). These are the manual operator/testing controls.

#### `server/src/index.ts` — entrypoint

Boots Express, registers `/health`, `/health/db`, and the `/queues` router, then calls
`startWorkers()` and `startScheduler()`. Registers SIGTERM/SIGINT handlers for graceful
drain.

#### `server/prisma/` — schema, migration, seed

- **`schema.prisma`** — all six models + enums (see [§6](#6-data-model-deep-dive)).
- **`migrations/20260624064336_init/`** — the single initial migration.
- **`seed.ts`** — creates 1 workflow, 1 published version with the 6-node `nodeGraph`, 8 mock creators, and 8 instances (one per creator). Idempotent (upserts). The seeded version id `wfv_seed_v1` is what every harness loads.

> **Note on the old README's structure tree.** The previous README listed `server/src/adapters/`,
> `agent/app/routes/`, and `agent/app/graphs/`. **These do not exist yet** — they were
> aspirational. The agent service is a single `main.py` health check. Email/AI adapters
> are represented today by the mock providers in `engine/providers.ts`.

---

## 5. Workflow Engine Deep Dive

The engine has four moving parts: the **node graph** (definition), the **execution
instance** (state), the **state machine** (legal transitions), and the **node executors**
(per-node logic). The `WorkflowRuntime` orchestrates them.

### WorkflowVersion and the node graph

A `WorkflowVersion` stores its node graph as a JSON array (`nodeGraph`) captured at publish
time. Each entry is a `NodeSnapshot`:

```ts
interface NodeSnapshot {
  id: string;        // e.g. "node_followup"
  type: string;      // e.g. "FOLLOW_UP" (one of the NodeType enum values)
  order: number;     // 0..5 — linear ordering
  config: Record<string, unknown>;  // node-specific config (intervals, maxRounds, …)
}
```

The seeded graph (`prisma/seed.ts`):

| order | id | type | key config |
|---|---|---|---|
| 0 | `node_import` | `IMPORT_CREATOR_LIST` | `dedupStrategy: "email"` |
| 1 | `node_outreach` | `INITIAL_OUTREACH` | `senderName`, `bodyTemplate`, `aiDraftEnabled` |
| 2 | `node_followup` | `FOLLOW_UP` | `intervals: [3,5,7]`, `intervalUnit: "days"`, `maxCount: 3` |
| 3 | `node_reply_detection` | `REPLY_DETECTION` | `lowConfidenceThreshold: 0.6` |
| 4 | `node_negotiation` | `NEGOTIATION` | `maxRounds: 5`, `termFloor/Ceiling` |
| 5 | `node_end` | `END` | — |

Because the graph is a JSON snapshot on the version, editing the workflow later produces a
*new* version; in-flight instances keep executing the graph they enrolled under. This is
snapshot versioning (bet #6).

### ExecutionInstance — the state carrier

Every executor reads and (indirectly) writes one `ExecutionInstance`. The fields that
matter at runtime:

- `currentState` — the `InstanceState` enum value; the single source of truth.
- `currentNodeId` — which node in the graph it's executing.
- `followUpCount` / `negotiationRound` — loop counters that bound the follow-up and negotiation loops.
- `dueAt` — when the next scheduled action becomes due (the scheduler reads this).
- `completedAt` — set when entering a terminal state.

### The state machine

`stateMachine.ts` defines the legal transitions explicitly:

```ts
const TRANSITIONS = {
  ENROLLED:       ["OUTREACH_SENT", "OPTED_OUT"],
  OUTREACH_SENT:  ["AWAITING_REPLY", "OPTED_OUT"],
  AWAITING_REPLY: ["FOLLOWED_UP", "REPLY_RECEIVED", "NO_RESPONSE", "OPTED_OUT"],
  FOLLOWED_UP:    ["AWAITING_REPLY", "REPLY_RECEIVED", "OPTED_OUT"],
  REPLY_RECEIVED: ["NEGOTIATING", "REJECTED", "OPTED_OUT"],
  NEGOTIATING:    ["NEGOTIATING", "ACCEPTED", "REJECTED", "OPTED_OUT"],
  ACCEPTED: [], REJECTED: [], OPTED_OUT: [], NO_RESPONSE: [],  // terminal
};
```

`assertTransition(from, to)` is called by the runtime *before every persist*. Same-state
transitions are allowed (the import node stays `ENROLLED` while advancing the node
pointer). Any move not in the table throws `InvalidTransitionError` — illegal transitions
can never reach the database.

```
                 ┌─────────────┐
                 │  ENROLLED   │
                 └──────┬──────┘
                        │ initial outreach
                        ▼
                ┌───────────────┐
                │ OUTREACH_SENT │
                └───────┬───────┘
                        │ enter follow-up wait
                        ▼
          ┌────────► AWAITING_REPLY ◄────────┐
          │          │   │   │                │ reschedule
 reply ───┼──────────┘   │   └── max reached ─┼──► NO_RESPONSE (terminal)
          │              │                    │
          │     follow-up due (count<max)     │
          │              ▼                     │
          │         FOLLOWED_UP ───────────────┘
          │              │
          │              │ reply
          ▼              ▼
       REPLY_RECEIVED ◄──┘
          │
   ┌──────┼───────────────┐
   │ pos/question    negative
   ▼                      ▼
 NEGOTIATING          REJECTED (terminal)
   │  ▲   │
   │  └───┘ counter (round<max)
   │      │
 accept   reject / max rounds
   ▼      ▼
 ACCEPTED  REJECTED (terminal)

  OPTED_OUT is reachable from ENROLLED / AWAITING_REPLY / NEGOTIATING (and others).
```

### Node executors — per-node logic

Every executor is a pure function returning a `NodeResult`:

```ts
interface NodeResult {
  nextState: InstanceState;
  nextNodeId: string | null;
  followUpCount?: number;       // optional counter update
  negotiationRound?: number;    // optional counter update
  dueAt?: Date | null;          // schedule / clear the next time trigger
  completedAt?: Date | null;
  eventType: EventType;         // the domain event to log
  eventPayload?: Record<string, unknown>;
}
```

What each one does:

- **`importCreatorList.ts`** — no-op gate. Asserts `ENROLLED`, advances the node pointer to outreach, stays `ENROLLED`. (Enrollment itself happens at seed time in the prototype.)
- **`initialOutreach.ts`** — drafts + sends the first email via the email provider, persists an `OUTBOUND` `Message`, transitions `ENROLLED → OUTREACH_SENT`, logs `OUTREACH_DRAFTED`.
- **`followUp.ts`** — the most stateful executor. Three cases:
  - `OUTREACH_SENT → AWAITING_REPLY`: set `dueAt = now + interval[0]`, log `NODE_ENTERED`.
  - `FOLLOWED_UP → AWAITING_REPLY`: set `dueAt` for the next window.
  - `AWAITING_REPLY` (a follow-up is due): if `followUpCount >= maxCount` → `NO_RESPONSE` (clear `dueAt`); otherwise send a follow-up email, increment `followUpCount`, transition to `FOLLOWED_UP`, log `FOLLOW_UP_DUE`.
  - Intervals come from `config.intervals` (days). For tests, `intervalUnit: "seconds"` compresses them.
- **`replyDetection.ts`** — asserts `REPLY_RECEIVED`, classifies the latest inbound message via the agent provider, persists the intent + confidence on the `Message`, then routes: `POSITIVE`/`QUESTION → NEGOTIATING`; `NEGATIVE → REJECTED`; `OPT_OUT → OPTED_OUT`. Logs `REPLY_CLASSIFIED`.
- **`negotiation.ts`** — asserts `NEGOTIATING`, calls `agent.negotiate(round, config)`. `accept` → send confirmation, `ACCEPTED`. `reject` → `REJECTED`. `counter` → increment round; if `round >= maxRounds` force `REJECTED` (max-rounds stop rule), else send counter email and stay `NEGOTIATING`. Logs `NEGOTIATION_TURN`.
- **`end.ts`** — terminal sink; stamps `completedAt`.

### Events and Messages

Two side-effects accompany transitions:

- **`Message`** rows are written by executors that send or receive email (outreach, follow-up, negotiation, and `injectReply` for inbound).
- **`Event`** rows are written by the runtime: one **domain event** (the executor's `eventType`) plus a **`STATE_TRANSITION`** event whenever the state actually changes. Events are append-only and carry a free-form JSON `payload`.

### Example state traces (from the Phase 3 harness)

**Happy path → ACCEPTED:**

```
ENROLLED
  → AWAITING_REPLY        (import → outreach → enter follow-up wait)
  → FOLLOWED_UP           (one follow-up cycle, stepped manually)
  → AWAITING_REPLY
  → REPLY_RECEIVED        (positive reply injected)
  → NEGOTIATING           (reply detection classifies POSITIVE)
  → NEGOTIATING           (round 0 counter)
  → ACCEPTED              (round 1 accept)
```

**No-response → NO_RESPONSE:**

```
ENROLLED
  → AWAITING_REPLY
  → FOLLOWED_UP → AWAITING_REPLY   (follow-up 1)
  → FOLLOWED_UP → AWAITING_REPLY   (follow-up 2)
  → FOLLOWED_UP → AWAITING_REPLY   (follow-up 3)
  → NO_RESPONSE                    (followUpCount == maxCount)
```

**Opt-out → OPTED_OUT:**

```
ENROLLED
  → AWAITING_REPLY
  → REPLY_RECEIVED        (reply injected)
  → OPTED_OUT             (classified OPT_OUT)
```

Why these traces matter: they prove the engine respects the completion/stop rules — the
follow-up loop terminates at exactly `maxCount`, the negotiation loop terminates at accept
or `maxRounds`, and opt-out short-circuits to a terminal state. That's success criteria
#1, #2, and #9 from the source of truth.

---

## 6. Data Model Deep Dive

Six models, split deliberately into **definition** (Workflow, WorkflowVersion) and
**execution** (ExecutionInstance, Message, Event), with Creator bridging them.

```
  Workflow ──1:N──► WorkflowVersion ──1:N──► ExecutionInstance ──1:N──► Message
                                                   ▲                 └─1:N──► Event
                                                   │
                                       Creator ────┘ (1:N)
```

The defining principle: **definition models are mutable; the version snapshot is immutable;
execution models are append-friendly.** Editing a workflow never disturbs running instances
because instances reference a frozen `WorkflowVersion`.

### Workflow

The logical campaign container.

- **Purpose:** group a sequence of nodes under a name; track lifecycle (`DRAFT` / `PUBLISHED` / `ARCHIVED`).
- **Key fields:** `id`, `name`, `description`, `status`.
- **Relationships:** has many `WorkflowVersion`.
- **Example:** `{ id: "workflow_seed_v1", name: "Creator Outreach Campaign", status: "PUBLISHED" }`.
- **How it's used:** editing it produces a new version; it is *not* read at runtime — instances read the version, not the workflow.

### WorkflowVersion

The immutable published snapshot — the thing instances actually execute against.

- **Purpose:** freeze the node graph + configs at publish time so in-flight instances are stable.
- **Key fields:** `version` (int, unique per workflow), `nodeGraph` (JSON array of `NodeSnapshot`), `publishedAt`.
- **Relationships:** belongs to `Workflow`; has many `ExecutionInstance`. `@@unique([workflowId, version])`.
- **Example:** `{ id: "wfv_seed_v1", workflowId: "workflow_seed_v1", version: 1, nodeGraph: [ …6 nodes… ] }`.
- **How it's used:** `runtime.loadContext()` reads `nodeGraph` and resolves the current node by `currentNodeId` (or the lowest `order` if unset).

### Creator

A mocked creator profile.

- **Purpose:** the person being contacted. Mocked here; would come from the creator DB in production.
- **Key fields:** `name`, `email` (unique), `handle`, `niche`, `platform`, `metadata` (JSON).
- **Relationships:** has many `ExecutionInstance`.
- **Example:** `{ name: "Alex Rivera", email: "alex.rivera@example.com", niche: "fitness", platform: "instagram" }`.
- **How it's used:** read into `ExecutionContext`; the email provider personalizes drafts from it.

### ExecutionInstance

**The spine of the system** — one creator × one workflow version.

- **Purpose:** the unit of execution, scheduling, and audit. State lives here, not on the definition.
- **Key fields:** `currentState` (`InstanceState`), `currentNodeId`, `followUpCount`, `negotiationRound`, `dueAt`, `completedAt`, `enrolledAt`.
- **Relationships:** belongs to `WorkflowVersion` + `Creator`; has many `Message` + `Event`. `@@unique([workflowVersionId, creatorId])` (a creator enrolls in a version at most once).
- **Example:** `{ currentState: "AWAITING_REPLY", currentNodeId: "node_followup", followUpCount: 1, dueAt: "2026-06-27T…" }`.
- **How it's used:** workers are the **only** writers (the central invariant). The OCC guard (`updateInstanceStateConditional`) makes concurrent writes safe.

### Message

Every email tied to an instance.

- **Purpose:** the full inbound/outbound email log per instance.
- **Key fields:** `direction` (`OUTBOUND`/`INBOUND`), `subject`, `body`, `threadId`, `externalMessageId` (unique — the dedup key), `replyIntent`, `classifyConfidence`, `sentAt`/`receivedAt`.
- **Relationships:** belongs to `ExecutionInstance`. Indexed on `threadId` and `instanceId`.
- **Example (inbound):** `{ direction: "INBOUND", body: "Yes I'm interested!", externalMessageId: "mock-inbound-…", replyIntent: "POSITIVE", classifyConfidence: 0.95 }`.
- **How it's used:** `externalMessageId` is the inbound-email idempotency anchor; `threadId` is the Phase 6 Nylas correlation key; `replyIntent`/`classifyConfidence` are written by reply detection.

### Event

Append-only audit log.

- **Purpose:** record every trigger and transition for audit and (in principle) replay.
- **Key fields:** `type` (`EventType`), `nodeId`, `payload` (free-form JSON), `occurredAt`. **Never updated or deleted.**
- **Relationships:** belongs to `ExecutionInstance`. Indexed on `(instanceId, occurredAt)`.
- **`EventType` values:** trigger (`FOLLOW_UP_SCHEDULED/CANCELLED/DUE`, `INBOUND_REPLY_RECEIVED`), transition (`STATE_TRANSITION`, `NODE_ENTERED`, `NODE_COMPLETED`), AI (`OUTREACH_DRAFTED`, `REPLY_CLASSIFIED`, `NEGOTIATION_TURN`).
- **Example:** `{ type: "STATE_TRANSITION", nodeId: "node_followup", payload: { from: "AWAITING_REPLY", to: "FOLLOWED_UP" } }`.
- **How it's used:** the runtime writes the domain event + a `STATE_TRANSITION` event per step; the Phase 9 timeline UI will read these back.

---

## 7. Phase-by-Phase Progress Report

This is the engineering journal: for each completed phase — the problem, what was built,
the decisions, what was validated, what was deferred, and the lessons.

### Phase 1 — Repository Foundation

**The problem.** Nothing existed. Before any architecture could be validated, there had to
be a place for it to land: three services that start, talk to each other, and share tooling.

**What was implemented.**
- npm-workspaces monorepo with `web/`, `server/`, `agent/`.
- `web/` — React 18 + Vite + TypeScript. A single dashboard (`App.tsx`) that pings the server and agent health endpoints and renders ✓/✗. Vite dev-proxies `/api → :3001` and `/agent → :8000`.
- `server/` — Express + TypeScript (ESM), `/health` endpoint.
- `agent/` — FastAPI + uvicorn, `/health` endpoint, CORS for the web origin.
- `docker-compose.yml` — Postgres 16 + Redis 7 with health checks.
- `tsconfig.base.json` shared config; root run scripts (`dev`, `dev:server`, `dev:web`, `infra:up/down`).

**Architecture decisions.** Three separate processes (not one) from day one, because the
agent tier is genuinely a different language (Python/LangGraph) and the worker tier needs
to scale independently of the API. The web tier is read-mostly by design — it visualizes
execution, never drives it.

**Validated:** all three services start; the UI reaches both health endpoints; infra
comes up with one command.

**Deferred:** everything substantive. Phase 1 is pure scaffold.

**Lessons.** The ESM + `"type": "module"` choice means `.js` extensions in TS imports and
`tsx` for running TS directly — a small tax paid up front that simplified the worker/harness
tooling later.

### Phase 2 — Data Models

**The problem.** The engine needs a persistence layer that cleanly separates *what a
workflow is* from *what a running creator is doing* — otherwise editing a workflow would
corrupt in-flight runs.

**What was implemented.**
- The full Prisma schema: `Workflow`, `WorkflowVersion`, `Creator`, `ExecutionInstance`, `Message`, `Event`, plus all enums (`InstanceState`, `NodeType`, `MessageDirection`, `ReplyIntent`, `EventType`, `WorkflowStatus`).
- The initial migration (`20260624064336_init`).
- A typed repository layer in `db/` (one file per aggregate) so no business code touches Prisma directly.
- `seed.ts` — idempotent seed: 1 workflow, 1 published version with the 6-node graph, 8 mock creators, 8 instances.
- The Prisma **driver adapter** (`@prisma/adapter-pg`) over `pg`, and a singleton client.

**Architecture decisions.**
- **Definition/execution split** (§6) — the headline decision. `WorkflowVersion.nodeGraph` is a JSON snapshot, not relational `Node` rows, so a version is a single immutable document and instances pin to it trivially.
- **`Event` is append-only.** No update/delete path exists in the repository — auditability is structural, not a convention.
- **Unique constraints encode invariants:** `(workflowVersionId, creatorId)` on instances, `externalMessageId` on messages (the future dedup key).

**Validated:** migration applies cleanly; seed is idempotent; instances pin to a version;
messages and events round-trip.

**Deferred:** no engine yet — this phase is data only. Scheduling fields (`dueAt`,
`followUpCount`, `negotiationRound`) and correlation fields (`threadId`,
`externalMessageId`, `replyIntent`) were added to the schema *now* but not *used* until
Phases 3–6. Defining them early avoided a migration later.

**Lessons.** Putting the node config in JSON (vs. relational node rows) was the right call
for a linear, snapshot-versioned workflow — it made the version genuinely immutable for
free. The cost is that node config is unvalidated at the DB layer; the `NodeType` enum
exists so the app layer can validate snapshots without magic strings.

### Phase 3 — Workflow Runtime Engine

**The problem.** Validate the state machine and node semantics *before* introducing any
external dependency. If the engine is correct on stubs, queues and email can be layered on
without re-litigating correctness.

**What was implemented.**
- `stateMachine.ts` — explicit transition table + `assertTransition` guard.
- `providers.ts` — `IEmailProvider`/`IAgentProvider` interfaces + deterministic, configurable mocks.
- Six node executors, one per node type, each a pure `(ctx, email, agent) → NodeResult`.
- `WorkflowRuntime` (`runtime.ts`): `loadContext`, `stepInstance`, `injectReply`, `runUntilWaiting`.
- `harness.ts` — drives three full creator journeys (happy path, opt-out, no-response) and prints state traces + event/message counts.

**Architecture decisions.**
- **Providers behind interfaces.** The mock vs. real email/AI split is an interface boundary from the start, so Phases 6–8 swap implementations without touching the engine. This is the single most important Phase 3 decision — it's what makes "validate on stubs, then make real" actually work.
- **Executors are pure and return a `NodeResult` rather than mutating.** The *runtime* owns persistence and event-writing; executors own only the decision. This keeps transition validation and audit logging in exactly one place (`stepInstance`).
- **`runUntilWaiting`** drives the instance through all the immediate (non-waiting) steps and stops at `AWAITING_REPLY` / `NEGOTIATING` / terminal — modeling the real event-driven pauses.

**Validated:** the engine walks instances end-to-end on stubs; illegal transitions are
rejected; follow-up and negotiation loops respect their counters and terminate; every
transition appends an `Event`. (Success criteria #1, #2, #9 in §8 of the source of truth.)

**Deferred:** real email/AI (mocks only); event-driven advancement (the harness calls
`stepInstance` directly — queues come in Phase 4); concurrency safety (no locks/OCC yet —
single-threaded harness).

**Lessons.** Making executors pure and centralizing persistence in the runtime paid off
immediately in Phase 5 — adding OCC meant changing *one* call site
(`updateInstanceStateConditional` in `stepInstance`), not six executors.

### Phase 4 — Event System

**The problem.** Phase 3 advances instances by direct function call. Production needs
advancement to be *event-driven and durable*: a trigger enqueues a job, a worker processes
it, re-deliveries are harmless. This is the queue-as-seam bet (#3).

**What was implemented.**
- BullMQ queues `node-execution` and `inbound-email` on Redis, with retry/backoff defaults (3 attempts, exponential).
- `nodeExecutionWorker` — wraps `runtime.stepInstance()`; idempotent on an `expectedState` check.
- `inboundEmailWorker` — wraps `injectReply` + `stepInstance`; idempotent on `externalMessageId`.
- Deterministic `jobId`s so a retrying producer can't create duplicate jobs.
- `routes/queues.ts` — health, job listing, and manual injection endpoints.
- `harness.ts` (phase4) — validates advance-via-queue, reply-via-queue, and idempotency.

**Architecture decisions.**
- **The runtime is untouched.** Workers *wrap* the Phase 3 engine. The seam is the queue, exactly as the architecture predicted.
- **Two idempotency strategies, one per queue.** `node-execution` guards on `expectedState` (re-reads live state; skips if it moved). `inbound-email` guards on `externalMessageId` (skips if the message row already exists). Different triggers, different natural dedup keys.
- **Redis connection as a plain object, not an ioredis instance** (`redis.ts`) — sidesteps a type conflict between BullMQ's bundled ioredis and the project's.
- **`|` as the jobId separator** — BullMQ v5 disallows `:` in custom jobIds (a real, discovered constraint).

**Validated:** enqueuing a `node-execution` job advances the instance via a worker;
re-delivery causes no double transition; a simulated `inbound-email` job drives the reply
path; events log per job. (Success criteria #3, #5.)

**Deferred:** concurrency between *different* workers on the *same* instance (Phase 5's
locks/OCC); time-based scheduling (Phase 5); real inbound events (Phase 6 webhook).

**Lessons.** Deterministic jobIds + a current-state idempotency check together give
"effectively-once" processing on an at-least-once queue without any distributed
transaction. The `expectedState` check turned out to also defend against a *stale*
re-delivery (a job enqueued against a state the instance has since left) — a free second
guarantee.

### Phase 5 — Scheduler + Concurrency Protection

**The problem.** Follow-ups must fire automatically over time, and must *stop* when a reply
arrives. And once multiple workers (and a scheduler) can act on the same instance, a race
becomes possible: two jobs advancing one instance could double-transition it.

**What was implemented.**
- A **30 s scheduler poller** (`poller.ts`): query instances with `dueAt <= now` in `AWAITING_REPLY`/`FOLLOWED_UP`, enqueue a `node-execution` job each, with deterministic `triggerRef`s.
- **Optimistic concurrency control** (`updateInstanceStateConditional`): every state write adds `WHERE currentState = expected`. If a concurrent worker already moved the instance, the update matches no row, Prisma throws `P2025`, and the runtime raises `StaleInstanceError` — the job exits cleanly.
- **Redis instance locks** (`lock.ts`): `SET instance:{id} NX PX 30000` acquired before execution, released in `finally`.
- **`dueAt` scheduling in the follow-up executor**: entering `AWAITING_REPLY` sets `dueAt`; the scheduler reads it.
- `harness.ts` (phase5) — three scenarios: auto follow-ups, reply stops follow-ups, concurrent-job race protection.

**Architecture decisions — and a notable deviation.**
- **Poller, not BullMQ delayed jobs.** The original architecture doc proposed BullMQ *delayed jobs* for follow-up timers, cancellable by id on reply. The implementation instead uses a **DB-poll scheduler**: `dueAt` is a column, and a 30 s loop finds what's due. This was a deliberate simplification — `dueAt` in the DB is durable and inspectable, the poll is trivially recoverable after a crash, and "cancellation" becomes *implicit*: a reply transitions the instance out of `AWAITING_REPLY`, so the next poll simply doesn't pick it up. No explicit job to cancel. The tradeoff is up-to-30 s scheduling latency (fine for follow-ups measured in days) vs. the precision of delayed jobs.
- **Both a lock *and* OCC** — belt and suspenders, see below.

**Why both lock + OCC are needed.** They defend different windows:
- The **Redis lock** prevents two workers from *running* `stepInstance` for the same instance at the same time — it serializes execution, avoiding wasted duplicate work and double email sends.
- **OCC** is the *correctness backstop*. Locks can expire (the 30 s TTL), a worker can stall mid-execution, or a lock can be released just as another job reads state. OCC guarantees that even if two writes *do* race to the database, only the one whose `expectedState` still matches wins; the loser becomes a clean `StaleInstanceError`. The lock is an optimization; OCC is the guarantee.

**The exact race discovered, and the fix.** Scenario C in the Phase 5 harness fires two
`node-execution` jobs for the same `AWAITING_REPLY` instance simultaneously:

```
   Job 1                          Job 2
   ─────                          ─────
   read state = AWAITING_REPLY    read state = AWAITING_REPLY
   acquire lock  ✓                acquire lock  ✗ (busy) ──► clean skip
   stepInstance:
     UPDATE … WHERE state=AWAITING_REPLY  ✓  → FOLLOWED_UP
     write events
   release lock
```

Without protection, both jobs would pass the `expectedState` check (both read
`AWAITING_REPLY`), both run the executor, and the instance would transition *twice* —
sending two follow-up emails and writing four events. The harness asserts **exactly one
transition** (≤ 3 events). The lock makes Job 2 a clean skip; and even in the window where
the lock has expired, OCC makes Job 2's `UPDATE … WHERE currentState='AWAITING_REPLY'`
match zero rows (state is now `FOLLOWED_UP`), yielding `StaleInstanceError` and a no-op.
That layered defense is the fix.

**Validated:** a due follow-up fires automatically and increments the counter; a reply
stops follow-up scheduling (the poller finds nothing); reaching `maxCount` →
`NO_RESPONSE`; two concurrent jobs produce exactly one transition. (Success criteria #4
and the concurrency safety behind #2/#5.)

**Deferred:** real Nylas inbound (Phase 6); LangGraph classify/negotiate (Phases 7–8);
the lock is best-effort (no fencing token) — acceptable because OCC is the real guarantee.

**Lessons.** The "lock as optimization, OCC as guarantee" split is the central correctness
insight of the prototype. Trying to make the lock *alone* correct (fencing tokens,
lock renewal) would have been far more complex than the OCC `WHERE` clause, which is one
line and provably correct against the DB.

---

## 8. Phase 3 Runtime Walkthrough

What happens, step by step, when `runtime.stepInstance(instanceId)` is called. (Code:
`server/src/engine/runtime.ts`.)

```
stepInstance(instanceId)
   │
   ├─1► loadContext(instanceId)
   │      findInstanceById → findCreatorById → findVersionById
   │      parse version.nodeGraph (JSON) → NodeSnapshot[]
   │      resolve current node by currentNodeId (or lowest order)
   │      return { instance, node, nodeGraph, creator }
   │
   ├─2► guard: if isTerminal(currentState) → throw (can't step a finished instance)
   │
   ├─3► dispatch(ctx)  →  the executor for node.type
   │      e.g. FOLLOW_UP → executeFollowUp(ctx, email, agent)
   │      returns a NodeResult { nextState, nextNodeId, dueAt?, eventType, … }
   │
   ├─4► assertTransition(currentState, result.nextState)
   │      throws InvalidTransitionError if the move is illegal
   │
   ├─5► build the update patch (currentState, currentNodeId, + any counters/dueAt/completedAt)
   │
   ├─6► PERSIST (OCC):
   │      updateInstanceStateConditional(id, expected=currentState, patch)
   │      └─ UPDATE … WHERE id=? AND currentState=expected
   │         if 0 rows → P2025 → returns null → throw StaleInstanceError
   │
   ├─7► appendEvent(domain event)         // OUTREACH_DRAFTED / FOLLOW_UP_DUE / …
   │
   ├─8► if state changed: appendEvent(STATE_TRANSITION {from, to})
   │
   └─9► return loadContext(instanceId)    // fresh context after the step
```

The shape — **Load → Execute → Validate → Persist (guarded) → Write events** — is the
template every advancement follows, whether triggered by the harness, a worker, or the
scheduler. Steps 4 and 6 are the two safety gates: the state machine rejects *illegal*
transitions, and OCC rejects *stale* ones.

---

## 9. Phase 4 Event System

### The two queues

| Queue | Trigger | Job payload | Idempotency key |
|---|---|---|---|
| `node-execution` | scheduler / manual / chained | `{instanceId, expectedState, triggerRef}` | `expectedState` (re-read live state) |
| `inbound-email` | reply (mocked; Nylas webhook in P6) | `{instanceId, externalMessageId, threadId, subject, body, mockIntent?}` | `externalMessageId` (message-row exists) |

### Job IDs and dedup

`enqueueNodeExecution` builds `jobId = node-exec|{instanceId}|{expectedState}|{triggerRef}`.
`enqueueInboundEmail` builds `jobId = inbound|{externalMessageId}`. BullMQ refuses to add a
second job with an existing jobId (within waiting+active), so a retrying producer can't
duplicate work. (`|` not `:` — BullMQ v5 constraint.)

### node-execution worker sequence

```
Producer            BullMQ              Worker                     DB / Redis
   │   enqueue         │                   │                          │
   ├──────────────────►│                   │                          │
   │                   │   deliver         │                          │
   │                   ├──────────────────►│                          │
   │                   │     findInstanceById ────────────────────────►│
   │                   │     state == expectedState?  ── no ─► SKIP (return)
   │                   │     isTerminal? ── yes ─► SKIP                │
   │                   │     acquireLock(instanceId) ─────────────────►│ (Redis SET NX)
   │                   │       busy? ─► SKIP                           │
   │                   │     runtime.stepInstance()  (Load→…→Persist)  │
   │                   │       StaleInstanceError? ─► clean skip       │
   │                   │     releaseLock() (finally) ─────────────────►│
   │                   │◄── ack ───────────│                          │
```

### inbound-email worker sequence

```
   deliver job
      │
      ├─ findMessageByExternalId(externalMessageId) ─ exists? ─► SKIP (already processed)
      ├─ findInstanceById ─ terminal? ─► SKIP
      ├─ acquireLock ─ busy? ─► SKIP
      ├─ runtime.injectReply(…)   // persists INBOUND Message (anchored on externalMessageId),
      │                           // transitions → REPLY_RECEIVED (OCC-guarded)
      ├─ runtime.stepInstance()   // runs executeReplyDetection → NEGOTIATING / REJECTED / OPTED_OUT
      └─ releaseLock (finally)
```

Note the subtlety: `injectReply` persists the `Message` using the job's
`externalMessageId` as the anchor, so the *next* delivery's idempotency check
(`findMessageByExternalId`) can find it. The idempotency key and the persisted row are
deliberately the same id.

### Retry behavior

`DEFAULT_JOB_OPTIONS`: 3 attempts, exponential backoff (immediate → 5 s → 25 s).
Completed jobs are removed after 24 h; the last 100 failed jobs are kept for diagnostics.
Because handlers are idempotent, a retry after a partial failure re-runs safely.

### Harness validation (Phase 4)

`npm run harness:phase4` starts both workers in-process and runs three tests:
1. a `node-execution` job advances an instance and writes events;
2. an `inbound-email` job drives the reply path;
3. re-delivered jobs (duplicate jobId, and a *stale* re-delivery with an outdated `expectedState`) produce **no** extra transitions.

---

## 10. Phase 5 Scheduler and Concurrency Protection

### The scheduler / poller

`startPoller(intervalMs = 30_000)` runs `poll()` immediately and then every interval:

```
poll():
  instances = listDueInstances()      // dueAt <= now AND state ∈ {AWAITING_REPLY, FOLLOWED_UP}
  for each:
     triggerRef = "sched-{id}-{state}-{dueAt-with-colons-replaced}"
     enqueueNodeExecution({ instanceId, expectedState: state, triggerRef })
```

The `triggerRef` is **deterministic from (id, state, dueAt)**, so two overlapping polls
produce the *same* jobId and BullMQ dedups them — the poller is safe to run concurrently
with itself.

### dueAt — the schedule

The follow-up executor sets `dueAt` when entering `AWAITING_REPLY` (= `now + interval`).
The scheduler reads it. When a follow-up is sent (`AWAITING_REPLY → FOLLOWED_UP`), `dueAt`
is cleared; when it re-enters `AWAITING_REPLY`, a fresh `dueAt` is set for the next window.
On `NO_RESPONSE`, `dueAt` is cleared permanently.

### Implicit follow-up cancellation

There is no explicit "cancel the follow-up job." A reply transitions the instance to
`REPLY_RECEIVED` (then onward). Because `listDueInstances` only selects `AWAITING_REPLY` /
`FOLLOWED_UP`, the next poll simply doesn't see it. **The reply cancels the follow-up by
moving the instance out of the scheduler's view** — a direct consequence of choosing a
poller over delayed jobs.

### Redis locks + OCC (and why both)

- **Lock** (`lock.ts`): `SET instance:{id} NX PX 30000`. Serializes *execution* — at most one worker runs `stepInstance` per instance. Best-effort (TTL can expire); it's an optimization.
- **OCC** (`updateInstanceStateConditional`): `UPDATE … WHERE currentState = expected`. The *correctness guarantee* — even if two writes race the DB, only the one whose expected state still holds commits; the other becomes `StaleInstanceError`.

```
   Without protection            With lock + OCC
   ─────────────────             ───────────────
   J1 reads AWAITING_REPLY       J1 reads AWAITING_REPLY, locks ✓
   J2 reads AWAITING_REPLY       J2 reads AWAITING_REPLY, lock busy → skip
   J1 UPDATE → FOLLOWED_UP       J1 UPDATE WHERE state=AWAITING_REPLY ✓ → FOLLOWED_UP
   J2 UPDATE → FOLLOWED_UP   ✗   (J2 never ran; or if lock expired:
   2 emails, 4 events            J2 UPDATE WHERE state=AWAITING_REPLY → 0 rows → Stale → no-op)
   ── DOUBLE TRANSITION ──       ── exactly one transition, ≤3 events ──
```

### StaleInstanceError

Thrown by the runtime when the OCC update matches no row. Workers catch it and treat it as
a clean skip (not a failure — the work was already done by the winner). This is what turns
a race into a no-op instead of a crash or a duplicate.

---

## 11. Harnesses and Validation

The prototype has no test framework yet (that's Phase 10). Validation is done by three
**harnesses** — runnable scripts that drive real scenarios against a real Postgres/Redis
and assert outcomes. They are the executable spec for Phases 3–5.

All three load the seeded version `wfv_seed_v1` and require ≥ 3 seeded instances. They run
with `NODE_ENV=production` to silence Prisma query logs.

### Phase 3 harness — `npm run harness`

Engine correctness on stubs, in-process, no queues. Three paths:

| Path | Drives | Asserts |
|---|---|---|
| A — Happy | positive reply, counter-then-accept | reaches `ACCEPTED`; trace and event/message counts printed |
| B — Opt-out | `OPT_OUT` reply | reaches `OPTED_OUT` |
| C — No response | exhaust follow-ups | reaches `NO_RESPONSE` at `maxCount` |

Output is the printed state trace for each path. Matters because it proves the completion
and stop rules directly — the loops terminate, opt-out short-circuits, illegal transitions
are impossible.

### Phase 4 harness — `npm run harness:phase4`

Queue/worker correctness. Starts both workers in-process. Three tests: advance-via-queue,
reply-via-queue, and idempotency (duplicate jobId + stale re-delivery produce no extra
transitions). Matters because it proves the queue seam and effectively-once processing.

### Phase 5 harness — `npm run harness:phase5`

Scheduler + concurrency. Three scenarios:

- **A** — back-date `dueAt`, start a 2 s poller, confirm the instance auto-advances `AWAITING_REPLY → FOLLOWED_UP` and counters increment.
- **B** — inject a reply, confirm the instance leaves `AWAITING_REPLY` and the poller then finds nothing to trigger (implicit cancellation).
- **C** — fire two concurrent `node-execution` jobs at one instance; assert exactly one transition (≤ 3 events) — the race-protection proof.

Matters because it proves automatic scheduling, reply-stops-follow-up, and that the
lock+OCC defense actually prevents double transitions.

---

## 12. Current Status (After Phase 5)

| Phase | Deliverable | Status | What exists in the code |
|---|---|---|---|
| 1 | Repository foundation | ✅ Implemented | monorepo, 3 services, health checks, docker-compose, Vite proxy |
| 2 | Data models | ✅ Implemented | full Prisma schema, migration, repository layer, idempotent seed |
| 3 | Workflow runtime engine | ✅ Implemented | state machine, 6 executors, `WorkflowRuntime`, mock providers, harness |
| 4 | Event system (BullMQ) | ✅ Implemented | 2 queues, 2 idempotent workers, retry/backoff, queue routes, harness |
| 5 | Scheduler + locking | ✅ Implemented | 30 s poller, `dueAt` scheduling, Redis locks, OCC, `StaleInstanceError`, harness |
| 6 | Nylas integration | ❌ Not started | mock email provider only; `threadId`/`externalMessageId` fields ready; no `/webhooks/nylas` |
| 7 | Reply classification (LangGraph) | ⚠️ Mocked | `MockAgentProvider.classify` returns a configured intent; agent service is a health stub; no real graph |
| 8 | Negotiation agent (LangGraph) | ⚠️ Mocked | `MockAgentProvider.negotiate` + the bounded loop in `negotiation.ts` work; no real graph |
| 9 | Observability UI (React Flow) | ⚠️ Partial | `countInstancesByNode`/`listInstancesByState` DB hooks + `/queues/*` routes exist; UI is the Phase 1 health page; no React Flow |
| 10 | Testing & validation | ⚠️ Partial | three harnesses cover P3–P5 scenarios; no unit/integration test suite, no versioning-pinning test |

**Legend:** ✅ Implemented · ⚠️ Partially implemented (mock or hooks present) · ❌ Not started.

The important nuance: Phases 7 and 8 are *mocked, not absent*. The **state machine and the
bounded loops are real and validated** — what's mocked is the AI that produces the
classification/negotiation decision. Swapping the mock for a real LangGraph call is an
adapter change behind `IAgentProvider`, not an engine change.

---

## 13. What's Missing

### Phase 6 — Nylas integration

Replace `MockEmailProvider` with a real Nylas adapter (outbound send returning real
message/thread ids) and add a `/webhooks/nylas` handler: verify signature, correlate the
inbound message to an instance by `threadId` (via `findMessagesByThreadId`), persist it,
ack fast, and enqueue an `inbound-email` job. The schema fields (`threadId`,
`externalMessageId`) and the correlation helper already exist; this is the integration
work. **Remaining:** the adapter, the webhook route, signature verification, and sandbox
config.

### Phase 7 — Reply classification

Implement a real `classify` graph in the agent service (`positive`/`negative`/`question`/
`opt-out` + confidence) and call it from the inbound-email worker instead of
`MockAgentProvider`. Add low-confidence handling (the seed config already carries
`lowConfidenceThreshold: 0.6` and a `manual_review` fallback). **Remaining:** the LangGraph
graph, the HTTP call from the worker, and the low-confidence/manual-review path (no
manual-review state exists in the enum yet).

### Phase 8 — Negotiation agent

Implement `draft` and `negotiate` graphs in the agent service. The **bounded loop already
exists** in `negotiation.ts` (counters, `maxRounds` stop rule) and is validated on the
mock — Phase 8 swaps the mock `negotiate` for a real graph applying term floor/ceiling.
**Remaining:** the graphs and the worker→agent HTTP call; the termination logic is done.

### Phase 9 — Observability UI

Build the React Flow pipeline: per-node creator counts (in progress / waiting / failed) via
TanStack Query, an instance inspector (state, message thread, event timeline), and a
timeline endpoint. The DB hooks (`countInstancesByNode`, `listInstancesByState`,
`listEventsByInstance`, `listMessagesByInstance`) exist; the UI and the read API routes do
not. **Remaining:** read API routes, the React Flow canvas, the inspector, structured
logging.

### Phase 10 — Testing & validation

A real test suite: unit tests for the state machine and stop rules, integration tests for
queue handlers/idempotency, end-to-end scenario tests, and — notably — a **versioning
pinning test** (edit workflow → new version → in-flight instances stay on the old version).
The harnesses are scenario coverage but not a regression suite. **Remaining:** a test
runner, the test files, and the validation report mapping each success criterion.

---

## 14. End-to-End Example

One creator, **Alex Rivera**, from enrollment to `ACCEPTED`, showing every state change,
event, message, queue job, scheduler action, and DB write. This is the happy path with one
follow-up and a one-round negotiation.

### 0. Enrollment (seed time)

```
DB writes:  ExecutionInstance {
              creator: Alex Rivera, version: wfv_seed_v1,
              currentState: ENROLLED, currentNodeId: node_import,
              followUpCount: 0, negotiationRound: 0, dueAt: null
            }
```

### 1. Import → Outreach (node-execution job)

A `node-execution` job (`expectedState: ENROLLED`) is delivered. The worker locks the
instance and calls `stepInstance`.

```
node_import (IMPORT_CREATOR_LIST):  no-op gate
  state: ENROLLED → ENROLLED   (node pointer → node_outreach)
  Event: NODE_COMPLETED

next step (node_outreach, INITIAL_OUTREACH):
  email.draft() + email.send()  → mock messageId/threadId
  Message: OUTBOUND "Collaboration opportunity — Alex Rivera"
  state: ENROLLED → OUTREACH_SENT  (node pointer → node_followup)
  Events: OUTREACH_DRAFTED, STATE_TRANSITION{ENROLLED→OUTREACH_SENT}
```

### 2. Enter the follow-up wait (node-execution job)

```
node_followup (FOLLOW_UP), case OUTREACH_SENT:
  dueAt = now + intervals[0]   (3 days, or seconds in test mode)
  state: OUTREACH_SENT → AWAITING_REPLY
  Events: NODE_ENTERED{followUpCount:0, dueAt}, STATE_TRANSITION

DB:  instance.dueAt is now set — the scheduler can see it.
```

### 3. Follow-up fires (scheduler → node-execution job)

30 s poll (or 2 s in the harness) finds `dueAt <= now`, enqueues a job with
`triggerRef = sched-{id}-AWAITING_REPLY-{dueAt}`.

```
node_followup, case AWAITING_REPLY (followUpCount 0 < maxCount 3):
  email.draft() + email.send()
  Message: OUTBOUND follow-up
  followUpCount: 0 → 1
  state: AWAITING_REPLY → FOLLOWED_UP   (dueAt cleared)
  Events: FOLLOW_UP_DUE{followUpCount:1}, STATE_TRANSITION

then a reschedule step (node_followup, case FOLLOWED_UP):
  dueAt = now + intervals[1]
  state: FOLLOWED_UP → AWAITING_REPLY
  Events: NODE_ENTERED, STATE_TRANSITION
```

### 4. Reply arrives (inbound-email job)

Alex replies "Yes I'm interested!". An `inbound-email` job is enqueued
(`externalMessageId` unique).

```
worker: findMessageByExternalId → not found (first delivery) → proceed
  acquireLock ✓
  injectReply():
     Message: INBOUND "Yes I'm interested!" (anchored on externalMessageId)
     state: AWAITING_REPLY → REPLY_RECEIVED  (OCC-guarded)
     Events: INBOUND_REPLY_RECEIVED, STATE_TRANSITION

  stepInstance() → node_reply_detection (REPLY_DETECTION):
     agent.classify() → { intent: POSITIVE, confidence: 0.95 }
     Message.replyIntent/classifyConfidence updated
     state: REPLY_RECEIVED → NEGOTIATING  (node pointer → node_negotiation)
     Events: REPLY_CLASSIFIED, STATE_TRANSITION
```

The instance is now out of `AWAITING_REPLY`, so the scheduler will never fire another
follow-up for it — the reply **implicitly cancelled** the follow-up schedule.

### 5. Negotiation (node-execution jobs)

```
node_negotiation (NEGOTIATION), round 0:
  agent.negotiate(0) → { outcome: "counter" }   (mock: counter until round 1)
  Message: OUTBOUND counter-offer
  negotiationRound: 0 → 1
  state: NEGOTIATING → NEGOTIATING (self-loop)
  Events: NEGOTIATION_TURN{round:1}

node_negotiation, round 1:
  agent.negotiate(1) → { outcome: "accept" }
  Message: OUTBOUND acceptance confirmation
  state: NEGOTIATING → ACCEPTED   (completedAt set)
  Events: NEGOTIATION_TURN{outcome:accept, round:1}, STATE_TRANSITION
```

### Final state

```
ExecutionInstance:
  currentState: ACCEPTED        ← terminal
  currentNodeId: null
  followUpCount: 1
  negotiationRound: 1
  completedAt: <timestamp>
  dueAt: null

Messages (chronological):
  OUTBOUND  initial outreach
  OUTBOUND  follow-up
  INBOUND   "Yes I'm interested!"   (replyIntent=POSITIVE, confidence=0.95)
  OUTBOUND  counter-offer
  OUTBOUND  acceptance confirmation

Events: NODE_COMPLETED, OUTREACH_DRAFTED, STATE_TRANSITION×n, NODE_ENTERED×2,
        FOLLOW_UP_DUE, INBOUND_REPLY_RECEIVED, REPLY_CLASSIFIED, NEGOTIATION_TURN×2
```

Full state trace:

```
ENROLLED → OUTREACH_SENT → AWAITING_REPLY → FOLLOWED_UP → AWAITING_REPLY
        → REPLY_RECEIVED → NEGOTIATING → NEGOTIATING → ACCEPTED
```

Every arrow is one OCC-guarded write plus a `STATE_TRANSITION` event. Every email is a
`Message`. Every trigger was a queue job. The scheduler fired the follow-up; the reply
stopped it. That is the entire architecture exercised on one creator.

---

## 15. Running the Code

### Prerequisites

| Tool | Version | For |
|---|---|---|
| Node.js | ≥ 20 | server, web |
| Python | ≥ 3.11 | agent |
| Docker | any | Postgres + Redis |

### Setup

```bash
npm install                     # install web + server workspaces
npm run infra:up                # start Postgres + Redis

# DATABASE_URL (.env at repo root):
#   postgresql://pluvus:pluvus@localhost:5432/pluvus_workflow
#   REDIS_URL=redis://localhost:6379

cd server
npm run db:migrate              # apply migrations
npm run db:seed                 # 1 workflow, 1 version, 8 creators, 8 instances
```

### Run the services

```bash
npm run dev                     # server (:3001) + web (:5173) together
npm run dev:server              # server only
# agent:
cd agent && python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000
```

### Run the harnesses (the real validation)

```bash
cd server
npm run harness                 # Phase 3 — engine on stubs (Postgres only)
npm run harness:phase4          # Phase 4 — queues + workers (Postgres + Redis)
npm run harness:phase5          # Phase 5 — scheduler + concurrency (Postgres + Redis)
```

### Manual operator endpoints (server running)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health`, `/health/db` | liveness |
| GET | `/queues/health` | live job counts |
| GET | `/queues/jobs` | recent waiting/active/failed jobs |
| POST | `/queues/node-execution` | advance an instance — `{ "instanceId": "…" }` |
| POST | `/queues/inbound-email` | inject a reply — `{ "instanceId": "…", "mockIntent": "POSITIVE" }` |

---

*This document reflects the codebase through Phase 5. For the original design intent, see
`.claude/docs/` (`source-of-truth.md`, `system-architecture.md`, `implementation-plan.md`).
Where code and docs diverge — most notably the **DB-poll scheduler** instead of BullMQ
delayed jobs — this document describes the code.*
