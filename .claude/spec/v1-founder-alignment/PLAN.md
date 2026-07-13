# V1 Founder-Alignment Plan

**Status:** Draft for review · **Date:** 2026-07-13 · **Branch (suggested):** `feat/v1-founder-alignment`

This plan translates the founder's 15 answers (product Q&A) into concrete, file-level
code changes against the current codebase. It is organized so the **highest-value,
lowest-risk removal work lands first** (escalation → clean human handoff), then the
negotiation-behavior changes, then the net-new classifier/intent work.

> **Guiding principle (unchanged from the codebase's own PRINCIPLES.md):** the LLM
> *decides / interprets*; the code *guards and commits*. Workers are the only writers
> of instance state. Every trigger is a queue job. We do not violate these.

---

## 0. TL;DR — what changes and why

| Theme | Founder's V1 intent | Today | Change |
|---|---|---|---|
| **Escalation model** (#14) | Escalation = **clean one-way handoff to a human**. No magic links, no email round-trip, no auto-resume. | Elaborate `AWAITING_BRAND_DECISION` loop: emails the brand actionable buttons + magic links, parses their reply, auto-resumes. | **Remove the entire brand-decision loop.** Re-point all escalation call sites to plain terminal `MANUAL_REVIEW` (which already exists + already notifies the brand). |
| **Failed negotiation** (#15) | Auto-**close/reject** — no human by default (volume). | Max-rounds → pages the brand (`AWAITING_BRAND_DECISION`). | Max-rounds-no-agreement → auto-`REJECTED`. |
| **Open position** (#2) | Open at the **floor** (preferred), concede up. | Opens at **midpoint** (`recommendedOfferPosition: 0.5`). | Set open position to `0.0` (floor). |
| **Over-ceiling** (#12) | **Merchant-configurable tolerance** band above max; counter within max inside tolerance; escalate above tolerance. | **Zero tolerance** — hard escalate the moment ask > ceiling. | Add `overCeilingTolerance` config; counter-at-max inside tolerance, escalate above. |
| **Price semantics** (#1) | Reframe min/max as **utility curve** (preferred = 1.0, max = 0.0); every $ over preferred costs more. Relabel "Preferred/Maximum Budget". | 2 flat points, no utility weighting; internal labels `floor`/`ceiling`. | Utility-aware concession + relabel (UI + docs). *(Lower priority; behavior-shaping.)* |
| **Deferred intent** (#3) | New **"Deferred Decision"** intent distinct from pending-reply state; soft follow-up 3–5d; parse creator timeline. | No deferral intent; "I'll think about it" collapses to QUESTION/UNKNOWN. | Add `DEFERRED` intent + scheduled soft follow-up (+ optional timeline parse). |
| **Always-escalate topics** (#4/#5/#9/#11) | Certain topics **always escalate** regardless of confidence: pricing exceptions, legal/contract, disputes/hostile tone, missing terms. | Escalation driven only by confidence + price guards; no topic router. | Add a topic/category gate that escalates independent of confidence. |
| **Final round** (#13) | Offer ≤ ceiling → **auto-accept**. | Already does exactly this (CRITICAL-4). | **No change.** ✅ |
| **Commission / sweeteners** (#6/#7/#8) | V1: only fee negotiable; commission fixed; no sweeteners. | Exactly this. | **No change** (maybe minor config surfacing). ✅ |

---

## 1. Phase A — Escalation → clean human handoff (the big one) 🔴

**Founder answers driving this:** #14 (no human counteroffer / clean handoff), and it
enables #15. This is primarily **deletion + re-pointing**, not new building. The
`MANUAL_REVIEW` terminal state, the Manual Queue dashboard, and the brand-notification
email (`notifyBrandOfEscalation`) **already exist and already implement the clean handoff
the founder wants** — we are removing the *newer* auto-resume layer that was built on top.

### A.1 What "escalation" means after this phase

Every escalation trigger → `MANUAL_REVIEW` (terminal) → brand/operator emailed an FYI
("a human needs to take over") → surfaced in the Manual Queue dashboard. **No reply
parsing, no magic links, no auto-resume.** A human takes over out-of-band.

### A.2 Re-point the escalation call sites (KEEP the detection, change the destination)

The *decisions to escalate* are correct and stay. Only the destination changes.

| Call site | File:approx line | Today | After |
|---|---|---|---|
| Negotiation max-rounds (entry hard-stop) | `engine/executors/negotiation.ts:361` → `openMaxRoundsBrandDecision` | `AWAITING_BRAND_DECISION` | **See A.5 — this becomes auto-`REJECTED` (#15), not MANUAL_REVIEW.** |
| Negotiation max-rounds (counter-increment guard) | `negotiation.ts:649` → `openMaxRoundsBrandDecision` | `AWAITING_BRAND_DECISION` | **Auto-`REJECTED` (#15).** |
| Over-ceiling / agent ESCALATE | `negotiation.ts:621` `case "escalate"` → `openOverCeilingBrandDecision` | `AWAITING_BRAND_DECISION` | **`MANUAL_REVIEW`** (reason `over_ceiling`) — unless within new tolerance (Phase C). |
| Low-confidence creator reply (A1/A2) | `engine/executors/replyDetection.ts:187` → `deps.openBrandDecision` | `AWAITING_BRAND_DECISION` | **`MANUAL_REVIEW`** (reason `low_confidence_reply`). |
| Missing brand name (L4) | `engine/executors/brandDecision.ts:233` `openMissingBrandDecision` (called from rewardSetup / paymentInfo / contentBrief) | `AWAITING_BRAND_DECISION` config-fix | **`MANUAL_REVIEW`** via existing `blockedByMissingBrand(node)` in `guardEscalation.ts:35` (that helper already exists and was the pre-loop behavior). |
| Output-guard leak (B12) | `engine/executors/guardEscalation.ts:14` `blockedByGuard` | already `MANUAL_REVIEW` | **No change.** ✅ |

**Mechanics of the re-point:** replace each `openBrandDecision(...)` /
`openMaxRoundsBrandDecision(...)` / `openOverCeilingBrandDecision(...)` /
`openMissingBrandDecision(...)` call with a `NodeResult` returning
`nextState: "MANUAL_REVIEW"`, `completedAt: new Date()`, `eventType:
"MANUAL_REVIEW_FLAGGED"` (or `NEGOTIATION_TURN` with `outcome: "ESCALATE"` on the money
path, to match existing timeline reads), and the appropriate `reason`. Most of these can
reuse or mirror `blockedByMissingBrand` / `blockedByGuard` shapes.

> Preserve the audit reason codes the Manual Queue already renders
> (`REASON_LABELS` in `notifications/escalation.ts:39` + `routes/manualQueue.ts:43`):
> `low_confidence_reply`, `max_rounds_reached` (→ becomes reject, see A.5),
> `over_ceiling`/`escalated`, `output_guard_blocked`, `missing_brand_name`.

### A.3 Delete the brand-decision loop (dead after A.2)

Once no caller opens a brand decision, delete the machinery. **Order matters** — remove
callers/dispatch first, then leaf modules, to keep `tsc` green between steps.

**Delete these files entirely:**
- `server/src/engine/executors/brandDecision.ts` (open/execute loop + `sanitizeBrandName`)
- `server/src/engine/brandDecisionParse.ts` (token scanner + `isAuthorizedBrandSender`)
- `server/src/notifications/brandDecisionEmail.ts` (actionable + magic-link email)
- `server/src/routes/brandDecision.ts` (magic-link GET/POST endpoints)
- `server/src/routes/brandDecisionPage.ts` (magic-link confirmation pages)
- `server/src/db/brandDecision.ts` (DB helpers)
- `server/src/scheduler/brandDecisionSweep.ts` (72h auto-timeout sweep)
- **Tests:** `brandDecisionParse.test.ts`, `brandDecisionPage.test.ts`,
  `sanitizeBrandName.test.ts`, and the brand-decision cases inside
  `replyDetection.test.ts`, `rewardReply.test.ts`, `rewardSetup.test.ts`,
  `escalation.test.ts` (prune, don't delete whole file where mixed).

**Edit these files to remove references:**
- `server/src/engine/runtime.ts` — remove `executeBrandDecision` import (line ~34), the
  `AWAITING_BRAND_DECISION` dispatch branch (`~996`), and the methods
  `handleBrandDecisionReply` (`~569`), `resolveBrandDecisionLink` (`~644`),
  `expireBrandDecision` (`~720`). Keep `escalationReason` + `notifyBrandOfEscalation`
  call (`~298`) — those serve plain MANUAL_REVIEW.
- `server/src/workers/inboundEmailWorker.ts` — remove the `AWAITING_BRAND_DECISION`
  reply branch (`~185–233`) and its resume-enqueue block. **Caution:** a reply that now
  arrives for a `MANUAL_REVIEW` (terminal) instance should be persisted for audit but
  NOT drive state — confirm the terminal-state handling drops it cleanly (it should,
  since `MANUAL_REVIEW` has no inbound branch and no outgoing edges).
- `server/src/routes/webhooks.ts` — remove any brand-decision correlation branch.
- `server/src/scheduler/poller.ts` — remove the `sweepExpiredBrandDecisions()` call (`~29`).
- `server/src/app.ts` / router mount — unmount `/brand-decision` routes.
- `server/src/engine/executors/index.ts` — drop brand-decision exports.
- `server/src/engine/executors/replyDetection.ts` — remove the `openBrandDecision`
  dep/import + the A1/A2 branch (replaced by MANUAL_REVIEW return in A.2).
- `server/src/engine/executors/rewardSetup.ts`, `paymentInfo.ts`, `contentBrief.ts` —
  swap `openMissingBrandDecision` back to `blockedByMissingBrand`.
- `server/src/db/index.ts` — drop brand-decision re-exports.
- `server/src/observability/logger.ts` — drop the `brand-decision-link` TransitionSource
  if it errors; otherwise leave (harmless historical value).

### A.4 State machine + schema

- `server/src/engine/stateMachine.ts` — remove `AWAITING_BRAND_DECISION` from the
  `TRANSITIONS` record (line ~49) and every edge that targets it (lines
  ~23,25,34,67,78,93). Every state that had `→ AWAITING_BRAND_DECISION` keeps its
  `→ MANUAL_REVIEW` edge, so escalations still route validly.
- `server/prisma/schema.prisma` — **DECIDED (Q1): clean removal + migration.** Remove the
  `AWAITING_BRAND_DECISION` enum value, the `BrandDecision` model, the `BrandDecisionStatus`
  enum, and all relations; ship a Prisma migration. The migration must first move any
  existing `AWAITING_BRAND_DECISION` instance rows → `MANUAL_REVIEW` (should be none in a
  fresh dev DB), then drop the table + enum value. Apply to the Neon dev DB, not just
  generate.

### A.5 #15 — max-rounds → auto-reject (not human)

Founder #15: a negotiation that fails within configured limits should **auto-close**, not
burden a human (thousands of emails). So the two max-rounds sites in `negotiation.ts`
(`~361`, `~649`) return:

```
nextState: "REJECTED", completedAt: now,
eventType: "NEGOTIATION_TURN",
eventPayload: { outcome: "REJECT", reason: "max_rounds_no_agreement", round, maxRounds }
```

- **DECIDED (Q2): send a courteous close email before rejecting.** Draft a brief "we
  couldn't reach an agreement this time" message via the existing draft/email seam, send
  it, THEN transition to `REJECTED`. Keep the send best-effort (a send failure must not
  block the transition — the run still reaches `REJECTED`). Reuse `idempotentSend` /
  `sendOnce` so a BullMQ retry doesn't double-email.
- **Boundary with #5/#9 (judgment/legal/dispute):** those still go to `MANUAL_REVIEW`.
  Only "creator simply won't come to terms within budget/rounds" auto-rejects. This is
  the reconciliation of the apparent #14 vs #15 tension.

### A.6 Verification (Phase A)

1. `tsc --noEmit` clean (server + web).
2. `npm test` — prune/adjust brand-decision suites; all remaining green.
3. **Live Ollama e2e (deferred to when you start services):** drive an escalating
   negotiation to max-rounds and an over-ceiling ask; confirm landing states are
   `REJECTED` (max-rounds) and `MANUAL_REVIEW` (over-ceiling) respectively, that a brand
   FYI email is sent, and that **no** magic-link/actionable email goes out.
   - **Note:** landing-state routing is pure TS and provider-independent — Ollama only
     proves the *model triggers* the escalation. See "How to run tests" below.

---

## 2. Phase B — Negotiation opening position (#2) 🟠

**Founder #2:** open at the floor (preferred), concede up.

- `server/src/templates/index.ts` — change `recommendedOfferPosition: 0.5` → `0.0` in
  all three templates (lines ~82, 153, 223).
- **Guard the `$0` regression (HARD-N3 history):** opening at floor computes the opening
  offer as `floor`. The templates already enforce `minBudget > 0` (e.g. affiliate floor
  $50), so this is safe — but add/keep a test asserting a bare "I'm interested" opens at
  the floor, not `$0`. Verify `negotiate.py:1682` `recommendedOfferPosition` clamp still
  holds `0.0` → floor.
- No agent-side code change required (position is already read from config); this is a
  config + test change.

---

## 3. Phase C — Over-ceiling tolerance (#12) 🟠

**Founder #12:** merchant-configurable tolerance above max. Within tolerance → counter at
or below max. Above tolerance → escalate immediately.

- **Config:** add `overCeilingTolerance` (percent, default `0` = today's behavior) to the
  negotiation node config in `server/src/templates/index.ts` + the Workflow Builder node
  config panel (`web/src/components/builder/NodeConfigPanel.tsx`) + `schema` docs.
- **Thread it:** `server/src/engine/providers.ts` `buildNegotiationRequest` → add to
  `CampaignConstraints`; `agent/app/routes/negotiate.py` `CampaignConstraints`
  (`~156–189`) add `overCeilingTolerance: float | None`.
- **Logic (agent):** compute `tolerance_ceiling = ceiling * (1 + tolerance/100)`.
  - `creator_ask <= ceiling` → existing behavior.
  - `ceiling < creator_ask <= tolerance_ceiling` → **COUNTER at `ceiling`** (or below);
    do not escalate. On the final round, ACCEPT at ceiling if they meet it.
  - `creator_ask > tolerance_ceiling` → **ESCALATE** (→ MANUAL_REVIEW per Phase A).
  - Update the CRITICAL-4 final-round guard (`negotiate.py:1007`) to use
    `tolerance_ceiling` as the escalate boundary instead of raw `ceiling`.
- **Server side:** the `case "escalate"` handler already routes to MANUAL_REVIEW after
  Phase A — no change beyond passing the config through.
- Founder notes tolerance could later apply to commission/bonus/timeline too; V1 = fee only.

---

## 4. Phase D — Deferred-Decision intent + soft follow-up (#3) 🟠

**Founder #3:** a distinct **"Deferred Decision"** intent (reply received, no clear
commitment) separate from the pending-reply *state*; schedule a soft follow-up in 3–5
days; bonus: honor a creator-stated timeline. Confidence still gates auto-vs-escalate.

- **Intent:** add `DEFERRED` to `ReplyIntent` (Prisma enum `schema.prisma:107`, TS mirror
  `adapters/classification/types.ts`, Python `classify.py:44`). Migration for the enum.
- **Classifier prompt:** `agent/app/routes/classify.py` `_CLASSIFY_PROMPT` (~90) — add the
  DEFERRED definition + examples ("I'll let you know", "give me some time", "next week",
  "thinking about it"), distinct from QUESTION and NEGATIVE. Update `agent/CLASSIFICATION.md`.
- **Routing:** `engine/executors/replyDetection.ts` — new `case "DEFERRED"`: stay in the
  follow-up track (schedule a soft follow-up via the existing `followUp` executor seam /
  `dueAt`), NOT `NEGOTIATING`, NOT `MANUAL_REVIEW`. New event/state consideration:
  reuse `AWAITING_REPLY` + a `dueAt` so the existing 30s poller re-enqueues the follow-up
  (no new terminal state needed). Confirm state-machine edges allow REPLY_RECEIVED →
  AWAITING_REPLY (add if missing).
- **Follow-up delay:** the follow-up interval config already exists
  (`followUp.ts:31` `[3,5,7]` days). Use a configurable "deferred follow-up delay"
  (default 3–5d) for the soft nudge.
- **Bonus (timeline parse):** add a small deterministic/LLM extractor for "next week" /
  "tomorrow" / a date, and set `dueAt` around it instead of the fixed delay. Keep it
  behind the same confidence gate; low confidence → fixed default.
- **Confidence still applies** (#3, #10): a low-confidence DEFERRED classification still
  routes to `MANUAL_REVIEW` per the existing 0.50 gate.

> **Naming clarity (#3):** keep the *state* "pending reply" concept (AWAITING_REPLY /
> FOLLOWED_UP / NO_RESPONSE) strictly separate from the *intent* DEFERRED. The codebase
> already separates state from intent cleanly — we're only adding the missing intent.

---

## 5. Phase E — Always-escalate topic gate (#4, #5, #9, #11) 🟠

**Founder #5:** certain topics **always escalate regardless of confidence** — the agent
may acknowledge but must not decide/commit. Categories: pricing exceptions (custom fee
structures, bonuses, guarantees), contract/legal changes, disputes/hostile tone/payment
disputes/missed deliverables, and undefined/missing campaign terms.

- **New gate (agent side, deterministic-first):** in `classify.py` and/or `negotiate.py`,
  add a topic detector that, when a reply matches an always-escalate category, returns an
  **escalate signal independent of the intent-confidence path**. Prefer a
  deterministic keyword/heuristic pass (legal/dispute/hostile lexicon) + an LLM category
  classifier as the second pass, mirroring the existing opt-out/injection gate pattern
  (`classify.py:201–238`).
- **Routing:** these map to `MANUAL_REVIEW` (Phase A), with a specific reason
  (`legal_or_contract`, `dispute_or_hostile`, `pricing_exception`, `undefined_terms`).
  Add labels to `REASON_LABELS` in both `notifications/escalation.ts` + `routes/manualQueue.ts`.
- **Relationship to #4 (unknown structured data) — DECIDED (Q3): per-topic split.**
  Today the agent *defers honestly* on all unknown knowledge fields (`negotiate.py`
  deferral markers ~2817). New V1 policy = a per-topic table:
  - **Escalate → MANUAL_REVIEW** when the unknown topic is commitment-bearing legal/
    commercial: **usage rights, exclusivity, licensing** (and content-usage/whitelisting
    style asks). The agent may *acknowledge* the question but must not promise or defer a
    commitment on these — it hands to a human.
  - **Honest-defer (keep current)** for benign scheduling/logistics: **payment timing**
    ("we'll confirm the exact schedule together"), and similar non-committal timing asks.
  - Implement as an explicit `TOPIC_POLICY: {topic → "escalate" | "defer"}` map consulted
    after topic detection, so it's auditable and easy to extend. Attribution window:
    treat as **defer** if a value is configured, **escalate** if asked and unknown
    (it's commercial). Confirm exact rows during coding; the map is the single source.

---

## 6. Phase F — Utility-curve pricing + relabeling (#1) 🟢 (lower priority)

**Founder #1:** treat min/max as a utility curve (preferred = 1.0, max = 0.0); every $
over preferred costs more, so $260 in a $200–500 band is a much better outcome than $490.
Relabel to "Preferred Budget" / "Maximum Budget".

- **Behavior:** bias concessions to stay near the floor — the agent should make the
  *smallest* concessions necessary and resist drifting to the ceiling. Today's
  `_step_offer` midpoint convergence (`negotiate.py:602`) drifts toward the creator's ask
  symmetrically. Add a utility-weighted step (smaller upward steps; stronger hold near
  floor) + strengthen the prompt discipline already present ("close at the lowest rate").
- **Relabel (UI + docs only, no behavior):** `floor`/`ceiling` → surface as "Preferred
  Budget"/"Maximum Budget" in `web/` builder labels + `schema` comments + templates.
  Internally the field names can stay (`minBudget`/`maxBudget`/`floor`/`ceiling`) to
  avoid a churny rename; only the *human-facing labels* change. **Decision (Q4):** rename
  fields too, or labels only? Recommendation: **labels only** for V1 (less risk).
- This phase is behavior-shaping, not correctness-critical — safe to do last or defer.

---

## 7. No-change items (already aligned) ✅

- **#13 final-round accept within ceiling** — already implemented (CRITICAL-4,
  `negotiate.py:1007`). Only the *boundary* shifts to `tolerance_ceiling` under Phase C.
- **#6 fee-only negotiable / commission fixed** — already implemented (`negotiate.py:1417`).
- **#7 per-variable limits** — N/A (only fee moves; nothing to trade).
- **#8 no non-price sweeteners** — already the case; agent told not to invent perks.
- **#10 ambiguous → confidence gate** — the 0.50 gate already routes low-confidence to
  escalation; after Phase A that's plain MANUAL_REVIEW.

---

## 8. Suggested execution order & risk

| Order | Phase | Risk | Rationale |
|---|---|---|---|
| 1 | **A** (escalation → handoff, incl. #15 auto-reject) | Medium | Mostly deletion + re-point; unblocks the founder's core V1 model. Do first so everything downstream escalates to the right place. |
| 2 | **B** (open at floor) | Low | One-line config × 3 + a test. |
| 3 | **C** (over-ceiling tolerance) | Medium | New config threaded end-to-end + agent boundary logic. |
| 4 | **E** (always-escalate topics) | Medium | New gate; depends on A's MANUAL_REVIEW destination existing. |
| 5 | **D** (deferred intent + follow-up) | Medium | New intent + scheduling; enum migration. |
| 6 | **F** (utility curve + relabel) | Low–Med | Behavior-shaping; safe to do last / defer. |

Each phase is independently shippable and independently testable. Recommend one PR per
phase (or A split into "remove loop" + "auto-reject").

---

## 9. Testing strategy

### 9.1 What to run for each phase
- **Unit/typecheck (every phase):** `cd server && npm run typecheck && npm test`;
  `cd web && npx tsc --noEmit`.
- **Escalation-routing proof (Phase A) — no LLM needed:** the negotiation harness
  (`npm run harness:phase8`) drives escalation paths through the real state machine.
  Landing-state routing is pure TS, so this proves `MANUAL_REVIEW`/`REJECTED` routing
  *without* Ollama.

### 9.2 Live Ollama end-to-end (when services are up)
To watch a real model trigger an escalation and confirm it lands in the Manual Queue
(not brand-decision), **you start these; I'll drive the case and inspect:**

1. **Ollama** running + model pulled: `ollama serve` (or the desktop app) and
   `ollama run qwen3:8b` once to warm it. (Confirm `OLLAMA_VULKAN=false` per the known
   iGPU-misroute issue.)
2. **Redis** running on `localhost:6379`.
3. **Neon DB** reachable (the `DATABASE_URL` in `.env`).
4. **Agent service** on `:8001` started with **`LLM_PROVIDER=ollama`** (override the
   current `openrouter`) and `NEGOTIATION_STRATEGY=llm` (or `rules`).
5. **Server (API + worker + scheduler)** — `cd server && npm run dev` (or the split
   `start:*` roles), with `EMAIL_PROVIDER=mock` so no real email goes out during the test.

Tell me when those are up and I'll: seed/enroll an escalating creator, drive a reply that
forces max-rounds and one that's over-ceiling, then read the instance's final state +
event log (via the observability routes / DB) to confirm `REJECTED` / `MANUAL_REVIEW` and
**no** actionable/magic-link email was produced.

> **Reminder:** the LLM only decides *whether* to escalate; the destination state is
> hardcoded. So this live run validates end-to-end plumbing + that the model reaches an
> escalation, not the routing math (which the harness already proves).

---

## 10. Open questions — decisions

**Resolved (2026-07-13):**
1. **Q1 — Prisma cleanup → CLEAN REMOVAL + MIGRATION.** Drop the enum value +
   `BrandDecision` model + `BrandDecisionStatus`; move any existing rows to
   `MANUAL_REVIEW` first; apply to Neon. (See §1.A.4.)
2. **Q2 — Max-rounds close email → SEND CLOSE EMAIL.** Brief "no agreement this time"
   email (best-effort, idempotent) before `REJECTED`. (See §1.A.5.)
3. **Q3 — Unknown-topic policy → PER-TOPIC SPLIT.** Escalate usage rights / exclusivity /
   licensing; honest-defer payment timing / benign scheduling. `TOPIC_POLICY` map. (See §5.)

**Still open (decide before their phase):**
4. **Q4 — Relabel scope (#1):** rename the config *fields* (`minBudget`→`preferredBudget`
   etc.) or only the human-facing *labels*? *(Rec: labels only for V1.)* — Phase F.
5. **Q5 — Deferred follow-up default (#3):** exact default soft-follow-up delay (3, 4, or
   5 days) and whether the timeline-parse bonus is in-scope for this pass or a fast-follow.
   — Phase D.

---

## 11. Model recommendation for implementation

- **Phase A (escalation removal + #15), Phase C (over-ceiling boundary), Phase E
  (always-escalate gate):** use **Opus 4.8**. These touch the state machine, the money-path
  guards (CRITICAL-1/3/4/6), and require removing an interwoven feature without breaking
  the escalation *detection* that shares its call sites. Correctness-critical, cross-file,
  landmine-heavy reasoning — exactly where Opus pays off.
- **Phase B (config flip), Phase F relabeling, config plumbing:** **Fable** is fine once
  the plan is locked — mechanical, well-scoped edits.
- **Net:** Opus for the risky core; Fable for the mechanical follow-ons.

---

## Appendix — brand-decision loop file inventory (Phase A deletion checklist)

**Delete:** `engine/executors/brandDecision.ts`, `engine/brandDecisionParse.ts`,
`notifications/brandDecisionEmail.ts`, `routes/brandDecision.ts`,
`routes/brandDecisionPage.ts`, `db/brandDecision.ts`, `scheduler/brandDecisionSweep.ts`,
+ associated `*.test.ts`.

**Edit (remove refs):** `engine/runtime.ts`, `workers/inboundEmailWorker.ts`,
`routes/webhooks.ts`, `scheduler/poller.ts`, `app.ts`, `engine/executors/index.ts`,
`engine/executors/replyDetection.ts`, `engine/executors/rewardSetup.ts`,
`engine/executors/paymentInfo.ts`, `engine/executors/contentBrief.ts`,
`engine/executors/negotiation.ts`, `engine/stateMachine.ts`, `db/index.ts`,
`observability/logger.ts`, `prisma/schema.prisma`.

**Web:** `web/src/components/builder/ManualQueueTab.tsx` (remove the "Awaiting Brand
Decision" section + "Awaiting Brand" stat), `web/src/api/builderTypes.ts` (drop
`PendingBrandDecision` type). `routes/manualQueue.ts` — drop `pendingDecisions[]` /
`pendingTotal` from the GET response.

**Docs (update, don't delete history):** `README.md`, `readme_docs/*` referencing the
brand-decision loop — mark superseded by this plan.
