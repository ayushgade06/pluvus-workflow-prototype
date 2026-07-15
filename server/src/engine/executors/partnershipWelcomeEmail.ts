import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Partnership welcome email — sent once per completed creator run.
// Pure template builder (deterministic, no DB, unit-testable).
// ---------------------------------------------------------------------------

export interface PartnershipWelcomeInput {
  creatorName: string;
  brandName: string;
  senderName: string;
  trackingLink?: string | null;
  agreedFeeCents?: number | null;
  commissionRate?: number | null;
}

function centsToDisplay(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}`;
}

export function renderPartnershipWelcomeEmail(
  input: PartnershipWelcomeInput,
): EmailDraft {
  const hasLink = !!input.trackingLink;

  const subject = hasLink
    ? `You're all set — here's your tracking link`
    : `You're all set — next steps for your collaboration`;

  const termsLines: string[] = [];
  if (input.agreedFeeCents != null) {
    termsLines.push(`Fixed fee: ${centsToDisplay(input.agreedFeeCents)}`);
  }
  if (input.commissionRate != null) {
    termsLines.push(`Commission: ${input.commissionRate}%`);
  }
  const termsBlock =
    termsLines.length > 0
      ? [``, `Your agreed terms:`, ...termsLines.map((l) => `  • ${l}`)]
      : [];

  const trackingBlock = hasLink
    ? [
        ``,
        `Here is your unique tracking link — share this exact URL with your audience:`,
        ``,
        input.trackingLink!,
        ``,
        `When someone clicks your link and purchases on our site, that conversion is attributed to you and counts toward your commission (if applicable).`,
      ]
    : [
        ``,
        `We'll be in touch shortly with more details about next steps for your collaboration.`,
      ];

  const body = [
    `Hi ${input.creatorName},`,
    ``,
    `Thank you for completing your payout information. Your collaboration with ${input.brandName} is confirmed and we have everything we need to get started.`,
    ...termsBlock,
    ...trackingBlock,
    ``,
    `If you have any questions, just reply to this email.`,
    ``,
    `Best,`,
    input.senderName,
  ].join("\n");

  return { subject, body };
}
