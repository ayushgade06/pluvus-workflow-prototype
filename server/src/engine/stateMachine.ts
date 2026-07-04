import type { InstanceState } from "@prisma/client";

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<InstanceState, InstanceState[]> = {
  // MANUAL_REVIEW is reachable from the outreach/follow-up states too (H4): if the
  // output guard catches a floor/ceiling leak in an AI-generated outreach or
  // follow-up email, the funnel halts for human review instead of sending it.
  ENROLLED: ["OUTREACH_SENT", "OPTED_OUT", "MANUAL_REVIEW"],
  OUTREACH_SENT: ["AWAITING_REPLY", "OPTED_OUT"],
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
  NEGOTIATING: ["NEGOTIATING", "AWAITING_REPLY", "ACCEPTED", "REJECTED", "OPTED_OUT", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
  // Brand-decision waiting state. The run is parked on the brand's reply and
  // resumes automatically:
  //   AWAITING_BRAND_DECISION → stay put on an ambiguous reply (re-ask once)
  //   NEGOTIATING             → brand approved a counter / re-opened talks
  //   ACCEPTED                → brand approved the creator's number → Reward Setup
  //   REJECTED                → brand rejected the deal (terminal)
  //   REWARD_PENDING          → brand approved → jump straight into reward setup
  //   OPTED_OUT               → creator opted out while parked
  //   MANUAL_REVIEW           → brand asked for a full human handoff, or timed out
  // The L4 config-fix variant (missing brand name) also re-runs the blocked node
  // after the brand supplies a name, so it can transition BACK to the state that
  // node runs from: ACCEPTED (Reward Setup), REWARD_CONFIRMED (Payment Info), or
  // PAYMENT_RECEIVED (Content Brief).
  AWAITING_BRAND_DECISION: [
    "AWAITING_BRAND_DECISION",
    "NEGOTIATING",
    "ACCEPTED",
    "REJECTED",
    "REWARD_PENDING",
    "REWARD_CONFIRMED",
    "PAYMENT_RECEIVED",
    "OPTED_OUT",
    "MANUAL_REVIEW",
  ],
  // ACCEPTED is no longer terminal: a successful negotiation auto-advances into
  // the Reward Setup node, which finalizes the agreement and emails the creator.
  // MANUAL_REVIEW is reachable (L4) if the confirmation email has no resolvable
  // brand name — halt for a human rather than email a creator "your brand".
  // AWAITING_BRAND_DECISION is the L4 config-fix path: instead of dead-ending, ask
  // the brand for the missing name by email, then re-run Reward Setup from here.
  ACCEPTED: ["REWARD_PENDING", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
  // Reward Setup waiting state. Stays here on a non-confirming reply
  // (REWARD_PENDING → REWARD_PENDING), advances on an agreement reply, and can
  // still be escalated to a human.
  REWARD_PENDING: ["REWARD_PENDING", "REWARD_CONFIRMED", "MANUAL_REVIEW"],
  // Reward Setup success. No longer terminal: a confirmed agreement auto-advances
  // into the Payment Info node, which collects the creator's payout details.
  // MANUAL_REVIEW reachable (L4) on a missing brand name in the payment email;
  // AWAITING_BRAND_DECISION is the L4 config-fix path (ask brand → re-run here).
  REWARD_CONFIRMED: ["PAYMENT_PENDING", "AWAITING_BRAND_DECISION", "MANUAL_REVIEW"],
  // Payment Info waiting state. Stays here until the creator submits the payout
  // form (PAYMENT_PENDING → PAYMENT_RECEIVED), and can still be escalated.
  PAYMENT_PENDING: ["PAYMENT_PENDING", "PAYMENT_RECEIVED", "MANUAL_REVIEW"],
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
