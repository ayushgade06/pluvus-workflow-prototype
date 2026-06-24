# Project Overview — Pluvus Workflow Prototype

## Problem Statement

The current Pluvus campaign builder is a rigid, form-based tool. Creator-marketing
operations actually depend on **creator-by-creator state**: reply handling, follow-up
timing, negotiation, and clear stop/exit rules. Modern sequence tools (Apollo, HubSpot,
Outreach) model this as **explicit steps with timing, stop rules, and per-step
monitoring** — not as a single static form. Pluvus v2 needs the same: a workflow
execution engine where each creator advances through configurable nodes with visible
state.

Before committing this design into production Pluvus V2, the execution architecture
itself — engine, events, scheduling, queues, AI orchestration, and email integration —
needs to be **validated in isolation**.

## Why This Prototype Exists

This repository is a **focused validation harness for the workflow execution
architecture**. It deliberately strips away the full campaign lifecycle so the hard,
risky parts — eventing, scheduling, state machine correctness, LangGraph orchestration,
and Nylas email round-tripping — can be proven quickly and cheaply on mocked data.

It is **not** a product. It is the thing we build *before* the product to de-risk it.

## Assumptions Being Validated

The prototype exists to confirm or refute these architectural bets:

1. The **execution instance** (one creator × one workflow version) is the right unit of execution, scheduling, and audit.
2. An **event-driven model** (time triggers + inbound email triggers) cleanly drives state transitions through the node path.
3. A **queue (BullMQ/Redis)** is the right seam between scheduling/eventing and node execution.
4. **LangGraph** is a good fit for bounded AI orchestration (drafting, classification, negotiation loop) and integrates cleanly with a TypeScript backend.
5. **Nylas** can both send outreach and reliably ingest replies as events with acceptable latency and fidelity.
6. **Snapshot versioning** keeps in-flight instances stable while definitions evolve.
7. A **bounded negotiation loop** terminates correctly under explicit stop rules.

## Scope

Implements exactly this linear workflow on mocked creator/campaign data:

```
Import Creator List → Initial Outreach → Follow-Up → Reply Detection → Negotiation → End
```

In scope:
- Workflow execution engine + per-creator state machine
- Event-driven advancement (time + inbound)
- Scheduler for follow-ups (and follow-up cancellation on reply)
- Queue processing
- LangGraph agents: outreach drafting, reply classification, negotiation
- Nylas integration architecture: send + inbound webhook ingestion
- Workflow versioning (snapshot + instance pinning)
- A minimal React Flow UI to visualize the pipeline and per-node creator counts

## Non-Scope

- Fulfillment, payments, shipping, promo codes, content brief/review/live, attribution
- Conditional-branching authoring (linear path only)
- Analytics dashboards and reporting metrics as a build target
- Production auth, multi-tenancy, scale/perf hardening
- Real creator data or production email volume

## Success Criteria

The prototype succeeds when, end to end on mocked data, it demonstrates all ten
criteria in [`source-of-truth.md` §8](./source-of-truth.md). In short: the engine
advances creators correctly through the path; events and scheduling fire and cancel as
designed; LangGraph drafts/classifies/negotiates within bounds; Nylas sends and ingests;
and versioning pins in-flight instances. If those hold, the execution architecture is
validated for promotion into Pluvus V2.

## Core Concepts

The system is built on the four abstractions defined in the source of truth:

- **Workflow** — ordered, linear node definition.
- **Node** — a configurable step with input/output contracts, completion rules, and stop conditions.
- **Execution Instance** — one creator × one workflow version; the unit of execution, scheduling, and audit.
- **Campaign Version** — a published snapshot; instances stay pinned to their version.

See [`source-of-truth.md`](./source-of-truth.md) for full definitions and the creator
lifecycle state model.
