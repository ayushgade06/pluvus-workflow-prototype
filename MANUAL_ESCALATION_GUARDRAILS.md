# Manual Escalation Guardrails

_Last reviewed: 2026-07-20_

This document catalogs every guardrail that governs escalation to **`MANUAL_REVIEW`** — the
human-handoff queue — in the Pluvus workflow prototype. Escalation happens whenever the system
is not confident it should keep auto-negotiating, auto-accepting, or auto-rejecting a creator's
reply, or whenever an outbound email fails a safety check.

The design intent is: **fail toward a human, never toward a wrong commitment.** When in doubt,
the conversation is parked for a person rather than guessed at by the model.

---

## How `MANUAL_REVIEW` behaves

- **Terminal by design.** `TRANSITIONS["MANUAL_REVIEW"] = []`
  (`server/src/engine/stateMachine.ts:69`). Once escalated, there is no auto-resume and no
  brand-decision loop — it is a clean one-way handoff. A human re-routes out of band.
- **Reachable from nearly every non-terminal state** — `ENROLLED`, `AWAITING_REPLY`,
  `REPLY_RECEIVED`, `NEGOTIATING`, `ACCEPTED`, `REWARD_PENDING`, `REWARD_CONFIRMED`,
  `PAYMENT_PENDING`, `PAYMENT_RECEIVED` (`stateMachine.ts:11–62`). Nothing gets stuck with no
  safety exit.
- **The brand is notified exactly once** per `(instanceId, reason)`, idempotent on a unique
  constraint (`server/src/notifications/escalation.ts`). A retry never double-emails.
- **Every escalation carries a machine reason code** that maps to a human-readable label for the
  Manual Queue UI (`escalation.ts:60–84`).

---

## Guardrail categories

### 1. Topic gates — always-escalate sensitive subjects
**File: `agent/app/topic_gate.py`**

Certain topics require a human regardless of how confident the model is; the agent may acknowledge
them but must never commit. This gate is **deterministic code that runs before the rate logic**, so
no prompt injection or model confidence can suppress it.

| Trigger topic | Examples | Outcome |
| --- | --- | --- |
| Legal / contract | "contract", "agreement", "NDA", "indemnification", clause changes | `legal_or_contract` → MANUAL_REVIEW |
| Dispute / hostile | "never got paid", "breach", "lawsuit", "you owe me" | `dispute_or_hostile` → MANUAL_REVIEW |
| Pricing exception | performance bonus, tiered/CPA/rev-share, equity, custom fee structure, "change the commission %" | `pricing_exception` → MANUAL_REVIEW |
| Usage rights / licensing | usage rights, exclusivity, licensing, whitelisting, paid media, content ownership | `usage_rights_or_licensing` → MANUAL_REVIEW |
| Undefined terms | "what are the exact contract terms", "nothing specified about rights" | `undefined_terms` → MANUAL_REVIEW |
| Payment timing | "when do I get paid", net-30/45/60 | **DEFER** (answered honestly, _not_ escalated) |

**Refinements that prevent over-escalation:**
- **Intent-aware gating** (`detect_escalation_topic_ex`, `topic_gate.py:333`): a plain *question*
  about usage rights or commission that the knowledge base can answer is handled, not escalated;
  only a *demand* to change terms escalates. `_DEMAND_SIGNAL` distinguishes "can you tell me the
  usage window?" from "I require perpetual exclusivity."
- **Per-clause gating** (`detect_escalation_per_clause`, `topic_gate.py:473`): a multi-question
  reply is split into clauses so one sensitive clause doesn't drag the whole (otherwise answerable)
  turn into escalation.

The always-escalate result is consumed server-side at
`server/src/engine/executors/replyDetection.ts:162–177`, which routes to `MANUAL_REVIEW` **before**
the "engaged" POSITIVE/QUESTION routing — the topic gate wins.

---

### 2. Classification confidence & degrade paths
**Files: `agent/app/routes/classify.py`, `server/src/engine/executors/replyDetection.ts`**

- **Low-confidence threshold `0.50`** — defined in both the agent (`classify.py:52`) and the
  server (`replyDetection.ts:12`). Any classification below `0.50` is forced to `UNKNOWN`
  (`replyDetection.ts:181`) and routed to `MANUAL_REVIEW` with reason `low_confidence_reply`
  (`replyDetection.ts:255–274`).
- **Fail-safe on malformed model output** — if the LLM output fails Pydantic validation after
  retries, the classifier returns `UNKNOWN` / confidence `0.0` (`classify.py:154–180`) rather than
  guessing. → MANUAL_REVIEW.
- **Agent-unavailable degrade** — if the classify service is down / times out / the circuit is open,
  the server treats it as `UNKNOWN`/0 and escalates (reason `agent_unavailable`). The negotiate
  path degrades to `{ outcome: "escalate" }`. Covered by `agentDegradation.test.ts`.

