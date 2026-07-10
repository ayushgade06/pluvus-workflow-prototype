# Manual Escalation Resolution — Design Spec

**Status:** Proposal for review (not yet built)
**Date:** 2026-07-03
**Author:** Pluvus workflow team

---

## 1. The problem

Today, when a run escalates to `MANUAL_REVIEW`, the workflow **hard-stops**. We send the
brand one notification email (`notifications/escalation.ts` → `buildEscalationEmail`) that
says *"open the Manual Queue in the dashboard."* The run is now terminal
(`stateMachine.ts:45`) and will never send another email on its own. A human has to log
into the dashboard, read the whole thread, and manually drive the deal from there.

That's a lot of friction for a brand manager who lives in their inbox. This spec makes the
**escalation email itself actionable**: the brand replies to that email (or clicks a
one-click action link), and the workflow **resumes automatically** based on what they said —
continue, drop, counter, or hand off — without ever opening the dashboard.

### Design decisions locked in (from review)

| Decision | Choice |
|---|---|
| **Reply parsing** | **Structured tokens + AI fallback.** The escalation email tells the brand to reply with an explicit cue (`APPROVE` / `REJECT` / `COUNTER <number>` / `HANDOFF`). We parse deterministically first; only if no token matches do we run the reply through the classification agent. |
| **Ambiguous reply** | **Re-ask once, then hold.** If we can't parse the brand's reply (no token, AI low-confidence), we send one clarification email. If the *next* reply is still ambiguous, we park it in the dashboard for a human. |
| **Infrastructure** | **New brand-response node + state.** We add a first-class waiting state (`AWAITING_BRAND_DECISION`) and a dedicated executor, so a pending brand decision is a real node in the graph — not just a terminal state with an inbound hook bolted on. |
| **Coverage** | **All *business* decisions, not infra.** Every case where a human makes a genuine business call gets an email-resolution flow. Pure safety/infra failures (circuit open, injection, guard-blocked leak, missing brand) stay dashboard/ops-only — a brand can't "approve" a prompt-injection or a budget leak by email. |

---

## 2. The core mechanism (shared by every resolvable case)

Rather than invent per-case machinery, **one generic brand-decision loop** handles all
business escalations. Each escalation case just supplies (a) the *question* we ask the brand
and (b) a *resolution map* from the brand's answer to the next workflow action.

### 2.1 New state: `AWAITING_BRAND_DECISION`

A waiting state, mirroring how `REWARD_PENDING` / `PAYMENT_PENDING` already work
(`stateMachine.ts:25,32`). It is **not terminal** — the run is parked, waiting on the brand,
and resumes on reply.

Transition-table additions (`stateMachine.ts` `TRANSITIONS`):

```
// Any state that can currently reach MANUAL_REVIEW for a *business* reason instead
// reaches AWAITING_BRAND_DECISION first. MANUAL_REVIEW becomes the fallback the
// brand-decision loop lands on when the brand says "hand off" or goes silent.
AWAITING_BRAND_DECISION: [
  "AWAITING_BRAND_DECISION",   // stay put on an ambiguous reply (re-ask once)
  "NEGOTIATING",               // brand approved a counter / re-opened talks
  "ACCEPTED",                  // brand approved the creator's number
  "REJECTED",                  // brand rejected the deal
  "REWARD_PENDING",            // brand approved → jump straight into reward setup
  "OPTED_OUT",
  "MANUAL_REVIEW",             // brand asked for a full human handoff, or timed out
],
```

And every current `→ MANUAL_REVIEW` business edge (`REPLY_RECEIVED`, `NEGOTIATING`, etc.)
gains a `→ AWAITING_BRAND_DECISION` edge alongside it.

> **Backward-compat:** `MANUAL_REVIEW` stays exactly as-is for the infra/safety cases. We are
> *adding* a parallel resolvable path, not replacing the queue. A brand can always fall back
> to the dashboard, and infra failures still go straight to `MANUAL_REVIEW`.

### 2.2 New DB: `BrandDecision`

Modeled on `BrandNotification` (`db/brandNotifications.ts`), which already gives us
idempotency-keyed notification rows. `BrandDecision` extends that idea to a **round-trip**:

