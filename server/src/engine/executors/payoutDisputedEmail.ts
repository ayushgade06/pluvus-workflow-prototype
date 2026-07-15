import type { EmailDraft } from "../types.js";
import { formatCents } from "./payoutSentEmail.js";

// ---------------------------------------------------------------------------
// Payout Disputed — "[DISPUTE] creator did not receive $X" email to the BRAND
// ---------------------------------------------------------------------------
// Sent when the creator clicks the dispute link. Goes to the brand (recipient
// resolved via the Phase-11 chain: campaign.notifyEmail → BRAND_NOTIFY_EMAIL →
// operator). Pure deterministic builder; the amount is rendered from cents.

export interface PayoutDisputedInput {
  creatorName: string;
  brandName: string;
  amountCents: number;
  currency: string;
  /** PayPal transaction reference the brand recorded when marking it sent. */
  reference?: string | null;
  payoutId: string;
}

export function renderPayoutDisputedEmail(input: PayoutDisputedInput): EmailDraft {
  const amount = formatCents(input.amountCents, input.currency);
  const subject = `[DISPUTE] ${input.creatorName} did not receive ${amount}`;

  const body = [
    `Hi ${input.brandName} team,`,
    ``,
    `${input.creatorName} has reported that they did NOT receive the payout you marked as sent.`,
    ``,
    `Amount:    ${amount}`,
    ...(input.reference ? [`Reference: ${input.reference}`] : []),
    `Payout ID: ${input.payoutId}`,
    ``,
    `Please check the payment in PayPal and follow up with the creator directly. Once resolved, mark the payout as settled in the Partners dashboard.`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: body.join("\n") };
}