---

### 3. Money / rate guards
**Files: `agent/app/routes/negotiate.py`, `server/src/engine/executors/negotiation.ts`**

These stop the system from committing to a rate it shouldn't, or fabricating one.

| Guard | Trigger | Outcome |
| --- | --- | --- |
| Over-ceiling ask | creator ask > `tolerance_ceiling` (default = ceiling, zero tolerance) | ESCALATE → MANUAL_REVIEW (`negotiate.py` `_decide_action`) |
| Unreadable / hallucinated rate | model rate can't be coerced or its digits don't appear in the creator's reply (`_coerce_rate` :471, `_validate_extracted_rate` :540) | rate → `None`; on a RATE_PROPOSAL this ESCALATEs rather than guessing |
| No ceiling configured | campaign has a floor but no max budget | `escalateNoCeiling()` → MANUAL_REVIEW, reason `no_ceiling_configured` (`negotiation.ts:318`) |
| In-band ACCEPT snapping | creator's ask is within band | accept the **creator's actual on-the-table ask**, not a fabricated midpoint (money-integrity fix) |
| Stuck / no number | 2+ consecutive PRESENT_OFFER turns with no figure | ESCALATE to a human |
| No agreed fee at Content Brief | `resolveAgreedFee` returns undefined (no genuine agreed rate recorded) | MANUAL_REVIEW, reason `no_agreed_fee` (`contentBrief.ts:123`) |

**LLM strategy is guarded too:** under `NEGOTIATION_STRATEGY=llm`, if the model throws or its output
fails validation, control falls back to the deterministic `_decide_action` ladder
(`negotiate.py:2201`) — it never guesses a decision.

---

### 4. Output guard — outbound content safety
**Files: `server/src/engine/guards/outputGuard.ts`, `.../executors/guardEscalation.ts`**

Every AI-generated outbound email is scanned before it is sent. If it leaks internal terms, the
send is blocked and the funnel halts for review instead.

`scanOutboundDraft()` blocks a draft that contains:
- the floor or ceiling as a number (`$500`, `500`, or separated forms), including
  **English-word forms** ("five hundred dollars", "four hundred and seventy five");
- **any `$` amount that isn't on the allowlist** (blocks fabricated figures);
- a commission percentage that doesn't match the brand-configured commission;
- any brand-configured internal term.

A hit → `blockedByGuard()` → MANUAL_REVIEW, reason `output_guard_blocked`. This scan is wired into
initial outreach (`initialOutreach.ts:64`), follow-ups (`followUp.ts:106`), and the merged
Content-Brief email (`negotiation.ts:161`).

---

### 5. Opt-out & prompt-injection gates
**Files: `agent/app/injection.py`, `agent/app/routes/classify.py`, `replyDetection.ts`**

- **Universal opt-out gate** — runs on **every inbound reply, every round**, as pure code
  (`replyDetection.ts:96`). "unsubscribe" / "remove me" / "stop emailing" → hard route to
  `OPTED_OUT` at confidence 1.0, bypassing the model. This closes a CAN-SPAM exposure where a
  mid-negotiation opt-out could otherwise get a counter-offer.
  - Conditional / rhetorical opt-outs ("if you can't beat $400…", "no way") are **not** treated as
    opt-outs (`injection.py:206`), so hot leads aren't falsely terminated.
- **Injection gate** — `looks_like_injection()` (`injection.py:303`, ~30 patterns: instruction
  override, jailbreak names, role-play, "respond with intent X", system-prompt reveal) forces
  `UNKNOWN` / confidence 0 → MANUAL_REVIEW. Untrusted text is also NFKC-normalized, control-char
  stripped, homoglyph-stripped and length-capped before any gate sees it (`normalize_untrusted_text`).

---

### 6. State-machine / routing guards
**File: `server/src/engine/stateMachine.ts` + executors**

- **Terminal-hop protection** — `MANUAL_REVIEW` and the other terminals have no outgoing edges, so
  a bad transition can't silently resurrect a closed conversation.
- **Lost-reply protection (CRITICAL-6)** — `OUTREACH_SENT` and `NEGOTIATING` accept a
  `REPLY_RECEIVED` edge so a reply that arrives before/mid our turn is buffered and processed, not
  persisted-then-dropped.
- **Max-rounds** — at/after `maxRounds` with no agreement, the instance goes to **`REJECTED`** with
  a courteous close email (`maxRoundsReject`, `negotiation.ts:183`). This is a terminal close, not
  an escalation — deliberately distinct from MANUAL_REVIEW.
- **Missing brand name (L4)** — any creator-facing email with no resolvable brand name to sign →
  MANUAL_REVIEW, reason `missing_brand_name`.
- **Attribution mint failure (BUG-E2)** — if minting the Partnership/Obligation fails at
  Content-Brief submission → MANUAL_REVIEW, reason `attribution_mint_failed`.