```prisma
model BrandDecision {
  id            String   @id @default(cuid())
  instanceId    String
  instance      ExecutionInstance @relation(...)

  reason        String   // the escalation reason code that triggered this (e.g. "max_rounds_reached")
  question      String   // human-readable question we asked the brand (persisted for the timeline)
  token         String   @unique // opaque token embedded in the reply-to + magic links, matches replies back
  status        BrandDecisionStatus // PENDING | RESOLVED | REASKED | HANDED_OFF | EXPIRED

  // captured context needed to resume without re-deriving it
  contextJson   Json     // creator rate, current round, guard details, etc.

  brandReplyRaw String?  // the brand's raw reply body (audit)
  decision      String?  // parsed decision: APPROVE | REJECT | COUNTER | HANDOFF | AMBIGUOUS
  decisionValue Float?   // e.g. the counter number, when decision = COUNTER

  reaskCount    Int      @default(0) // how many clarification round-trips (cap 1)
  expiresAt     DateTime // silence timeout → MANUAL_REVIEW
  createdAt     DateTime @default(now())
  resolvedAt    DateTime?
}
```

The `token` is the key trick: it's embedded both in the email's `reply-to`/subject and in the
magic-link URLs. When a reply comes back, we match the token → `BrandDecision` → `instanceId`,
exactly the way the payment/reward token flow already matches hosted-form submissions back to
an instance (see `PaymentInfo` token in the Payment Info node).

### 2.3 New executor: `executeBrandDecision`

Lives in `server/src/engine/executors/brandDecision.ts`. Two entry points:

1. **On escalation (outbound):** instead of the executor returning `nextState: "MANUAL_REVIEW"`,
   the resolvable cases return `nextState: "AWAITING_BRAND_DECISION"` and create a
   `BrandDecision` row + send an **actionable** escalation email (the question + reply cues +
   magic links).
2. **On brand reply (inbound):** a new branch in `inboundEmailWorker.ts` — parallel to the
   existing `REWARD_PENDING` / `PAYMENT_PENDING` branches (`inboundEmailWorker.ts:97,147`) —
   routes any reply that carries a decision token (or arrives while the instance is
   `AWAITING_BRAND_DECISION`) into `runtime.handleBrandDecisionReply(...)`.

### 2.4 The parse pipeline (structured tokens + AI fallback)

```
brand reply body
   │
   ├─ 1. deterministic token scan   →  /\b(APPROVE|YES|AGREE)\b/i          → APPROVE
   │                                   /\b(REJECT|NO|DECLINE|PASS)\b/i      → REJECT
   │                                   /\bCOUNTER\b[^0-9]*([\d,.]+)/i       → COUNTER <n>
   │                                   /\b(HANDOFF|HUMAN|CALL ME|DASHBOARD)\b/i → HANDOFF
   │        (a matched token wins immediately — no AI hop)
   │
   ├─ 2. no token?  →  classification agent with a *brand-decision* prompt
   │        returns {decision, confidence, value?}
   │        confidence < 0.50  →  treat as AMBIGUOUS
   │
   └─ 3. AMBIGUOUS  →  reaskCount == 0 ? send one clarification email (stay AWAITING_BRAND_DECISION)
                                       : park in dashboard (→ MANUAL_REVIEW)
```

Reuses the existing classification adapter (`providerFactory.ts` `AgentProviderAdapter`) but
with a new prompt/intent set — so the same circuit-breaker / degradation guarantees apply. If
the agent is **down** while parsing a brand reply, we don't guess: we fall back to re-ask, and
on the second failure park in the dashboard (never silently continue a money decision on a
degraded agent).

### 2.5 Magic-link one-click actions (in scope — built alongside email-reply)

Because we already run a hosted Express surface for the payment form, we add
`GET /brand-decision/:token/approve`, `/reject`, `/counter?amount=`, `/handoff`. The escalation
email renders these as buttons. Clicking one resolves the `BrandDecision` deterministically with
**zero parsing risk**. Both channels ship in the same pass: the free-text email reply (§2.4) and
the one-click buttons are peers — a brand can use either. Building both up front eliminates the
"we couldn't parse your reply" re-ask entirely for brands who click, while the reply path covers
brands who just hit reply.

