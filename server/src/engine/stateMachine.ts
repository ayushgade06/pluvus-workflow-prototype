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
  // AWAITING_BRAND_DECISION is reachable alongside MANUAL_REVIEW for the *business*
  // escalations (A1/A2 unclassifiable creator reply): the brand reads intent by
  // email and the run auto-resumes. Pure safety/infra failures still take the
  // MANUAL_REVIEW edge.
  AWAITING_REPLY: ["FOLLOWED_UP", "REPLY_RECEIVED", "NO_RESPONSE", "OPTED_OUT", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
  FOLLOWED_UP: ["AWAITING_REPLY", "REPLY_RECEIVED", "OPTED_OUT"],
  REPLY_RECEIVED: ["NEGOTIATING", "REJECTED", "OPTED_OUT", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
  // Negotiation business escalations (B9 max rounds, B10 rate above ceiling, B11
  // max rounds on counter) reach AWAITING_BRAND_DECISION instead of dead-ending in
  // MANUAL_REVIEW. The draft-leak guard block (B12) still goes to MANUAL_REVIEW.
  // CRITICAL-6: a creator can reply again mid-negotiation (a second reply arrives
  // before we've sent our turn). Without a REPLY_RECEIVED edge, injectReply
  // persisted the row then threw on assertTransition, losing the reply on retry.
  // The edge buffers such a reply into the reply-detection/negotiation path
  // instead of dropping it.
  NEGOTIATING: ["NEGOTIATING", "AWAITING_REPLY", "REPLY_RECEIVED", "ACCEPTED", "REJECTED", "OPTED_OUT", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
  // Brand-decision waiting state. The run is parked on the brand's reply and
  // resumes automatically:
  //   AWAITING_BRAND_DECISION → stay put on an ambiguous reply (re-ask once)
  //   NEGOTIATING             → brand approved a counter / re-opened talks
  //   ACCEPTED                → brand approved the creator's number → Content Brief
  //   REJECTED                → brand rejected the deal (terminal)
  //   REWARD_PENDING          → brand approved → jump straight into reward setup (legacy)
  //   OPTED_OUT               → creator opted out while parked
  //   MANUAL_REVIEW           → brand asked for a full human handoff, or timed out
  // The L4 config-fix variant (missing brand name) also re-runs the blocked node
  // after the brand supplies a name, so it can transition BACK to the state that
  // node runs from: ACCEPTED (Content Brief send phase), PAYMENT_PENDING (Content
  // Brief re-run after send), plus the legacy REWARD_PENDING (Reward Setup),
  // REWARD_CONFIRMED (Payment Info) and PAYMENT_RECEIVED (legacy Content Brief).
  AWAITING_BRAND_DECISION: [
    "AWAITING_BRAND_DECISION",
    "NEGOTIATING",
    "ACCEPTED",
    "REJECTED",
    "REWARD_PENDING",
    "REWARD_CONFIRMED",
    "PAYMENT_PENDING",
    "PAYMENT_RECEIVED",
    "OPTED_OUT",
    "MANUAL_REVIEW",
  ],
  // ACCEPTED is no longer terminal: a successful negotiation auto-advances into
  // the Content Brief node, which sends the merged offer + payout link + brief
  // email and parks in PAYMENT_PENDING. (Legacy graphs advance into Reward Setup
  // → REWARD_PENDING instead.) MANUAL_REVIEW is reachable (L4) if the email has no
  // resolvable brand name. AWAITING_BRAND_DECISION is the L4 config-fix path: ask
  // the brand for the missing name by email, then re-run the node from here.
  ACCEPTED: ["PAYMENT_PENDING", "REWARD_PENDING", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
  // Reward Setup waiting state. Stays here on a non-confirming reply
  // (REWARD_PENDING → REWARD_PENDING), advances on an agreement reply, and can
  // still be escalated to a human. MED-W1: OPTED_OUT is reachable — an
  // "unsubscribe" reply while awaiting agreement must opt the creator out, not
  // get a "rate is fixed" auto-reply (CAN-SPAM).
  REWARD_PENDING: ["REWARD_PENDING", "REWARD_CONFIRMED", "OPTED_OUT", "MANUAL_REVIEW"],
  // Reward Setup success. No longer terminal: a confirmed agreement auto-advances
  // into the Payment Info node, which collects the creator's payout details.
  // MANUAL_REVIEW reachable (L4) on a missing brand name in the payment email;
  // AWAITING_BRAND_DECISION is the L4 config-fix path (ask brand → re-run here).
  REWARD_CONFIRMED: ["PAYMENT_PENDING", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
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
  // MANUAL_REVIEW reachable (L4) on a missing brand name in the content-brief email;
  // AWAITING_BRAND_DECISION is the L4 config-fix path (ask brand → re-run here).
  PAYMENT_RECEIVED: ["CONTENT_BRIEF_SENT", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
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
