# UX Improvements — Prioritized

_Last updated: 2026-07-20. Grounded in a 3-surface audit of the actual codebase
(operator dashboard `web/src`, creator-facing emails/forms `server/src` +
`agent/app`, and the transparency/observability seams). Every item cites the real
file(s). Companion to `improvements_LLM.md` (which covers the negotiation model
itself)._

The system is **correct and safe** — money path, escalation, security are hardened.
This doc is about **experience**: making the automation trustworthy to *run*
(operator) and pleasant to *receive* (creator). There are two users:

- **Operator** = the Pluvus staffer running campaigns in the web dashboard.
- **Creator** = the influencer receiving the AI's emails and using the hosted forms.

Priority = impact ÷ effort. **P0** = high impact, low/medium effort (do first).
**P1** = high impact, higher effort. **P2** = polish / nice-to-have.

---

## The single highest-leverage theme: _captured-but-not-surfaced_

The most valuable finding across all three audits: the system already **captures**
rich data (every negotiation turn + reasoning, per-call LLM cost/latency/model,
escalation reason codes, prompt versions, a full append-only Event audit trail) —
but a lot of it is **not surfaced** to the operator in a usable form, and none of
the outbound copy is **previewable before it sends**. Closing that gap is mostly
front-end + read-model work on data that already exists — high impact, low risk.

---

## P0 — do first (high impact, low/medium effort)

### O1. Negotiation "story" replay in the inspector
**Who:** Operator · **Effort:** M · **Impact:** High
Today the inspector (`web/src/components/InstanceInspector.tsx`) has 5 read-only
tabs; to understand a negotiation the operator must mentally splice the **Messages**
tab against the **Timeline** tab. But every `NEGOTIATION_TURN` event already stores
`{round, action, rate, reason, message}` (`server/prisma/schema.prisma` Event table;
extracted in `server/src/observability/repository.ts` as `AgentDecisionDTO`).
**Do:** add a single "Negotiation" view that renders the turn-by-turn arc:
`R1 · creator asked $400 → we PRESENT_OFFER $250 ("<reasoning>") · R2 …`. Pure
read-model composition of data that already exists. This is the #1 trust lever —
the operator finally *sees* why the AI did what it did, as a narrative.

### O2. Manual Queue: badge count + sort-failures-to-top + full-error expand
**Who:** Operator · **Effort:** S · **Impact:** High
`web/src/components/builder/ManualQueueTab.tsx` already fetches escalations with
`reasonLabel`, but: (a) there's **no notification** anywhere else that the queue is
non-empty — it's only discoverable by visiting the tab; (b) failed brand
notifications ("Needs Attention") are **not sorted to top**; (c) notification error
text is **truncated to ~40 chars** with no expand.
**Do:** show a count badge on the top-level nav when the queue is non-empty; sort
failed/needs-attention rows first; make the truncated error expandable (tooltip or
row-expand). Small front-end change, directly reduces "escalated creator sits
unnoticed."