### 2.6 Silence timeout (72h)

`expiresAt` defaults to **72 hours** (global for now; can be made per-campaign later). A scheduler
sweep (reuse the existing follow-up scheduler seam) moves any `PENDING` `BrandDecision` past
`expiresAt` into `MANUAL_REVIEW` and pings the operator. A brand that never replies never strands
a creator forever.

---

## 3. Per-escalation resolution logic

Legend for the "Resolution" column:
**Ask** = the question we put to the brand · **Map** = brand answer → next workflow action.

### Category A — Reply classification (REPLY_DETECTION node)

The creator's reply couldn't be classified. This *is* a business call (what did the creator
mean?), so it's resolvable.

#### A1 + A2 — `low_confidence_reply` (UNKNOWN intent / confidence < 0.50)
`replyDetection.ts:103-105,140-148`

- **Today:** `→ MANUAL_REVIEW`.
- **New:** `→ AWAITING_BRAND_DECISION`.
- **Ask:** *"We couldn't tell how {creator} meant this reply. Here's what they wrote: «{quoted reply}». How should we read it?"*
- **Map:**
  - `APPROVE` / "they're interested" → `NEGOTIATING` (resume as if `POSITIVE`, enqueue negotiation step exactly like `inboundEmailWorker.ts:216`).
  - `REJECT` / "not interested" → `REJECTED` (terminal).
  - `HANDOFF` → `MANUAL_REVIEW`.
  - `COUNTER <n>` → treat as the creator having proposed `<n>`: `→ NEGOTIATING` seeded with that rate.
  - Ambiguous → re-ask once, then dashboard.

> The brand is doing the one thing the AI couldn't: reading a human's intent. Cheap, high-value.

---

### Category B — Negotiation node

This is the richest bucket and the one you called out explicitly ("ask the brand if they agree
with the user's number"). All run from `NEGOTIATING` (`executors/negotiation.ts`).

#### B9 — `max_rounds_reached` (hard stop before agent) · B11 — `max_rounds_reached_on_counter`
`negotiation.ts:112-126` and `negotiation.ts:303-323`

Negotiation is exhausted. The brand gets **exactly one** more move, and whatever number they
name is **final** — there is no further back-and-forth with the creator.

- **Ask:** *"Negotiation with {creator} reached the max of {maxRounds} rounds. Their latest ask is **{creatorRate}** (your ceiling was {ceiling}, floor {floor}). Do you want to accept their number, or name one final counter? Any number you give is final — we won't negotiate further; the creator can only take it or leave it."*
- **Map:**
  - `APPROVE` (accept their number) → **`ACCEPTED`** → auto-advances into **Reward Setup** exactly as a normal acceptance does (`stateMachine.ts:21`). *This is precisely your example flow.*
  - `COUNTER <n>` → **final-offer path (NOT another negotiation round).** We send the creator a *take-it-or-leave-it* offer at `<n>` and move to a new waiting sub-state that only accepts an accept/reject signal:
    - Creator **accepts** → **`ACCEPTED`** → Reward Setup.
    - Creator **tries to negotiate again / counters** → we auto-reply *"This is our final offer — we can't adjust it further. You're welcome to accept it, otherwise we'll have to pass."* and stay waiting on a clean accept/reject.
    - Creator **rejects** (or stays declining) → **`REJECTED`**.
  - `REJECT` → **`REJECTED`** (terminal).
  - `HANDOFF` → `MANUAL_REVIEW`.

> **Decision (locked):** a brand `COUNTER` here is a **final offer**, not a re-opened round. The
> creator is told explicitly that we cannot negotiate further and may only accept or reject. This
> avoids re-entering the negotiation loop and hitting the same wall.
>
> **Implementation note:** the final-offer wait is a variant of `AWAITING_BRAND_DECISION` but
> waiting on the *creator*, not the brand — effectively a one-shot "final offer sent" state.
> Reuse the reward/payment reply pattern: the creator's reply is classified for accept-vs-not and
> any renegotiation attempt gets the fixed "final offer" auto-reply (mirrors the existing
> "rate is fixed" auto-reply at `rewardReply.ts:175-186` / `paymentReply.ts:82-91`).

#### B10 — `escalated` (agent chose to escalate) — includes B17/B19 (rate above ceiling)
`negotiation.ts:293-301`; upstream `MockNegotiationProvider.ts:63-69`, `negotiate.py:290-374`

The agent escalated because the creator's rate is **above the internal ceiling** (or the
number was unreadable). Instead of dumping this straight into the manual queue, we give the
deal **one automated recovery attempt** at our recommended price *before* ever asking the brand.

