# Open Questions — Pluvus Workflow Prototype

> Unresolved architectural decisions, with a recommended direction for each. These are
> the bets to confirm during implementation. Recommendations favor **simplicity and fast
> validation** over premature scale, per the prototype's mandate. Revisit when a phase
> surfaces contradicting evidence.

---

## 1. Workflow Execution — engine vs. LangGraph orchestration

**Why it matters:** If LangGraph drives the *whole* workflow, the state machine, scheduling, and durability become LangGraph's problem — coupling execution to the AI layer. If LangGraph only does bounded AI steps, the engine stays language-native and testable.

**Options:**
- **(A) TS engine owns execution; LangGraph does only draft/classify/negotiate.**
- (B) LangGraph owns the entire workflow graph including waits and scheduling.
- (C) Hybrid: LangGraph owns the negotiation sub-loop; TS owns everything else.

**Recommended:** **(A).** Keeps the unit-of-execution invariant (workers are the only state writers), makes the engine independently testable on stubs (Phase 3), and matches "AI useful but bounded." This is the assumption the prototype most needs to validate.

---

## 2. Scheduling — how follow-up timers are implemented

**Why it matters:** Follow-ups must fire on time *and* be cancelable the instant a reply arrives. The mechanism affects reliability, cancellation latency, and operational complexity.

**Options:**
- **(A) BullMQ delayed jobs keyed by instance.**
- (B) A `due_at` column + a periodic polling sweeper.
- (C) A dedicated cron/timer service.

**Recommended:** **(A).** Already have Redis/BullMQ; delayed jobs give precise firing and **cancel-by-id**, which makes follow-up cancellation on reply trivial. Avoids a separate service (C) and the latency/load of polling (B). Keep `due_at` persisted too, for audit and recovery.

---

## 3. Event Architecture — how triggers reach the engine

**Why it matters:** Time and inbound triggers must converge on the same transition logic without races or double-processing.

**Options:**
- **(A) All triggers become queue jobs; workers are the single transition path; handlers idempotent.**
- (B) Direct function calls from webhook/scheduler into the engine.
- (C) A full event-sourcing system as the primary store.

**Recommended:** **(A).** One durable path (the queue) means uniform retries, ordering, and audit. Idempotent handlers + state guards prevent double transitions. (B) loses durability; (C) is over-engineering for a prototype — keep the append-only `Event` log for audit without making it the system of record.

---

## 4. Queue Ownership — who enqueues and how queues are partitioned

**Why it matters:** Unclear ownership leads to two writers racing on one instance or duplicated jobs.

**Options:**
- **(A) API/scheduler/webhook enqueue; workers are sole consumers and sole state writers; one in-flight state-mutating job per instance.**
- (B) Workers enqueue freely into each other across many fine-grained queues.
- (C) A single catch-all queue.

**Recommended:** **(A).** Enforce per-instance serialization (e.g., a lock or instance-scoped concurrency) so transitions never race. Use a small, purposeful set of queues (`node-execution`, `inbound-email`, scheduler delayed jobs) — enough separation for clarity (§7 of architecture), not so much that flow becomes hard to trace.

---

## 5. LangGraph Integration — service boundary and statefulness

**Why it matters:** A Python AI layer must integrate with a TS engine without leaking AI state into execution or creating a fragile coupling.

**Options:**
- **(A) Stateless HTTP service; each call gets the context it needs and returns a proposal.**
- (B) Long-running stateful graphs that hold negotiation state across turns.
- (C) Embed via subprocess/IPC.

**Recommended:** **(A).** Stateless calls keep the negotiation loop's termination logic in the worker (so it always bounds), make the agent independently testable, and avoid distributed-state bugs. The engine passes thread/round context per call. Revisit only if per-call context assembly proves too heavy.

---

## 6. Nylas Integration — inbound delivery and correlation

**Why it matters:** Reply handling depends on reliably receiving inbound mail and matching it to the right instance.

**Options:**
- **(A) Nylas webhooks; correlate by thread id; verify signature; fast ack then enqueue.**
- (B) Polling Nylas for new messages.
- (C) Provider-agnostic IMAP.

**Recommended:** **(A).** Push beats polling for latency and load. Correlate on the thread/message ids persisted at send time; if correlation fails, fall back to recipient + recent-window matching and flag for review. Keep Nylas behind a thin adapter so it can be swapped — see §9 (future migration).

**Sub-question:** how to test inbound without manual emailing? Provide a **webhook-simulation harness** that posts synthetic Nylas payloads, so Phases 4–5 don't depend on a live mailbox.

---

## 7. Versioning — snapshot model and migration

**Why it matters:** Editing a live workflow must not corrupt in-flight instances; the source of truth requires instances pinned to their enrolled version.

**Options:**
- **(A) Immutable version snapshots (node graph as JSON); instances reference a version; edits create a new version.**
- (B) Mutable definitions with diff/patch applied to live instances.
- (C) No versioning in the prototype.

**Recommended:** **(A).** Directly satisfies the pinning requirement and is simple to reason about. Migration (moving an instance to a newer version) is **explicit and opt-in** — out of scope to *implement* beyond a stub, but the schema must support it. (C) would skip validating a stated success criterion, so it's rejected.

---

## 8. Scalability — how far to engineer the prototype

**Why it matters:** Over-building for scale slows validation; under-building can hide architectural flaws that only appear under concurrency.

**Options:**
- **(A) Single worker process, modest concurrency, correctness-first; design for horizontal scale but don't build it.**
- (B) Multi-worker, sharded queues, full horizontal scale now.
- (C) Single-threaded, no concurrency concerns at all.

**Recommended:** **(A).** Validate correctness (idempotency, per-instance serialization, exactly-once *effect*) under *some* concurrency so the design is proven scalable, without building the scaled deployment. (C) risks hiding race conditions that the real system will hit; (B) is premature.

---

## 9. Future Migration into Pluvus V2 — what carries over

**Why it matters:** The prototype's purpose is to feed production; decisions that don't survive the move waste effort.

**Options:**
- **(A) Treat engine, state machine, queue contracts, and adapter interfaces as portable; treat mocks, seed data, and the minimal UI as throwaway.**
- (B) Aim to promote the prototype codebase wholesale.
- (C) Treat the prototype as pure research, porting nothing.

**Recommended:** **(A).** Keep the portable core (engine, transitions, queue/job contracts, Nylas/LangGraph adapter interfaces, Prisma model for definition-vs-execution) clean and dependency-light so it transplants into V2. Let mocked creators, seed scripts, and the visualization UI be disposable. This is why the architecture isolates Nylas and LangGraph behind interfaces (architecture §5, §8) — provider/AI swaps shouldn't touch the engine.

---

## Cross-Cutting Risks

- **Idempotency gaps** → double sends or double transitions. Mitigate with state-guarded, re-runnable handlers (Phase 4 acceptance).
- **Follow-up/reply race** → a follow-up fires just as a reply arrives. Mitigate with per-instance serialization and cancel-by-id (Q2/Q4).
- **Unbounded negotiation** → loop never terminates. Mitigate by keeping round count in instance state and checking it in the worker, not the agent (Q5).
- **Webhook correlation failure** → reply orphaned from its instance. Mitigate with persisted thread ids + fallback matching + review flag (Q6).
- **Hidden coupling to Nylas/LangGraph** → blocks V2 migration. Mitigate with adapter interfaces from day one (Q9).
