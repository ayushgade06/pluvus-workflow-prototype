import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// "Rate is finalized" auto-reply copy (post-acceptance re-negotiation guard)
// ---------------------------------------------------------------------------
// Once a deal is ACCEPTED the fee is locked — there is no further negotiation.
// If a creator replies at a post-acceptance stage (Reward Setup waiting on the
// agreement confirmation, or Payment Info waiting on the payout form) trying to
// re-open the price, we send a polite, deterministic acknowledgement that:
//   1. States the agreed rate is finalized and cannot be changed, and
//   2. Redirects them to the ONE action left at their current stage —
//        reward stage  → reply to confirm the agreement / ask brief questions
//        payment stage → complete the payout form at the link.
//
// Deterministic template (like rewardEmail.ts / paymentEmail.ts): no AI, no
// negotiation. Kept as a pure builder so it is the single source of truth for
// the copy and is unit-testable without a DB.

/** Which post-acceptance stage the creator is currently parked in. */
export type RateFixedStage = "reward" | "payment";

export interface RateFixedInput {
  creatorName: string;
  brandName: string;
  senderName: string;
  /** The agreed fixed fee, when known, so the reply can name the locked figure
   *  ("the agreed fee of $350"). Falls back to generic wording when absent. */
  agreedFee?: number | undefined;
  /** For the payment stage: the tokenized payout-form link to re-share so the
   *  creator can act on the redirect. Ignored for the reward stage. */
  formLink?: string | undefined;
  /** For the payment stage: whether the form also collects a shipping address,
   *  so the copy mentions it. Ignored for the reward stage. */
  collectShippingAddress?: boolean | undefined;
}

/** Render the "rate is finalized" auto-reply body + subject for a stage. */
export function renderRateFixedEmail(
  stage: RateFixedStage,
  input: RateFixedInput,
): EmailDraft {
  const feePhrase =
    input.agreedFee !== undefined ? `the agreed fee of $${input.agreedFee}` : `the agreed fee`;

  // Shared opening: acknowledge the reply, state the rate is locked. Framed
  // warmly so it doesn't read as a rejection — the deal is DONE, not off.
  const opening = [
    `Hi ${input.creatorName},`,
    ``,
    `Thanks for getting back to us. To confirm: the terms for this collaboration have been finalized, and ${feePhrase} is fixed and cannot be changed at this stage.`,
  ];

  const closing = [``, `Best,`, `${input.senderName}`];

  if (stage === "reward") {
    const body = [
      ...opening,
      ``,
      `The only step remaining is to confirm the agreement. If everything looks correct, simply reply:`,
      ``,
      `"I Agree"`,
      ``,
      `If you have any questions about the campaign or the content brief, feel free to ask here and we'll be happy to help.`,
      ...closing,
    ].join("\n");
    return { subject: `Re: Campaign Agreement Confirmation`, body };
  }

  // payment stage
  const formLine = input.formLink ? [``, input.formLink] : [];
  const actionSentence = input.collectShippingAddress
    ? `The next step is simply to complete your payout information and shipping address on the secure form below.`
    : `The next step is simply to complete your payout information on the secure form below.`;
  const body = [
    ...opening,
    ``,
    actionSentence,
    ...formLine,
    ``,
    `If you have any questions about the campaign or the content brief, feel free to ask here and we'll be happy to help.`,
    ...closing,
  ].join("\n");
  return { subject: `Re: Payment Information Required`, body };
}