---

### 7. Manual queue surfacing & brand notification
**Files: `server/src/notifications/escalation.ts`, `server/src/routes/manualQueue.ts`**

- **Recipient precedence** (`resolveBrandRecipient`, `escalation.ts:97`): campaign `notifyEmail`
  → `BRAND_NOTIFY_EMAIL` env → operator fallback (`affiliatepartner@pluvus.com`). Escalations
  always route somewhere reachable.
- **Idempotent, best-effort notify** (`notifyBrandOfEscalation`): reserve → send → audit; a send
  failure never fails the state transition, and a `FAILED` row is still written so the UI can show
  the brand wasn't reached.
- **The email includes the both-sides transcript** (`loadEscalationContext`) plus the reason and a
  Manual Queue link, so the human has full context.
- **Manual Queue tab** lists every instance in `MANUAL_REVIEW`, reconstructing the reason code and
  timestamp from the event log (`MANUAL_REVIEW_FLAGGED` → `NEGOTIATION_TURN` → `STATE_TRANSITION`).

---

## Escalation reason codes (quick reference)

| Reason code | Cause |
| --- | --- |
| `low_confidence_reply` | classifier confidence < 0.50 / UNKNOWN intent |
| `escalated` | negotiation agent escalated (over-ceiling, unreadable rate, stuck) |
| `no_ceiling_configured` | campaign has a floor but no max budget |
| `output_guard_blocked` | outbound draft leaked floor/ceiling/commission/internal terms |
| `missing_brand_name` | creator-facing email had no brand name to sign |
| `no_agreed_fee` | Content Brief reached with no genuine agreed rate |
| `attribution_mint_failed` | Partnership/Obligation mint failed at submission |
| `agent_unavailable` | AI agent degraded/unreachable |
| `legal_or_contract` | topic gate: legal/contract change |
| `dispute_or_hostile` | topic gate: dispute / payment complaint / hostile |
| `pricing_exception` | topic gate: custom fee structure / bonus / guarantee |
| `undefined_terms` | topic gate: undefined campaign term |
| `usage_rights_or_licensing` | topic gate: usage rights / exclusivity / licensing |

---

## Assessment — are these guardrails good?

**Overall: yes — this is a well-layered, defense-in-depth setup that is strong on the dimensions
that matter most for an autonomous system spending money on a brand's behalf.**

**Strengths**
- **Deterministic guards sit in front of the model.** Topic gate, opt-out, injection, rate
  validation, and the output guard are all plain code. A model that is fooled, jailbroken, or simply
  wrong cannot suppress them — the single most important property for an AI that can commit to money.
- **Fail-safe defaults everywhere.** Malformed output, agent-down, unreadable rate, and low
  confidence all degrade *toward a human*, not toward a guess.
- **Money commitments are gated three ways** — over-ceiling escalation, hallucinated-rate rejection
  (digits must appear in the creator's own text), and the output guard that blocks a leaked number
  from ever going out. The in-band ACCEPT snapping to the creator's real ask closes the fabricated-
  midpoint class of bug.
- **Clean, auditable handoff.** MANUAL_REVIEW is terminal, notification is idempotent with a full
  transcript, and every escalation carries a reason code surfaced in the queue.
- **Thoughtful de-escalation.** Intent-aware and per-clause topic gating, plus conditional/rhetorical
  opt-out detection, prevent the guards from being so trigger-happy that everything ends up in the
  queue.

**Gaps / things to watch**
- **The `0.50` threshold is duplicated** in the agent and the server. It's currently kept in sync by
  hand — worth a shared config or a comment cross-link so they can't drift.
- **No feedback loop on escalation volume.** There's no alerting/metric on escalation rate by reason.
  If, say, `low_confidence_reply` spikes, nothing surfaces it proactively — you'd only see it by
  eyeballing the Manual Queue. A per-reason counter + threshold alert would be a cheap, high-value add.
- **Operator fallback email is hard-coded.** `affiliatepartner@pluvus.com` in `escalation.ts:56` is
  fine for single-operator dev, but should be env-driven before any multi-tenant use.
- **Max-rounds → REJECTED under the LLM strategy is effectively unreachable** (documented separately):
  the LLM final round always ACCEPTs/ESCALATEs and never COUNTERs, so the auto-reject path doesn't
  fire. Not a safety hole (routing is still covered), but a known behavioral gap.
- **Topic-gate keyword lists are static.** They're conservative and well-chosen, but novel phrasings
  of a sensitive demand could slip past the regex to the model. The intent-aware layer mitigates this,
  but it's the one place a determined edge case could get an auto-response it shouldn't.

**Bottom line:** the guardrails are good and appropriately paranoid for a money-moving agent — the
architecture (deterministic-code-in-front-of-model, fail-toward-human) is exactly right. The
remaining items are observability and configuration polish, not correctness holes.
