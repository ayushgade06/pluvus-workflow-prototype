# CRITICAL — Deploy Blockers

These produce visibly wrong outcomes to real brands/creators, leak all data, or silently lose
inbound messages. **None of these can ship.** CRITICAL-1..5 are the true blockers.

---

## [CRITICAL-1] Creator can approve their own escalation

**Where**
- `server/src/routes/webhooks.ts:54-72` — webhook extracts only `id/thread_id/subject/body`; the `from` address is **dropped**.
- `server/src/workers/inboundEmailWorker.ts:147-165` — while an instance is `AWAITING_BRAND_DECISION`, **any** inbound reply on the instance is routed to the brand-decision handler purely by state.
- `server/src/engine/executors/brandDecision.ts:286-288` — `executeBrandDecision` reads `.at(-1)` of ALL inbound messages regardless of sender or thread.
- `server/src/engine/brandDecisionParse.ts:37-40` — `APPROVE_RE` matches bare `YES|OK|OKAY|SOUNDS GOOD` anywhere in the reply.
- `server/src/engine/executors/brandDecision.ts:359-387` — APPROVE closes at `approvedRate = context.creatorRate` (the creator's own ask).

**Problem**
A creator whose over-ceiling ask triggered a B10 escalation can reply "APPROVE" or "sounds good" on
their own thread. The system parses it as the *brand* approving and closes the deal at the creator's
over-budget rate. The party the system is designed to distrust resolves the escalation in their own favor.

**Fix**
1. In the webhook, extract and persist the sender address (`from`). Add it to the inbound job payload
   and to the `Message` row (add a column if none exists).
2. In the brand-decision branch of `inboundEmailWorker` and in `executeBrandDecision`, require the
   decision-bearing message to originate from the campaign's `notifyEmail` (brand) address, AND/OR carry
   the brand-decision token. A message from the creator's address on the creator thread must NOT be
   treated as a brand decision — route it back into negotiation or hold it.
3. Narrow `APPROVE_RE` to the literal instructed cue (`APPROVE`) or first-line match only (see MED for
   the general keyword-looseness fix; the sender check is the load-bearing part here).

**Verify**
- Add a test: instance in `AWAITING_BRAND_DECISION`, inbound from the creator address saying "sounds good"
  → must NOT transition to ACCEPTED. Inbound from `notifyEmail` saying "APPROVE" → transitions to ACCEPTED.

**Blast radius**
Webhook payload shape, inbound job schema, `Message` schema (migration), brand-decision routing. Pairs
tightly with CRITICAL-2 (brand replies must be able to route in the first place).

---

## [CRITICAL-2] Brand-decision email replies can never route back

**Where**
- `server/src/engine/executors/brandDecision.ts:162-170` — `openBrandDecision` emails the brand via bare
  `email.send()` with **no `Message` row persisted**.
- `server/src/routes/webhooks.ts:139-147` — inbound replies are correlated to an instance via
  `findMessagesByThreadId`; with no outbound Message row, the brand's reply finds no thread and is dropped.
- `server/src/notifications/escalation.ts:240` — same bare-send hack duplicated.

**Problem**
The brand's email reply to an escalation cannot be correlated to the instance, so email-based brand
decisions silently never route (documented behavior — see memory `escalation-bucket-testing`). This is
also *why* CRITICAL-1 is exploitable: the only reply that CAN reach the handler is the creator's.

**Fix**
1. Persist brand outbound as a `Message` row with the thread id (reuse `sendOnce` /
   `server/src/engine/executors/idempotentSend.ts`), so the reply correlates by thread.
2. Fix the `IEmailProvider` contract to carry proper `to`/`reply-to` instead of forging a Creator-shaped
   object (`providers.ts:18-28`); the brand-as-Creator hack is the root of the missing persistence.

**Verify**
- Send an escalation; confirm a `Message` row exists with the brand thread id; simulate a brand reply on
  that thread; confirm it routes to `executeBrandDecision`.

**Blast radius**
`IEmailProvider` signature, all brand-outbound call sites (`brandDecision.ts:162`, `escalation.ts:240`),
Message persistence for outbound-to-brand.

---

## [CRITICAL-3] Approved rate is dropped → wrong fee in final emails

**Where**
- `server/src/engine/executors/brandDecision.ts:380-387` — B9/B10 APPROVE emits a `NEGOTIATION_TURN` event
  carrying `approvedRate` but **no `outcome`/`rate` keys**.
- `server/src/engine/executors/negotiationHistory.ts:57-79` — `buildPriorContextFromEvents` only counts a
  turn when `payload.outcome ∈ {ACCEPT,COUNTER,PRESENT_OFFER}` and reads `payload.rate`; the approval
  contributes nothing.
- `server/src/engine/executors/agreedFee.ts:23-33` — `resolveAgreedFee` then falls back to the last counter
  rate or the **band ceiling**.
- `server/src/engine/executors/contentBrief.ts:117` — Content Brief email states that resolved fee.

**Problem**
After a brand approves a specific rate, the Content Brief / reward email can state a *different* number
(a stale counter or the internal ceiling). The brand sees a fee they never agreed to in the final,
contract-forming email.

**Fix**
On the APPROVE event, emit `outcome: "ACCEPT", rate: approvedRate` in the payload so
`buildPriorContextFromEvents` and `resolveAgreedFee` pick it up. Additionally, make `resolveAgreedFee`
**hard-fail to escalation** rather than fall back to the ceiling when no genuine agreed rate exists —
deterministic code should never invent a fee.

**Verify**
- Test: brand APPROVE at $X → `resolveAgreedFee` returns $X → Content Brief body contains $X, not the
  ceiling. Test: no agreed rate anywhere → escalation, not a fabricated fee.

**Blast radius**
Event payload shape on approval, `resolveAgreedFee` fallback semantics, any executor calling it
(contentBrief, reward, payment).

---

## [CRITICAL-4] Final-round false acceptance (Case 19)

**Where**
- `agent/app/routes/negotiate.py:600-604` — in `_apply_decision_guards`, on the final round a `COUNTER`
  is coerced to `ACCEPT` at the guarded (clamped-to-ceiling) rate.
- `agent/app/routes/negotiate.py:437-440` — the rules path applies the same "final round within ceiling → ACCEPT" close.

**Problem**
Reproduced in all three eval reports: creator says "my absolute floor is $650, and I won't budge" on the
final round; the system ACCEPTs at $475 (clamped to ceiling) and sends an onboarding email confirming
"an agreed rate of $475" for a deal the creator **explicitly rejected**. The coercion is wrong when the
creator's ask is above the ceiling — clamping down and calling it ACCEPT invents an agreement.

**Fix** (aligned with `PRINCIPLES.md` — over-ceiling is a HARD bound, so code escalates)
Before coercing COUNTER→ACCEPT on the final round, check the creator's ask: if the ask is **above ceiling**,
ESCALATE to a human instead of ACCEPT (never auto-commit above budget). Only close when the creator's
number is genuinely within the ceiling. This requires passing the creator's ask into the guard (see
HARD-N1). Because this guard changes the action, HARD-N1.4 applies: the outgoing email must be re-drafted
from the escalate/hold outcome — a "congrats on our agreed rate" draft must never ship for an escalated
turn. (Note: whether the *final-round close itself* stays in code or moves to the LLM's judgment is a
`rules`-fallback concern; under the LLM-default strategy the model decides to close, and this guard only
catches the over-ceiling case as a safety net.)