**Step 1 — auto-counter at the recommended midpoint (no brand involvement yet).**
When the creator's ask exceeds the ceiling, we make one final counter at the **recommended band
price** — the midpoint of the [floor, ceiling] band (e.g. floor 200 / ceiling 500 → **350**) — and
tell the creator this is our best/final number:

- *"The most we can do for this campaign is **{recommended}**. That's our best offer — are you able to work with it?"*
- Creator **accepts at {recommended}** → **`ACCEPTED`** → Reward Setup. **Deal closed, brand never paged.**
- Creator **rejects / holds at their original (or higher) number** → escalate to the brand (Step 2).

> **Decision (locked):** we do **not** go to the manual queue on the first over-ceiling ask. We
> counter once at the recommended midpoint. Only if the creator still insists on their original
> number (or more) do we page the brand — and at that point **no further negotiation rounds happen**.

**Step 2 — brand approve/reject only (no more counters).**
The creator held above the recommended price, so now it's purely the brand's call to overspend
or walk. **We do not offer the brand a counter here** — negotiation is over.

- **Ask:** *"{creator} won't go below **{creatorRate}**, which is above both our ceiling ({ceiling}) and the recommended price ({recommended}) we already offered. This is now approve-or-reject only — we won't negotiate further. Approve at {creatorRate}, or pass?"*
- **Map:**
  - `APPROVE` → **`ACCEPTED`** at the creator's rate → Reward Setup. (Over-ceiling approval recorded on the event for audit.)
  - `REJECT` → **`REJECTED`**.
  - `HANDOFF` → `MANUAL_REVIEW`.
  - *(No `COUNTER` option — deliberately removed. Any brand reply proposing a new number is treated as needing a human → re-ask once clarifying "approve or reject only", then `MANUAL_REVIEW`.)*

  **Special sub-case — unreadable/`None` rate** (`negotiate.py:368-369`, docstring `:288`):
  the number wasn't parseable, so we can't quote it back and can't compute whether it's over-ceiling.
  Skip the auto-counter (we have no number to compare) and go straight to the brand. **Ask** becomes:
  *"{creator} replied but we couldn't read a clear rate from: «{quoted reply}». What number are they
  proposing?"* → brand replies with `<n>`; we then run `<n>` through the normal over/under-ceiling
  logic (auto-counter at recommended if over, else resume).

#### B12 — `output_guard_blocked` (negotiation draft leaked a bound)
`negotiation.ts:19-36` · guard `guards/outputGuard.ts`

**⚠️ Infra/safety — NOT email-resolvable.** The AI-drafted negotiation email contained a
floor/ceiling/internal-term leak. We must **not** let a brand "approve" sending a draft that
leaks internal budget bounds by firing off a one-word reply — that defeats the guard.

- **Resolution:** stays `→ MANUAL_REVIEW`, dashboard-only. In the dashboard, a human sees the
  blocked draft, edits out the leak, and sends the corrected version. (Optional future: let the
  brand *edit-and-send* via a hosted draft-editor link — but never a blind email "approve".)

#### B13 — `draft_generation_failed` (AI copy null after retries)
`negotiation.ts:38-58`

**Borderline — treat as infra, dashboard-only (recommended).** The `/draft` LLM couldn't
produce offer/counter copy after retries. There's no *decision* for the brand to make — the
issue is that we have no email to send. Email-resolution doesn't fit; the fix is either a
human writing the copy in the dashboard or the retry/degradation path recovering.

- **Resolution:** stays `→ MANUAL_REVIEW`. (Optional: dashboard offers a "generate again" button
  and a manual compose box.)

---

### Category C — Outreach & follow-up output guard (H4)

