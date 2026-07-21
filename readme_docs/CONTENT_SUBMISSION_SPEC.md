# Content Submission & Manual Review Specification

> Status: Draft for review — pre-implementation
> Scope: Post-payout content-link collection and operator handoff
> Author: Workflow team

## Background

The outreach workflow drives a creator through a linear funnel: outreach → reply → negotiation → acceptance → payout collection → content brief. Today, once a creator submits their payout details on the hosted form, the workflow sends the merged content-brief email (agreed terms, payout link, and campaign brief PDF) and immediately parks the conversation on the terminal `CONTENT_BRIEF_SENT` state.

That is where the automated relationship ends. The system has no notion of whether the creator ever produced or published the agreed content. Capturing the content URLs the creator has posted is currently a manual, out-of-band task with no place in the workflow and no structured record.

Three properties of the current engine shape this feature:

- **Terminal states swallow replies.** The inbound email worker drops any reply that arrives while an instance is in a terminal state. A creator who replies "here are my links" to the brief email today is silently ignored — the message is never persisted or acted upon.
- **The manual review queue is a notify-only handoff.** Escalation to `MANUAL_REVIEW` sends the operator a contextual notification and surfaces the conversation in a review tab. It is intentionally a human handoff, not an in-app decision surface.
- **Workflow state is event-sourced.** Everything that happens to an instance is recorded as an append-only sequence of events; downstream read paths, including the manual queue, derive their context from that history rather than from mutable per-instance fields.

This feature closes the loop after payout: it asks the creator to share their content links in the same email thread, appends those links to the instance's event history, and hands the conversation to a human operator for manual review — reusing the existing notify-only escalation surface rather than inventing a new one.

## Goals

- Prompt the creator, at the natural end of the funnel, to share the content URLs they posted for the campaign.
- Let the creator respond in the most natural way possible — a plain reply in the existing email thread — with no new form, link, or login.
- Capture the submitted URLs as a durable `CONTENT_LINKS_SUBMITTED` event on the instance's append-only history.
- Route the conversation to a human operator with enough context to begin manual review quickly.
- Reuse the existing escalation and manual-queue machinery instead of building a parallel review system.

## Non-goals

This feature deliberately does **not** do the following:

- **It does not automatically verify content.** The system extracts URLs and appends them to the event history; it makes no judgment about whether the content is correct, complete, on-brand, or even reachable.
- **It does not provide approve/reject functionality.** There is no in-app decision, no approval button, and no rejection flow. The manual queue remains a read-and-act surface, not a workflow controller.
- **It does not release payouts automatically.** No payout, obligation, or ledger action is triggered by content submission. Any payout decision remains a separate, human-driven step.
- **Human operators remain responsible for verification.** The system's job ends at "here is a creator, a campaign, and the content links they submitted." A person opens the links and decides what happens next.

## User Flow

The creator journey from payout submission to manual review:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 1. Creator submits payout details on the hosted form                  │
│    (instance was PAYMENT_PENDING)                                     │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 2. System sends the merged content-brief email                        │
│    (terms + payout link + brief PDF), now closing with a request:     │
│    "Once your content is live, reply to this email with the link(s)." │
│    Instance parks on CONTENT_LINKS_PENDING (non-terminal).            │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │
                     ┌───────────┴────────────┐
                     │                         │
       reply has no URLs            reply contains one or more URLs
                     │                         │
                     ▼                         ▼
┌────────────────────────────┐   ┌────────────────────────────────────┐
│ 3a. System sends a gentle  │   │ 3b. System extracts the URLs,       │
│     nudge asking for the   │   │     appends a CONTENT_LINKS_        │
│     content link(s).       │   │     SUBMITTED event, and escalates. │
│     Stays CONTENT_LINKS_   │   │     Instance moves to MANUAL_REVIEW.│
│     PENDING.               │   └───────────────────┬─────────────────┘
└────────────┬───────────────┘                       │
             │ (loops until links arrive             │
             │  or creator opts out)                 │
             └───────────────────────────────────────┤
                                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 4. Operator sees the conversation in the manual queue and receives    │