### O3. Surface both the model's reasoning AND the guard correction
**Who:** Operator · **Effort:** S · **Impact:** Medium-High
When a guard alters a decision, the model's pre-guard reasoning is discarded
(`agent/app/routes/negotiate.py` — `resp.reasoning = None if guards_altered`). The
operator only sees the guard's canonical line, never "the model wanted to counter at
$600 but the ceiling guard escalated." **Do:** persist the model's original
reasoning alongside the guard reason (don't overwrite — store both) and show both in
O1's replay. This makes the safety layer legible and builds trust that guards are
doing real work. _(Agent-side change: keep both fields; low risk, no money-path
impact.)_

### C1. Payout form + links: add context and a "why / how long"
**Who:** Creator · **Effort:** S · **Impact:** High
The hosted payout form (`server/src/routes/paymentPage.ts renderPaymentFormPage`) is
a **bare form with zero explanatory text** — no "why you're here," no "this takes 2
minutes," no "payment can't be sent until this is done." The payout-sent email's
confirm/dispute links (`server/src/engine/executors/payoutSentEmail.ts`) render as
ambiguous URLs, and the "no action needed" line contradicts the "confirm/dispute"
CTA. **Do:** add 1–2 sentences of context to the form header; label the payout link
in emails ("Complete your payout info — required before we can pay you, ~2 min");
make confirm/dispute obvious buttons; reconcile the "no action needed" copy. Pure
template/HTML edits, high trust payoff on the money-receiving step.

### C2. Confirmation email after payout-form submit
**Who:** Creator · **Effort:** S · **Impact:** Medium-High
After submitting the payout form the creator sees a thank-you page
(`renderPaymentThankYouPage`) but gets **no email receipt**. If the brief never
arrives they have nothing to reference and no proof they submitted. **Do:** send a
short "we received your payout info — brief coming next" confirmation email on submit.
One new templated email, removes a real trust gap in the payment funnel.

### C3. Close/rejection email: warmer + a clear door
**Who:** Creator · **Effort:** S · **Impact:** Medium
The close email (`server/src/engine/executors/negotiation.ts sendCloseEmail`) is a
curt fixed template with no reason and passive "future opportunities" language — a
dead-end that neither closes warmly nor keeps the door genuinely open. **Do:** warm
the copy, acknowledge their time, and state one honest clear next-step (or an
explicit "we'll reach out for future campaigns"). Template-only.

---

## P1 — high impact, higher effort

### O4. Human-in-the-loop: preview / approve / edit an email before it sends
**Who:** Operator · **Effort:** L · **Impact:** High
Everything auto-sends. The inspector is **read-only** (verified: no action buttons in
`InstanceInspector.tsx`) and the only pause point is a terminal MANUAL_REVIEW
escalation. There is **no "hold for review" mode** — the operator cannot see, edit,
or approve a draft before it goes out, even on high-stakes turns (final offer,
acceptance). The output guard *blocks* leaky drafts but rejects them outright rather
than surfacing them for a human fix. **Do:** add an optional per-campaign
"review-before-send" mode with an `AWAITING_OPERATOR_APPROVAL` hold state and an
approve/edit/send action in the inspector. Biggest control lever for operators
nervous about autonomy; larger because it touches the state machine + executor +
front-end. _Consider gating to specific turn types first (final offer, acceptance)
to limit scope._

### O5. Take action from the inspector (no dead-end reviewing)
**Who:** Operator · **Effort:** M · **Impact:** Medium-High
The inspector shows everything but does nothing — to act on an escalation the
operator leaves it and uses the Manual Queue. **Do:** add contextual actions
(resend brand notification, mark escalation resolved, force-advance a stuck
instance) directly in the inspector. Note the audit found **no "mark resolved"
action exists at all** — escalated creators sit in the queue indefinitely.

### C4. Personalize outreach with the creator's actual context
**Who:** Creator · **Effort:** M · **Impact:** High
Initial outreach (`_DRAFT_PROMPT` in `agent/app/routes/negotiate.py`) can't reference
the creator's niche/platform/audience because those aren't threaded into the prompt —
so first contact reads cold ("we are interested in partnering with you"). We just
proved the tone lever works with offer-v1.5; the same move applies here. **Do:**
thread creator niche/platform (already on the Creator record) into `_DRAFT_PROMPT`
and instruct one specific, genuine personalization line. Prompt + a bit of executor
plumbing.

### C5. Unify the post-acceptance funnel + set payment expectations
**Who:** Creator · **Effort:** M · **Impact:** Medium-High
The post-deal flow is disjointed: onboarding email (`_ONBOARDING_PROMPT`) never
mentions the payout form is coming; the content-brief email
(`contentBriefEmail.ts`) drops a cryptic payout link; nobody ever states **when/how**
payment happens. **Do:** make each step name the next one ("next you'll get a 2-min
payout form, then your brief"), and state the payment schedule once, honestly.
Cross-template consistency pass.

### O6. Cost/budget visibility with thresholds
**Who:** Operator · **Effort:** M · **Impact:** Medium
`/observability/llm` + the LLM strip already show spend, and `/observability/alerts`
fires an `llm_spend_exceeded` daily alert — but there's **no per-campaign budget, no
"$X of $Y" progress, no cost warning in the inspector's AI Usage tab.** `"—"` tokens
for local Ollama are ambiguous (no-usage vs unavailable). **Do:** add a per-campaign
budget field + progress indicator, a cost badge in the inspector, and disambiguate
the `"—"` state. Read-model + small UI.

---

## P2 — polish / nice-to-have

- **O7. Campaign builder guards** (`CampaignWizard.tsx`): confirm-on-close to prevent
  mid-form data loss; auto-focus first invalid field; group the 11 Step-1 fields
  under section headers. _(Who: Operator · Effort: S)_
- **O8. Enroll tab** (`EnrollTab.tsx`): "already enrolled" warning *before* enroll;
  auto-refresh stat tiles after enroll; CSV errors with line numbers.
  _(Operator · S)_
- **O9. Partners dashboard** (`partners/*.tsx`): column totals on
  obligations/payouts tables; search/filter; a "resend payout form" CTA when payout
  info is missing; explain "in-flight". _(Operator · S–M)_
- **O10. Navigation** (`App.tsx`): fix ambiguous tab active-states; unsaved-changes
  warning on tab switch; preserve drilldown/filter state across navigation.
  _(Operator · M)_
- **O11. Prompt-version → outcome analytics**: versions are stamped on every
  `LlmCall` but not filterable/comparable. A "v1.4 vs v1.3 escalation rate" view
  would make prompt changes (like offer-v1.5) measurable. _(Operator · M)_
- **C6. Interactive accept** instead of "reply 'I Agree'" plain-text parsing (legacy
  `rewardEmail.ts` path); one-click confirm. _(Creator · M)_
- **C7. Tracking-link education**: the welcome/tracking emails
  (`partnershipWelcomeEmail.ts`) drop a bare URL with no "how to share / how
  commission works / how to check balance." _(Creator · S)_
- **C8. Dispute flow recourse**: dispute page gives no case ID, no SLA, no way to
  attach evidence (`payoutConfirmPage.ts`). _(Creator · S–M)_

---

## Suggested sequencing

1. **Week 1 (P0 quick wins, mostly templates + read-models):** C1, C2, C3, O2, O3.
   Low risk, immediate trust gains on both sides.
2. **Week 2 (the trust centerpiece):** O1 negotiation replay + wire O3's dual
   reasoning into it. This is the flagship operator feature.
3. **Then pick one P1 track** based on what's blocking pilot confidence: **O4**
   (approve-before-send) if operators want more control, or **C4/C5** (personalized,
   coherent creator journey) if close-rate/creator trust is the priority.

## Explicitly out of scope here
- Negotiation *model* quality (tone, concession math, escalation policy) — that's
  `improvements_LLM.md` and the offer-v1.5 work.
- The known small-model rendering artifacts (truncated deal label, markdown leak) —
  those resolve on the production Opus model.