#### C21 — `output_guard_blocked` on initial outreach · C22 — on follow-up
`initialOutreach.ts:57-61` · `followUp.ts:101-103`

**⚠️ Infra/safety — NOT email-resolvable.** Same reasoning as B12: an AI draft leaked a
budget bound. Outreach quotes *no* money at all, so any number is a leak. A brand approving it
by email would bypass the guard.

- **Resolution:** stays `→ MANUAL_REVIEW`, dashboard-only (edit-and-send). Future enhancement:
  hosted draft-editor link.

---

### Category D — Missing brand context (L4)

#### D23 — Reward Setup · D24 — Payment Info · D25 — Content Brief
`rewardSetup.ts:124-127` · `paymentInfo.ts:92-95` · `contentBrief.ts:75-78`
(shared `guardEscalation.ts` `blockedByMissingBrand`, reason `missing_brand_name`)

**⚠️ Infra/config — NOT email-resolvable by the brand-decision loop, but has a *better* fix.**
`resolveBrandName()` (`campaignContext.ts:88-100`) returned nothing — neither the node config nor
the campaign has a real brand name. The email we'd send the brand would itself say *"Hi your
brand team"* — the exact bug the escalation prevents.

- **Resolution:** stays `→ MANUAL_REVIEW`, but with a **targeted, one-field fix**: the escalation
  email/dashboard asks *"What brand name should we use in emails to creators?"* The brand replies
  with a name (or fills one field in the dashboard), we write it back to
  `campaign.brand` / node config, and the run **re-runs the same node** (reward/payment/content-brief)
  — now with a resolvable name — instead of resuming a negotiation.
- This is a `BrandDecision` variant where the "decision" is a **config value**, not APPROVE/REJECT.
  Same token machinery, different resolution: `decisionValue` → `campaign.brand`, then re-enqueue
  the blocked node.

---

### Category E — Reward-setup output guard

#### E26 — `output_guard_blocked` on the reward-confirmation draft
`rewardSetup.ts:147-150` (shared `blockedByGuard`)

**⚠️ Infra/safety — NOT email-resolvable.** Same class as B12/C21 — a draft leaked a bound.
Dashboard edit-and-send.

---

### Infra/degradation sources (feed A & B, never independently resolvable)

These are the upstream causes that surface *as* UNKNOWN or `escalate`. They are **not**
separate brand-facing cases — they're why the resolvable cases above sometimes fire. Listed so
coverage is explicit:

| Source | Ref | Handling |
|---|---|---|
| Classification provider down / circuit open / timeout | `providerFactory.ts:187-194` | Surfaces as A1 UNKNOWN. If the agent is *also* down when parsing the **brand's** reply → re-ask, then dashboard. Never auto-continue on a degraded agent. |
| Injection detected (creator reply) | `classify.py:180-185`, `MockClassificationProvider.ts:160-161` | Surfaces as A1 UNKNOWN, **but** we tag `contextJson.injectionSuspected=true`. The brand-decision email shows the raw reply so the brand can see the injection and choose `HANDOFF`/`REJECT`. We do **not** auto-map an injected reply to APPROVE even if the brand types "yes" — an injection flag forces at least a re-ask + warning. |
| Classification malformed / low-confidence / timeout | `classify.py:123-136,213-231` | Surfaces as A1. Same as above. |
| Negotiation provider down / circuit open / timeout | `providerFactory.ts:210-217`, `providers.ts:317-322`, `negotiate.py:1225-1228` | Surfaces as B10 `escalate`. The brand-decision loop still works (it asks the brand about the *creator's* number, which we have from the thread — we don't need the agent to ask the brand). If the agent is still down when the brand replies with free text → re-ask, then dashboard. |

---

## 4. Coverage summary

