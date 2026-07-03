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
  AWAITING_REPLY: ["FOLLOWED_UP", "REPLY_RECEIVED", "NO_RESPONSE", "OPTED_OUT", "MANUAL_REVIEW"],
  FOLLOWED_UP: ["AWAITING_REPLY", "REPLY_RECEIVED", "OPTED_OUT"],
  REPLY_RECEIVED: ["NEGOTIATING", "REJECTED", "OPTED_OUT", "MANUAL_REVIEW"],
  NEGOTIATING: ["NEGOTIATING", "AWAITING_REPLY", "ACCEPTED", "REJECTED", "OPTED_OUT", "MANUAL_REVIEW"],
  // ACCEPTED is no longer terminal: a successful negotiation auto-advances into
  // the Reward Setup node, which finalizes the agreement and emails the creator.
  ACCEPTED: ["REWARD_PENDING"],
  // Reward Setup waiting state. Stays here on a non-confirming reply
  // (REWARD_PENDING → REWARD_PENDING), advances on an agreement reply, and can
  // still be escalated to a human.
  REWARD_PENDING: ["REWARD_PENDING", "REWARD_CONFIRMED", "MANUAL_REVIEW"],
  // Reward Setup success. No longer terminal: a confirmed agreement auto-advances
  // into the Payment Info node, which collects the creator's payout details.
  REWARD_CONFIRMED: ["PAYMENT_PENDING"],
  // Payment Info waiting state. Stays here until the creator submits the payout
  // form (PAYMENT_PENDING → PAYMENT_RECEIVED), and can still be escalated.
  PAYMENT_PENDING: ["PAYMENT_PENDING", "PAYMENT_RECEIVED", "MANUAL_REVIEW"],
  // Payment Info success. No longer terminal: the payout submission auto-advances
  // into the Content Brief node. Content Brief has NO waiting state — it sends the
  // brief email and completes in a single step — so PAYMENT_RECEIVED transitions
  // straight to the CONTENT_BRIEF_SENT terminal.
  PAYMENT_RECEIVED: ["CONTENT_BRIEF_SENT"],
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