**Verify**
- The eval's Case 19 must produce ESCALATE, not ACCEPT. Add a machine assertion for it (see HARD-T1).
- Unit test in `agent/tests/test_negotiate_llm_strategy.py`: final round + ask > ceiling → ESCALATE.

**Blast radius**
`_apply_decision_guards` signature (add creator-ask param), `_llm_negotiate_decision` call site
(`negotiate.py:882`), the locked-in test `test_final_round_counter_closes_at_offer` (must be updated —
its current semantics are the bug).

---

## [CRITICAL-5] Entire Express API has no authentication

**Where**
- `server/src/index.ts:54-102` — all routes mounted with zero auth: `/campaigns`, `/workflows`, `/creators`,
  `/manual-queue`, `/queues`, `/observability`, `/uploads`.
- `server/src/observability/repository.ts:210-231,344-355,407-419` — `/observability` returns creator
  name/email/handle, full inbound+outbound email bodies, negotiation rates, and guard-leak payloads
  (floor/ceiling values).
- `agent/app/security.py:81-91` — the AI service's `AGENT_API_KEY` auth is off by default with only a log warning.

**Problem**
Anyone who can reach the server reads all creator PII, every email body, and the internal band values
(via leak payloads). Anyone can mutate campaigns/workflows or burn LLM compute.

**Fix**
1. Add auth middleware (shared secret header or session) in front of everything **except** `/webhooks`
   (HMAC-verified), `/payment/:token`, `/brand-decision/:token`, and `/health`.
2. Make the AI service fail startup when `AGENT_API_KEY` is unset outside dev (`security.py:81-91`).
3. Mask leak values in observability event payloads (see EASY for the redaction detail).

**Verify**
- Unauthenticated GET `/observability` → 401. Authenticated → 200. `/webhooks` and token pages still work
  without the app auth header.

**Blast radius**
Every route registration, the web frontend (must send the auth header/session), AI service startup.

---

## [CRITICAL-6] Inbound replies silently and permanently lost (three paths)

**Where**
- `server/src/workers/inboundEmailWorker.ts:70-74` — lock-busy: worker logs "skip" and **returns success**,
  so the job completes, the Message is never persisted, and there is no retry.
- `server/src/engine/runtime.ts:327-351` — `injectReply` persists the Message row **before** `assertTransition`.
- `server/src/engine/stateMachine.ts:12,23` — OUTREACH_SENT and NEGOTIATING have no `→REPLY_RECEIVED` edge.
- `server/src/workers/inboundEmailWorker.ts:48-54` — the `externalMessageId` idempotency check short-circuits
  every retry after the row exists.

**Problem**
Three distinct ways a legitimate creator reply is accepted by the webhook but never processed:
(a) arrives while the instance is locked → dropped; (b) arrives in a state with no accepting edge →
persisted, then `assertTransition` throws, then retries no-op because the row already exists; (c) any
non-OCC failure after persistence strands the instance at REPLY_RECEIVED (which the poller never covers).

**Fix**
1. Lock-busy must **throw** (let BullMQ retry with backoff), not return success.
2. Split "persisted" from "processed": the idempotency short-circuit should only fire when the message was
   fully *processed*, not merely persisted. Track a processed flag or check instance state advanced.
3. Buffer replies arriving in non-accepting states (add accepting edges or a holding state) instead of
   throwing after persistence.

**Verify**
- Fire two concurrent inbounds on one instance → both eventually processed (one retried), neither lost.
- Inbound arriving in NEGOTIATING (mid-turn) → not dropped.

**Blast radius**
Inbound worker control flow, idempotency semantics, possibly state-machine edges or a new holding state.
Interacts with the Redis lock soundness fix (HARD-R2).