│    an escalation notification containing the creator, campaign,        │
│    submitted URLs, and an email conversation link.                     │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 5. Operator opens the conversation link, reviews the email history,   │
│    opens the submitted URLs, and performs manual review outside        │
│    the system.                                                         │
└──────────────────────────────────────────────────────────────────────┘
```

Two conditions qualify this flow. First, at any waiting point the creator may opt out; an unsubscribe-style reply routes the conversation to `OPTED_OUT` rather than a nudge, preserving CAN-SPAM parity with the other waiting states. Second, escalation happens only once: once the instance reaches `MANUAL_REVIEW`, later replies stay in the email thread for the operator to see but do not re-enter the workflow (see *System Behavior, Stage 5*).

## System Behavior

### Stage 1 — Content brief now asks for content links

When payout collection completes, the merged content-brief email is sent as it is today, with one addition: a short closing request telling the creator to **reply in the same email thread with the link(s) to their content once it is live**. Nothing else about the brief email changes — the same terms, payout link, brief PDF, idempotent send, and output-guard checks apply. The ask lives in the thread the creator is already reading, so no new surface is introduced.

Rather than terminating on `CONTENT_BRIEF_SENT`, the instance now parks on the new non-terminal `CONTENT_LINKS_PENDING` state, which keeps the conversation live and able to receive the creator's reply.

### Stage 2 — Creator replies in the thread

The creator replies in the same thread. Because the instance is in a non-terminal state, the inbound worker accepts and routes the reply instead of dropping it. The reply is handled by a dedicated content-links handler analogous to the existing payment-reply handler.

The handler applies a deterministic opt-out check first (a code-level gate, not a model call): an unsubscribe-style reply routes to `OPTED_OUT` and never receives an auto-reply.

### Stage 3 — System extracts content URLs

The handler applies deterministic URL extraction to the reply text (no model inference required). Quoted thread history is stripped before extraction so previously sent links are not re-captured. Two outcomes follow:

- **One or more URLs found.** The system appends a `CONTENT_LINKS_SUBMITTED` event whose payload contains the extracted URLs (see Persistence), then escalates the conversation to manual review.
- **No URLs found.** The system replies with a gentle nudge asking the creator to paste the link(s) to their posted content, and leaves the instance on `CONTENT_LINKS_PENDING`. The nudge is idempotent per inbound message so a retried delivery does not double-send. A future refinement may cap the number of nudges before escalating anyway; the initial behavior is to keep waiting.

### Stage 4 — System escalates the conversation

Once a `CONTENT_LINKS_SUBMITTED` event has been appended, the conversation is escalated through the existing escalation path, which both moves the instance to `MANUAL_REVIEW` and produces an operator notification. The escalation carries a distinct reason, *"Creator submitted content links,"* so it reads differently from a negotiation or guard escalation.

The escalation surfaces:

- the **creator** (name, email, and handle/platform as available),
- the **campaign**,
- the **submitted URLs**, and
- an **email conversation link** that opens the underlying email thread.

### Stage 5 — Additional replies after submission

Escalation happens exactly once, on the first qualifying reply. Because `MANUAL_REVIEW` is terminal, any further creator replies on the thread do not re-enter the workflow and produce no new state transitions or `CONTENT_LINKS_SUBMITTED` events — the instance is escalated once and stays escalated. Those later replies remain part of the email thread and are visible to the operator through the email conversation link, so a creator who follows up with an extra link or a correction is never lost; the operator simply sees it in context. This keeps the workflow idempotent at the escalation boundary while relying on the live email thread, rather than the workflow engine, as the running record of the conversation.

### Stage 6 — Operator reviews manually

The operator opens the email conversation link, reviews the thread history for the full context of the agreement, opens each submitted URL, and performs verification. All verification, and any downstream action such as approving a payout, happens outside this system. The workflow's automated responsibility ends at delivering a well-contextualized handoff.

## State Machine Changes

Only the logical transitions relevant to this feature are described here.

A new state, **`CONTENT_LINKS_PENDING`**, is introduced. The name follows the existing `NOUN_STATE` convention used across the funnel (`PAYMENT_PENDING`, `REWARD_PENDING`), and it plays the same structural role as `PAYMENT_PENDING`: a waiting state that holds the conversation open while the system awaits a specific reply from the creator.

The end of the payout flow is retargeted. Where the content-brief step previously advanced to the terminal `CONTENT_BRIEF_SENT`, it now advances to `CONTENT_LINKS_PENDING`. From there:

- A reply that contains content URLs routes the instance forward into `MANUAL_REVIEW`.
- A reply with no URLs keeps the instance on `CONTENT_LINKS_PENDING` (self-loop) after a nudge.
- An opt-out reply routes to `OPTED_OUT`.

**Why this state is intentionally non-terminal.** The inbound email worker drops replies to terminal-state instances. A terminal parking state would therefore make it impossible for the creator to submit links by replying in the thread — the entire premise of the feature. `CONTENT_LINKS_PENDING` must remain non-terminal so the worker accepts and routes the creator's reply. `MANUAL_REVIEW` remains the terminal endpoint of the automated path, reached once — on the first reply that yields a `CONTENT_LINKS_SUBMITTED` event.

Updated state diagram (post-payout segment):

```text
        payout form submitted
   PAYMENT_PENDING ─────────────► CONTENT_LINKS_PENDING ──────────► MANUAL_REVIEW
                                     │        ▲     │                (terminal —
                          no URLs →  │        │     │  URLs found →   human handoff)
                           nudge +   └────────┘     │
                           stay                     │
                                                    └──────────────► OPTED_OUT
                                       opt-out reply                 (terminal)
