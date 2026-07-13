import type { InstanceState } from "@prisma/client";

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<InstanceState, InstanceState[]> = {
  // MANUAL_REVIEW is reachable from the outreach/follow-up states too (H4): if the
  // output guard catches a floor/ceiling leak in an AI-generated outreach or
  // follow-up email, the funnel halts for human review instead of sending it.
  ENROLLED: ["OUTREACH_SENT", "OPTED_OUT", "MANUAL_REVIEW"],
  // CRITICAL-6: a creator reply can arrive while the instance is still
  // OUTREACH_SENT (before the scheduler has transitioned it to AWAITING_REPLY).
  // Without a REPLY_RECEIVED edge here, injectReply persisted the Message row and
  // THEN assertTransition threw — leaving the reply persisted-but-unprocessed and
  // permanently lost on retry (the idempotency check no-ops once the row exists).
  // Accepting the edge lets the reply be buffered and processed instead of dropped.
  OUTREACH_SENT: ["AWAITING_REPLY", "REPLY_RECEIVED", "OPTED_OUT"],
  AWAITING_REPLY: ["FOLLOWED_UP", "REPLY_RECEIVED", "NO_RESPONSE", "OPTED_OUT", "MANUAL_REVIEW"],
  FOLLOWED_UP: ["AWAITING_REPLY", "REPLY_RECEIVED", "OPTED_OUT"],
  // Phase D (#3): a DEFERRED reply ("I'll think about it") loops back to
  // AWAITING_REPLY with a dueAt so the soft follow-up fires a few days out — the
  // pending-reply STATE is reused, distinct from the DEFERRED intent.
  REPLY_RECEIVED: ["NEGOTIATING", "REJECTED", "OPTED_OUT", "AWAITING_REPLY", "MANUAL_REVIEW"],
  // Negotiation escalations (#14) route to MANUAL_REVIEW (over-ceiling / draft
  // guard) or REJECTED (max-rounds no agreement, #15) — a clean one-way handoff,
  // no brand-decision loop. CRITICAL-6: a creator can reply again mid-negotiation
  // (a second reply arrives before we've sent our turn). Without a REPLY_RECEIVED
  // edge, injectReply persisted the row then threw on assertTransition, losing the
  // reply on retry. The edge buffers such a reply into the reply-detection/
  // negotiation path instead of dropping it.
  NEGOTIATING: ["NEGOTIATING", "AWAITING_REPLY", "REPLY_RECEIVED", "ACCEPTED", "REJECTED", "OPTED_OUT", "MANUAL_REVIEW"],
  // ACCEPTED is no longer terminal: a successful negotiation auto-advances into
  // the Content Brief node, which sends the merged offer + payout link + brief
  // email and parks in PAYMENT_PENDING. (Legacy graphs advance into Reward Setup
  // → REWARD_PENDING instead.) MANUAL_REVIEW is reachable (L4) if the email has no
  // resolvable brand name.
  ACCEPTED: ["PAYMENT_PENDING", "REWARD_PENDING", "MANUAL_REVIEW"],
  // Reward Setup waiting state. Stays here on a non-confirming reply
  // (REWARD_PENDING → REWARD_PENDING), advances on an agreement reply, and can
  // still be escalated to a human. MED-W1: OPTED_OUT is reachable — an
  // "unsubscribe" reply while awaiting agreement must opt the creator out, not
  // get a "rate is fixed" auto-reply (CAN-SPAM).
  REWARD_PENDING: ["REWARD_PENDING", "REWARD_CONFIRMED", "OPTED_OUT", "MANUAL_REVIEW"],
  // Reward Setup success. No longer terminal: a confirmed agreement auto-advances
  // into the Payment Info node, which collects the creator's payout details.
  // MANUAL_REVIEW reachable (L4) on a missing brand name in the payment email.
  REWARD_CONFIRMED: ["PAYMENT_PENDING", "MANUAL_REVIEW"],
  // Payout-collection waiting state. Stays here until the creator submits the
  // payout form. In the merged flow the Content Brief node owns this state and the
  // submission lands directly on the CONTENT_BRIEF_SENT terminal; in legacy graphs
  // the Payment Info node owns it and the submission lands on PAYMENT_RECEIVED
  // (which then chains into Content Brief). Both edges are kept. Can be escalated.
  // MED-W1: OPTED_OUT is reachable — an "unsubscribe" email while awaiting the
  // payout form must opt the creator out, not get the marketing auto-reply.
  PAYMENT_PENDING: ["PAYMENT_PENDING", "PAYMENT_RECEIVED", "CONTENT_BRIEF_SENT", "OPTED_OUT", "MANUAL_REVIEW"],
  // Payment Info success. No longer terminal: the payout submission auto-advances
  // into the Content Brief node. Content Brief has NO waiting state — it sends the
  // brief email and completes in a single step — so PAYMENT_RECEIVED transitions
  // straight to the CONTENT_BRIEF_SENT terminal.
  // MANUAL_REVIEW reachable (L4) on a missing brand name in the content-brief email.
  PAYMENT_RECEIVED: ["CONTENT_BRIEF_SENT", "MANUAL_REVIEW"],
  // Content Brief success. Terminal — the end of the linear graph.
  CONTENT_BRIEF_SENT: [],
  REJECTED: [],
  OPTED_OUT: [],
  NO_RESPONSE: [],
  // Human review queue — terminal until a human re-routes the instance.
  MANUAL_REVIEW: [],
};

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATES: InstanceState[] = [
  // ACCEPTED, REWARD_CONFIRMED and PAYMENT_RECEIVED are intentionally NOT terminal
  // anymore — they auto-advance into Reward Setup, Payment Info and Content Brief
  // respectively. CONTENT_BRIEF_SENT is the new success terminal.
  "CONTENT_BRIEF_SENT",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

export function isTerminal(state: InstanceState): boolean {
  return TERMINAL_STATES.includes(state);
}

export class InvalidTransitionError extends Error {
  constructor(from: InstanceState, to: InstanceState) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: InstanceState, to: InstanceState): void {
  // Allow same-state for no-op transitions (e.g. import node staying ENROLLED)
  if (from === to) return;
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}
