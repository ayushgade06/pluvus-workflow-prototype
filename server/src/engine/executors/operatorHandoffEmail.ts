import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Operator handoff — the creator-facing "looping in our campaign manager" note
// ---------------------------------------------------------------------------
// The ONE email an operator_handoff execution sends after a successful
// negotiation. It replaces the merged Content Brief email (finalized offer +
// payout link + brief PDF) entirely.
//
// Deliberately short and deliberately quiet on terms. The deal is about to be
// finalized by a human in the main Pluvus platform, so restating fee/commission
// here would create a second, competing statement of the agreement that nobody
// owns — and the acceptance snapshot the operator works from is the record that
// matters. This note's only job is to set the creator's expectation that a
// person is taking over and that a link is coming.
//
// Kept as a pure builder (like contentBriefEmail.ts / rewardEmail.ts) so the copy
// is unit-testable without a DB, a mailbox, or the file system.

export interface OperatorHandoffInput {
  creatorName: string;
  brandName: string;
}

/** Render the handoff note sent to the creator on ACCEPTED → NEEDS_DEAL_FINALIZATION. */
export function renderOperatorHandoffEmail(input: OperatorHandoffInput): EmailDraft {
  const lines = [
    `Hi ${input.creatorName},`,
    ``,
    `That sounds great. I'm looping in our campaign manager to finalize your onboarding details. They'll follow up shortly with your onboarding link.`,
    ``,
    `Thanks,`,
    `${input.brandName}`,
  ];

  return { subject: `Next steps for your ${input.brandName} partnership`, body: lines.join("\n") };
}