```

`CONTENT_LINKS_PENDING` is deliberately excluded from the set of terminal states.

## Persistence

Submitted content URLs live **inside the payload of the `CONTENT_LINKS_SUBMITTED` event** appended to the instance's history when links are extracted. The payload carries the list of extracted URLs as structured data on that single event; the workflow history remains append-only, and no per-instance field is mutated.

**No new database table is introduced.** The event history is already the durable, append-only record of everything that happens to an instance, and the manual queue already derives its context (such as escalation reason) from it. Appending the URLs as an event keeps this feature within the existing event-sourced model and avoids new schema, table migrations, or bespoke read paths. The new `CONTENT_LINKS_PENDING` state and `CONTENT_LINKS_SUBMITTED` event type must be added to the instance-state enum and to every server-side allowlist that validates states and event types, so neither is ever rejected as malformed.

## Escalation

The escalation produced when a creator submits content links should give an operator everything needed to *begin* manual review, and nothing more. It carries a single objective reason — *"Creator submitted content links"* — that states what happened without implying a judgment; the system reports the fact, and the operator performs the review.

The escalation includes:

- the **creator** identity,
- the **campaign**,
- the **submitted URLs**, rendered so each is directly openable, and
- an **email conversation link** as the primary entry point to full context.

### The email conversation link as canonical context

The email conversation link is the **canonical source of conversational history** for this handoff, and the escalation is designed around it. It is a provider-agnostic deep link into the underlying email thread — described in generic terms, never tied to a specific email provider's interface — and it opens the complete negotiation, agreement, and content-submission exchange in its original form.

This makes the recently added conversation-link capability central to the workflow rather than incidental. Because a single link reliably reconstructs the entire history:

- **Operators open the conversation link first.** It is the main call to action in both the escalation notification and the manual queue; everything else in the escalation is a summary that points back to it.
- **The escalation intentionally avoids embedding long transcripts.** Duplicating the full back-and-forth in the notification body is redundant with the link, bloats the message, and drifts out of sync with the live thread the moment the creator sends another reply. The escalation stays compact — identity, campaign, links, and reason — and lets the conversation link carry the depth.
- **Manual follow-up happens inside the existing email thread.** When the operator needs to respond — to ask for a missing link, confirm a post, or continue the relationship — they do so directly in the same thread, keeping one continuous, authoritative record instead of splintering the conversation across surfaces. This is also why later creator replies after escalation (see *System Behavior, Stage 5*) need no special handling: they simply appear in the same thread the operator is already working in.

## Manual Queue

The manual-queue entry for a content-links escalation is intentionally lightweight. It shows only:

- **creator**,
- **campaign**,
- **submitted link count**,
- **submitted URLs**,
- **reason** ("Creator submitted content links"), and
- **conversation link**.

There are **no approve/reject actions**. The queue is a launch point, not a control panel. The email conversation is the source of truth, and the queue gives the operator only what is needed to open the right conversation and the right links. This preserves the existing notify-only philosophy: the system routes and informs; the human reviews and acts.

## Technical Changes

This section describes the responsibilities each subsystem takes on. It is an orientation for reviewers and implementers, not a line-by-line prescription; the exact edits are left to implementation.

- **State machine** — owns the new `CONTENT_LINKS_PENDING` state, its transitions, and the retargeting of the payout-success edge away from `CONTENT_BRIEF_SENT`. Responsible for keeping the new state out of the terminal set.
- **State and event vocabulary** — the instance-state enum and the server-side allowlists that validate states and event types must recognize both `CONTENT_LINKS_PENDING` and `CONTENT_LINKS_SUBMITTED`. This closes the known failure mode in which an unlisted value is rejected as malformed and silently degraded to an unknown intent.
- **Content-brief step** — responsible for two changes: adding the "reply with your content link(s)" request to the merged brief copy, and parking on `CONTENT_LINKS_PENDING` rather than terminating on `CONTENT_BRIEF_SENT`.
- **Inbound routing** — the inbound email worker gains responsibility for dispatching replies received in `CONTENT_LINKS_PENDING` to the content-links handler, mirroring how it already routes replies for other waiting states.
- **Content-links handler** (new) — owns reply handling for this state: a deterministic opt-out gate, deterministic URL extraction from the de-quoted reply, appending the `CONTENT_LINKS_SUBMITTED` event and escalating when URLs are present, and an idempotent nudge that holds the state when they are absent.
- **Escalation notification** — responsible for the objective content-links reason label and for presenting the submitted URLs and the email conversation link, while deliberately not embedding the full transcript.
- **Manual queue read path** — responsible for deriving the creator, campaign, link count, submitted URLs, reason, and conversation link for a queue entry from the `CONTENT_LINKS_SUBMITTED` event and existing instance context.

No new database table, and no payout, obligation, or approval logic, is part of this work.

## Testing

Acceptance is defined by observable workflow behavior, not internal wiring. A correct implementation satisfies each of the following.

- **Content-brief handoff.** After payout submission, the instance parks on `CONTENT_LINKS_PENDING`, and the brief email contains the request to reply with content links.
- **Non-terminal reply acceptance.** A reply arriving while the instance is in `CONTENT_LINKS_PENDING` is accepted and routed rather than dropped.
- **Link submission escalates.** A reply containing one or more URLs moves the instance to `MANUAL_REVIEW`, appends a `CONTENT_LINKS_SUBMITTED` event whose payload contains exactly the submitted URLs, and produces an escalation carrying the "Creator submitted content links" reason.
- **No-link reply holds and nudges.** A reply with no URLs leaves the instance on `CONTENT_LINKS_PENDING` and sends a single nudge; a redelivered copy of the same reply does not double-send.
- **Opt-out precedence.** An unsubscribe-style reply routes to `OPTED_OUT` regardless of any URLs present, and no nudge or marketing auto-reply is sent.
- **Idempotent escalation on repeat replies.** After the first qualifying submission, further replies on the thread produce no additional state transitions and no additional `CONTENT_LINKS_SUBMITTED` events; the instance remains escalated exactly once.
- **Escalation content.** The escalation and the manual-queue entry expose the creator, campaign, submitted URLs, link count, reason, and email conversation link, and do not embed a full email transcript.
- **No decision surface.** The manual queue exposes no approve/reject action, and content submission triggers no payout or ledger side effects.
- **Regression.** Existing payout and content-brief flows continue to function with the retargeted transition.
