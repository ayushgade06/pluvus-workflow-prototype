import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Reward Setup — "Campaign Agreement Confirmation" email copy
// ---------------------------------------------------------------------------
// The confirmation email is a fixed template (not an AI-authored draft): it
// summarizes the finalized fee/commission/deliverables and asks the creator to
// reply "I Agree". Kept here as a pure builder so the executor's template
// fallback and the mock/real draft providers can all render identical copy, and
// so it is unit-testable without a DB.

export interface RewardConfirmationInput {
  creatorName: string;
  brandName: string;
  senderName: string;
  fixedFee: number | undefined;
  commissionRate: number | undefined;
  deliverables: string | undefined;
  /** Brand-supplied go-live timeline (e.g. "Content live by July 20, 2026").
   *  Stated as its own line only when present — never invented. */
  timeline?: string | undefined;
}

/** Split brand-supplied free-text deliverables into individual bullet lines.
 *  Accepts newline-, comma-, or "+"-separated scope (e.g. "2 Reels + 1 Story"),
 *  so each distinct deliverable renders as its own bullet. */
export function splitDeliverables(deliverables: string | undefined): string[] {
  if (!deliverables) return [];
  return deliverables
    .split(/\r?\n|,|\+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

/** Render the Campaign Agreement Confirmation email body + subject. */
export function renderRewardConfirmationEmail(input: RewardConfirmationInput): EmailDraft {
  const feeLine = input.fixedFee !== undefined ? `$${input.fixedFee}` : `the agreed fee`;
  const commissionLine =
    input.commissionRate && input.commissionRate > 0 ? `${input.commissionRate}%` : `None`;
  const items = splitDeliverables(input.deliverables);
  const deliverablesBlock =
    items.length > 0 ? items.map((d) => `    - ${d}`).join("\n") : `    - To be finalized`;
  const timeline = typeof input.timeline === "string" && input.timeline.trim()
    ? input.timeline.trim()
    : undefined;

  const body = [
    `Hi ${input.creatorName},`,
    ``,
    `Thank you for working with ${input.brandName}.`,
    ``,
    `We have successfully finalized the collaboration.`,
    ``,
    `Here is the agreed partnership:`,
    ``,
    `• Fixed Fee: ${feeLine}`,
    `• Commission: ${commissionLine}`,
    `• Deliverables:`,
    deliverablesBlock,
    // Timeline is an optional line, appended only when the brand supplied one.
    ...(timeline ? [`• Timeline: ${timeline}`] : []),
    ``,
    `If everything looks correct, simply reply:`,
    ``,
    `"I Agree"`,
    ``,
    `Once we receive your confirmation, we will send you the payment information form followed by the detailed campaign content brief.`,
    ``,
    `Looking forward to working with you!`,
    ``,
    `Best,`,
    `${input.senderName}`,
  ].join("\n");

  return { subject: `Campaign Agreement Confirmation`, body };
}
