# Pluvus Workflow — Source of Truth

> Distilled from `docs/references/Pluvus v2 Workflow Builder (1st draft).pdf`.
> This is the permanent reference for the prototype. The PDF should not be re-read;
> all execution-architecture decisions derive from this document.
> Scope here is intentionally narrowed to **workflow execution**. Fulfillment,
> payments, content, and attribution concepts from the PDF are summarized only where
> they inform the execution model, and otherwise omitted.

---

## 1. Goals (execution-relevant)

- Replace the rigid, form-based campaign builder with a **workflow-based execution engine**.
- Model campaign steps as **explicit nodes** with visible configuration and clear completion rules.
- Track **per-creator execution state** as the primary unit of work.
- Make **follow-ups automatic, configurable, and cancelable**.
- Keep AI **useful but bounded**: drafting, personalization, reply classification, and negotiation assistance only — AI never owns irreversible commercial decisions.

## 2. Non-Goals (for the prototype)

- No fulfillment, payment collection, shipping, promo-code, or content-delivery nodes (these exist in the product vision but are out of execution-validation scope).
- No conditional branching authoring UI — v1 treats a workflow as a **primary linear path** with explicit pauses, skips, and exits.
- No full analytics/reporting dashboards. Metrics are derivable from execution state but are not a build target.
- No multi-tenant, production-grade auth, or scale hardening.
- No real creator data — creators and campaign data may be **mocked**.

## 3. Core Concepts (the four top-level abstractions)

The PDF defines exactly four top-level concepts. The prototype implements all four.

### 3.1 Workflow
A **campaign definition** composed of ordered nodes. Sequential by default. Conditional branching is deferred; v1 is a primary path with explicit pauses, skips, and exits.

### 3.2 Node
A **configurable workflow step**. Every node shares the same contract:

- **type**
- **collapsed summary** — one-line config + creator counts (in progress / waiting / failed) + warning badge if invalid
- **expanded config panel** — editable fields, validation, preview, completion rules, stop conditions
- **input contract** — required data needed to enter the node
- **output contract** — emitted status, object, or event
- **completion rule** — what marks the node "done"
- **stop conditions** — what cancels, skips, or exits the node

### 3.3 Execution Instance
**One creator running through one workflow version.** This is the **unit of execution, scheduling, and audit** — the central object of the entire system. State lives here, not on the workflow definition.

### 3.4 Campaign Version
Publishing a workflow produces a **version snapshot**. Execution instances stay **pinned to a version** unless explicitly migrated. Editing a published workflow never mutates in-flight instances.

## 4. Sequence-level vs Node-level controls

A recurring design principle: **sequence-level controls are distinct from node-level controls.** Schedules and global rulesets sit at the workflow level; field edits, timing between steps, and stop logic sit at the node level. The execution engine must respect both layers.

## 5. Prototype Workflow Scope

The prototype implements exactly this linear path:

```
Import Creator List → Initial Outreach → Follow-Up → Reply Detection → Negotiation → End
```

Node responsibilities (execution view only):

| Node | Core purpose | Key execution fields | Primary output |
|------|--------------|----------------------|----------------|
| **Import Creator List** | enroll a (mocked) creator set as execution instances | source list, dedup | execution instances created |
| **Initial Outreach** | first contact via email | sender, subject, body template, AI personalization depth | outbound message sent |
| **Follow-Up** | automated non-reply pursuit | enabled, intervals, max count | follow-up sent or skipped |
| **Reply Detection** | classify inbound replies | (consumes inbound email events) | reply intent event (positive / negative / question / OOO) |
| **Negotiation** | bounded back-and-forth on terms | stage templates, tone, progression, stop rules | accepted / countered / rejected |
| **End** | terminal state | — | instance closed (won / lost / opted-out) |

Everything beyond Negotiation in the product vision (Reward Setup, Payment Info, Product Access, Shipping, Promo Code, Content Brief, Draft Review, Content Live, Attribution) is **explicitly out of scope** for this prototype.

## 6. Creator Lifecycle (execution states)

The per-creator execution instance moves through states driven by node outputs and inbound events:

```
ENROLLED
  → OUTREACH_SENT
  → AWAITING_REPLY  (follow-ups scheduled here)
  → FOLLOWED_UP     (loops back to AWAITING_REPLY until max follow-ups)
  → REPLY_RECEIVED  (reply classified)
  → NEGOTIATING     (loops on counter-offers until terms/stop)
  → terminal: ACCEPTED | REJECTED | OPTED_OUT | NO_RESPONSE
```

Key transition rules:
- A reply at any waiting state **cancels pending follow-ups**.
- Follow-ups stop at `max count` → `NO_RESPONSE` if still no reply.
- Negotiation is a **bounded loop** with explicit stop rules; it does not run indefinitely.
- Opt-out is a terminal short-circuit reachable from any state.

## 7. Execution / Runtime Model (the assumptions to validate)

- **Execution instance is the scheduling unit.** Work is scheduled per-instance, not per-workflow.
- **Event-driven advancement.** Instances advance on two trigger types: **time** (a scheduled follow-up becomes due) and **inbound events** (an email reply arrives). Node completion rules and stop conditions decide the next state.
- **Versioning is snapshot-based.** Instances execute against the workflow version they enrolled under.
- **AI is invoked at bounded points only**: outreach/follow-up drafting & personalization, reply classification, and negotiation assistance. AI orchestration is the LangGraph layer's job; it returns proposals/classifications, not commits.

## 8. Success Criteria (for the prototype)

The prototype is successful when it demonstrates, end to end on mocked data:

1. **Workflow execution engine** advances execution instances through the linear node path with correct completion/stop semantics.
2. **Creator state transitions** are correct, auditable, and driven by node outputs + events.
3. **Event-driven execution** works for both time-based (follow-up due) and inbound (reply) triggers.
4. **Scheduling** reliably fires due follow-ups and cancels them when a reply arrives.
5. **Queue processing** decouples scheduling/eventing from node execution.
6. **LangGraph orchestration** produces drafts, classifies replies, and runs the negotiation loop within bounds.
7. **Email integration architecture** (Nylas) sends outreach and ingests replies as events.
8. **Reply handling** maps inbound email → classification → state transition.
9. **Negotiation loops** terminate correctly under stop rules.
10. **Workflow versioning** keeps in-flight instances pinned to their enrolled version.

A traceable, glanceable view of *where each creator is* in the pipeline — the product's headline outcome — falls out naturally once the above hold.