| # | Case | Reason code | Resolvable by brand email? | Resolution |
|---|---|---|---|---|
| A1/A2 | Unclassifiable creator reply | `low_confidence_reply` | ✅ Yes | Brand reads intent → NEGOTIATING / REJECTED / handoff |
| B9/B11 | Max negotiation rounds | `max_rounds_reached[_on_counter]` | ✅ Yes | Approve→ACCEPTED, or **final** counter (take-it-or-leave-it), Reject→REJECTED |
| B10 | Agent escalate / rate above ceiling | `escalated` | ✅ Yes | Auto-counter at recommended midpoint first; if creator holds → brand **approve/reject only** |
| B10* | Unreadable creator rate | `escalated` | ✅ Yes | Brand supplies the number → normal over/under-ceiling logic |
| B12 | Negotiation draft leaked bound | `output_guard_blocked` | ❌ No (safety) | Dashboard edit-and-send |
| B13 | Draft generation failed | `draft_generation_failed` | ❌ No (no decision) | Dashboard / regenerate |
| C21 | Outreach draft leaked bound | `output_guard_blocked` | ❌ No (safety) | Dashboard edit-and-send |
| C22 | Follow-up draft leaked bound | `output_guard_blocked` | ❌ No (safety) | Dashboard edit-and-send |
| D23/24/25 | Missing brand name | `missing_brand_name` | 🟡 Config-fix | Brand supplies name → re-run node |
| E26 | Reward-confirm draft leaked bound | `output_guard_blocked` | ❌ No (safety) | Dashboard edit-and-send |

**8 of the 10 reason-code buckets get an email or one-field self-serve fix.** The 2 remaining
buckets are pure safety leaks that must never be waved through by a one-word reply.

---

## 5. What we'd build (implementation checklist)

1. **Schema:** `BrandDecision` model + `BrandDecisionStatus` enum + migration.
2. **State machine:** add `AWAITING_BRAND_DECISION` state + transition edges (`stateMachine.ts`).
3. **Executor:** `executors/brandDecision.ts` — outbound (create decision + actionable email)
   and the resolution mapper (answer → next state).
4. **Escalation email:** upgrade `buildEscalationEmail` (`notifications/escalation.ts`) to a
   per-reason **question + reply-cue + magic-link** template.
5. **Inbound routing:** new branch in `inboundEmailWorker.ts` (parallel to REWARD/PAYMENT) →
   `runtime.handleBrandDecisionReply`.
6. **Parse pipeline:** deterministic token scanner + AI fallback (new brand-decision intent set
   on the classification adapter).
7. **Magic-link endpoints** (optional, recommended): `/brand-decision/:token/{approve,reject,counter,handoff}`.
8. **Timeout sweep:** `expiresAt` → `MANUAL_REVIEW` in the existing scheduler.
9. **Config-fix variant** for the `missing_brand_name` cases (write-back + re-run node).
10. **Dashboard:** Manual Queue tab shows `AWAITING_BRAND_DECISION` rows with the pending
    question + a manual-resolve control (covers the non-email cases and the re-ask-exhausted fallback).

---

## 6. Locked decisions

1. **Max-rounds brand counter (B9/B11) is FINAL.** The brand names one number; we send the
   creator a take-it-or-leave-it offer at that number. The creator may only accept or reject —
   any renegotiation attempt gets a fixed "this is our final offer" auto-reply. No further
   negotiation rounds.
2. **Over-ceiling (B10) gets one automated recovery before the brand is paged.** We auto-counter
   once at the **recommended band midpoint** (e.g. floor 200 / ceiling 500 → 350) and tell the
   creator it's our best/final price. If the creator accepts → deal closes, brand never involved.
   Only if the creator holds at their original (or higher) number do we escalate to the brand,
   and then it's **approve-or-reject only** — no counter option for the brand, no more rounds.
3. **Silence timeout = 72h.** A `BrandDecision` still `PENDING` 72 hours after we email the brand
   is swept into `MANUAL_REVIEW` and the operator is pinged, so a silent brand never strands a
   creator. (Global default for now; can be made per-campaign later.)
4. **Magic links AND email-reply — both, in the same pass.** The escalation email carries both
   one-click action buttons (deterministic, zero parse risk) *and* accepts a free-text reply
   (token scan + AI fallback). Neither depends on the other; building both up front removes the
   whole "we couldn't parse your reply" re-ask class for brands who click.
5. **Draft-leak cases (B12/C21/C22/E26) stay dashboard-only.** No hosted edit-and-send surface in
   this pass — a human resolves these in the dashboard. They must never be waved through by a
   one-word email reply, and building an inline draft-editor is out of scope for v1.

*No open questions remain — all design decisions are locked.*
