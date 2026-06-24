# Phase 9 — Workflow Observability Dashboard

A read-only operational view over the Pluvus V2 workflow engine. It answers, without database access:

1. Where is each creator right now?
2. Why are they there?
3. What happened before?
4. What message was sent / received?
5. What did the AI decide?
6. Which queue/job/worker drove each transition?
7. Can we trace one creator from enrollment to a terminal state?

This is **not** a workflow builder or campaign manager — it is an execution inspector. Phase 9 adds no execution logic; the only engine touch-points are (a) structured transition logging and (b) persisting a transition `source` onto the existing `STATE_TRANSITION` event payload so attribution survives in the database.

---

## 1. Architecture summary

```
┌──────────────────────────── web (Vite :5173) ────────────────────────────┐
│  React + TypeScript + React Flow + TanStack Query                         │
│                                                                           │
│  App ── Topbar (totals, live indicator)                                   │
│      ├─ WorkflowCanvas (React Flow)  ── StateNode × 11 (live counts)      │
│      ├─ NodeDrilldown (creators in selected state, sort/filter)           │
│      └─ InstanceInspector ── Timeline | MessageThread | AgentDecisions    │
│                                          | LogsTrace                       │
│                         polls every 6 s  │                                 │
└──────────────────────────────────────────┼───────────────────────────────┘
                                  /api proxy │  (vite.config.ts)
┌──────────────────────────────────────────▼─────── server (Express :3001) ─┐
│  routes/observability.ts  (read-only DTO endpoints)                        │
│        │                                                                   │
│  observability/repository.ts  ── DTO mappers + derived metrics             │
│        │            (avg time-in-state, stuck detection, agent decisions)  │
│  observability/dto.ts     (the only shapes the client ever sees)           │
│  observability/logger.ts  (structured [transition]/[trace] log lines)      │
│        ▲                                                                    │
│        │ logTransition() + persisted `source`                              │
│  engine/runtime.ts · workers · scheduler   (UNCHANGED execution logic)     │
└────────────────────────────────────────────────────────────────────────── ┘
                         Postgres (Neon) · Redis (BullMQ)
```

Key principle preserved: **workers remain the only writers of execution state.** The dashboard reads; it never mutates.

---

## 2. APIs added (`/observability`)

All responses are DTOs from `observability/dto.ts` — no raw Prisma rows, timestamps serialized as ISO strings.

| Method & path | Returns |
| --- | --- |
| `GET /observability/meta` | Canonical state list, terminal states, waiting states (so the canvas isn't hardcoded). |
| `GET /observability/workflow` | Workflow summary: per-state `count / active / waiting / stuck / avgTimeInStateSeconds`, totals. |
| `GET /observability/instances?state=&search=&page=&pageSize=` | Paginated, filterable, searchable instance list with `waitingForSeconds`, `stuck`, last event. |
| `GET /observability/instances/:id` | Instance detail: instance + creator + messages + events + extracted agent decisions. |
| `GET /observability/timeline/:id` | Chronological event stream with human summaries + `source`. |
| `GET /observability/logs/:id` | Transition trace: each hop's `from → to`, `source`, `worker`, `queueJobId`, `nodeId`. |

Derived metrics computed in the repository (not stored):

- **avgTimeInStateSeconds** — `now − (most recent STATE_TRANSITION whose "to" = current state)`, averaged across instances in the state; falls back to `enrolledAt` for instances that never transitioned.
- **stuck** — instance is in a waiting state (`AWAITING_REPLY` / `FOLLOWED_UP`) and `dueAt` passed more than 1 hour ago (the scheduler should have advanced it).
- **agentDecisions** — extracted from `REPLY_CLASSIFIED` / `MANUAL_REVIEW_FLAGGED` (classification) and `NEGOTIATION_TURN` (negotiation) events.

---

## 3. Components added (`web/src`)

| File | Responsibility |
| --- | --- |
| `api/types.ts` | Frontend mirror of the server DTO contract. |
| `api/client.ts` | `getJson` + TanStack Query hooks; `POLL_INTERVAL_MS = 6000`. |
| `theme.ts` | Design tokens, per-state colours/labels/descriptions, duration/time formatters, source→label map. |
| `components/WorkflowCanvas.tsx` | React Flow canvas; fixed layout mirroring the state-machine transition graph. |
| `components/StateNode.tsx` | Custom node: big count, active/waiting/stuck chips, avg time-in-state, terminal badge. |
| `components/NodeDrilldown.tsx` | Operational queue for the selected state (sort + filter). |
| `components/InstanceInspector.tsx` | Right panel: instance info header + tabbed body. |
| `components/Timeline.tsx` | Vertical event timeline; transitions emphasised. |
| `components/MessageThread.tsx` | Outbound/inbound bubbles; intent + confidence + round. |
| `components/AgentDecisions.tsx` | AI decision cards with confidence bars + reasoning. |
| `components/LogsTrace.tsx` | Per-hop attribution (source / worker / job id). |
| `components/ui.tsx` | Shared `StateBadge`, `SourceBadge`, `Field`, etc. |

---

## 4. React Flow design explanation

The workflow **is** the navigation model (per the brief): you navigate by clicking states, not by browsing a table.

- **Layout** is deliberately hand-placed (not auto-layout) so the diagram reads like the engine's actual transition table in `stateMachine.ts`: a vertical "happy path" spine `ENROLLED → OUTREACH_SENT → AWAITING_REPLY → REPLY_RECEIVED → NEGOTIATING → ACCEPTED`, with branch/terminal states (`FOLLOWED_UP`, `REJECTED`, `MANUAL_REVIEW`, `OPTED_OUT`, `NO_RESPONSE`) fanned to the right.
- **Edges** mirror real transitions, including the `FOLLOWED_UP → AWAITING_REPLY` loop-back and the `NEGOTIATING → NEGOTIATING` self-loop (counter rounds), drawn dashed.
- **Counts live on the nodes.** Each node shows the headline count plus `active / waiting / ⚠ stuck` chips and average time-in-state — readable by a non-engineer at a glance.
- **Selection highlights the relevant edges** (animated, coloured by destination state) so the path in/out of a state is obvious.
- Nodes are non-draggable / non-connectable — this is an inspector, not an editor.

## 5. Inspector design explanation

The inspector is the primary debugging surface. A fixed **instance-info header** (instance id, creator id, workflow + version, current node, round, due, enrolled, last-updated, **last transition source**) sits above a four-tab body:

- **Timeline** — the full chronological event history with a transition spine and per-event source badges.
- **Messages** — the complete conversation: outbound left, inbound right, with classified intent + confidence and negotiation round.
- **AI Decisions** — classification (intent + confidence bar) and negotiation (outcome + round + reasoning) cards.
- **Logs** — the transition trace answering "who triggered each hop" with the worker and queue job id.

Everything polls on the same 6 s interval, so an open inspector updates as the engine advances the creator.

## 6. Logging strategy

`observability/logger.ts` emits two stable, single-line JSON envelopes:

- `[transition] {event:"state_transition", instanceId, creatorId, fromState, toState, source, worker, queueJobId, nodeId, timestamp}`
- `[trace] {event, timestamp, …}` for non-transition observable moments (e.g. `scheduler_enqueued`).

The **same `source` is also persisted** onto the `STATE_TRANSITION` event payload by `runtime.ts`. This is the crucial design choice: end-to-end traceability does not depend on scraping stdout — it is reconstructable from the database via `GET /observability/logs/:id`.

Attribution is resolved as: explicit caller `source` → else inferred from the domain event (`REPLY_CLASSIFIED`/`MANUAL_REVIEW_FLAGGED` ⇒ `classification-agent`, `NEGOTIATION_TURN` ⇒ `negotiation-agent`) → else `node-execution-worker`. Workers pass their `worker` name + BullMQ `job.id`; the scheduler logs its enqueues; `injectReply` self-attributes as `inbound-email`.

Wired consistently across: runtime, node-execution worker, inbound-email worker, scheduler poller.

## 7. Example creator trace

A creator driven live through the queue during the Phase 9 harness (Sofia-style positive path):

```
Timeline (chronological)
  NODE_ENTERED            Entered node node_import          [-]
  OUTREACH_DRAFTED        Outreach email drafted            [-]
  STATE_TRANSITION        ENROLLED → OUTREACH_SENT          [node-execution-worker]
  STATE_TRANSITION        OUTREACH_SENT → AWAITING_REPLY    [node-execution-worker]
  INBOUND_REPLY_RECEIVED  Inbound reply received            [inbound-email]
  STATE_TRANSITION        AWAITING_REPLY → REPLY_RECEIVED   [inbound-email]
  REPLY_CLASSIFIED        Reply classified as POSITIVE 0.95 [-]
  STATE_TRANSITION        REPLY_RECEIVED → NEGOTIATING      [classification-agent]
  …
  STATE_TRANSITION        NEGOTIATING → ACCEPTED            [negotiation-agent]

Transition trace (logs)
  ENROLLED → OUTREACH_SENT       [node-execution-worker / node-execution / node-exec|…|p9-adv-…]
  OUTREACH_SENT → AWAITING_REPLY [node-execution-worker / node-execution / node-exec|…]
  AWAITING_REPLY → REPLY_RECEIVED[inbound-email / – / –]
  REPLY_RECEIVED → NEGOTIATING   [classification-agent / inbound-email / inbound|p9-inbound-…]
  NEGOTIATING → ACCEPTED         [negotiation-agent / inbound-email / inbound|…]
```

Queue Job → Worker → Transition → Event is fully reconstructable for a single creator.

## 8. Validation results

`npm run harness:phase9` drives **real** transitions through BullMQ (workers inline) and asserts the observability repository — the exact code the HTTP routes call — reflects them.

| Scenario | Result |
| --- | --- |
| A — `AWAITING_REPLY → NEGOTIATING` updates counts | ✓ AWAITING_REPLY −1, NEGOTIATING +1 |
| B — `NEGOTIATING → ACCEPTED` updates counts | ✓ NEGOTIATING −1, ACCEPTED +1 |
| C — inspector shows messages, events, state, decisions | ✓ |
| D — timeline reconstructs full history, chronological | ✓ |
| E — logs trace job → worker → transition → event | ✓ source=classification-agent + worker + job id |
| F — successive polls reflect changes | ✓ read-model delta observed |
| API contract — 11 nodes, DTO ISO strings, no raw Prisma | ✓ |

**Regression check:** Phase 3/4/5/7/8 harnesses re-run after the runtime/worker/scheduler edits — see `phase-9-results.md` for the captured run.

## 9. UI walkthrough

1. **Topbar** — workflow name + version, totals (`total / active / terminal / stuck`), a pulsing green "live · 6s" indicator (amber while a fetch is in flight; red "disconnected" if the API is unreachable).
2. **Canvas** — 11 state nodes laid out as the transition graph, each showing its live count and breakdown chips. Empty states are dimmed. A hint card invites the first click.
3. **Click a node** → the **drilldown** drawer opens listing every creator in that state, sortable (longest waiting / name / round / due) and filterable by name/email/handle. Stuck creators are flagged.
4. **Click a creator** → the **inspector** opens on the right with the instance header and the Timeline / Messages / AI Decisions / Logs tabs.
5. **Watch it live** — with the engine running, the scheduler/workers advance creators; node counts, drilldown lists, and the open inspector all update on the next poll without a refresh.

(Run locally with `npm run dev` from the repo root, then open `http://localhost:5173`.)

## 10. Remaining limitations

- **Polling, not push.** Updates lag by up to the poll interval (6 s). A websocket/SSE feed would make it instant; polling was chosen per the brief and to avoid new infra.
- **avgTimeInState is a snapshot estimate** — time *currently* spent in the present state, derived from the latest entry transition. It is not a historical mean across all instances that ever passed through, and instances predating the demo seed have `null`/approximate values.
- **`source` on historical rows** — transitions written before Phase 9 carry no `source` (shown as `–`). All new transitions and the demo seed are fully attributed.
- **Single active workflow version.** The canvas visualizes the newest published `WorkflowVersion`; multi-version side-by-side is out of scope.
- **No auth.** The endpoints are open on localhost; production would gate them.
- **No screenshots in this environment** — no headless browser was available; the walkthrough above documents the rendered UI, which builds and serves cleanly (`npm run build`, verified through the Vite dev server + proxy).
- **MANUAL_REVIEW is terminal in the engine**, so re-routing a reviewed creator is not yet an action surfaced in the UI (Phase 9 is read-only by design).
```
