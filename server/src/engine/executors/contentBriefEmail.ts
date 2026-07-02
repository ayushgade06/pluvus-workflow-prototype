import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Content Brief — "Your Campaign Brief" email copy
// ---------------------------------------------------------------------------
// Deterministic template (like rewardEmail.ts / paymentEmail.ts): welcomes the
// creator, states that the campaign brief is attached, includes the configured
// referral link, and appends the brand's optional creator notes. Kept as a pure
// builder so it is the single source of truth for the body and is unit-testable
// without a DB or the file system. The PDF attachment itself is loaded + attached
// by the executor; this only renders the text.

export interface ContentBriefInput {
  creatorName: string;
  brandName: string;
  /** The brand-configured referral link. Empty string when not configured. */
  referralLink: string;
  /** Optional brand-authored notes, shown in the body. Empty string when none. */
  creatorNotes: string;
  /** Optional product/sample reward blurb. Empty string for cash-only deals. */
  rewardDescription?: string;
}

/** Render the "Your Campaign Brief" email body + subject. */
export function renderContentBriefEmail(input: ContentBriefInput): EmailDraft {
  const referral = input.referralLink.trim();
  const notes = input.creatorNotes.trim();
  const reward = (input.rewardDescription ?? "").trim();

  const lines: string[] = [
    `Hi ${input.creatorName},`,
    ``,
    `Welcome aboard!`,
    ``,
    `We're excited to officially begin the campaign.`,
    ``,
    `Attached is your campaign brief containing all campaign requirements, deliverables, timelines, and content guidelines.`,
  ];

  // Product/sample reward reminder — only when the brand configured a reward.
  if (reward) {
    lines.push(``, `As part of this collaboration, you'll receive ${reward}.`);
  }

  // Referral link — only stated when the brand configured one (it's optional).
  if (referral) {
    lines.push(``, `Your referral link:`, ``, referral);
  }

  // Optional creator notes — appended verbatim as their own paragraph.
  if (notes) {
    lines.push(``, notes);
  }

  lines.push(
    ``,
    `Please review the attached document carefully before creating your content.`,
    ``,
    `If you have any questions, simply reply to this email.`,
    ``,
    `Looking forward to working with you!`,
    ``,
    `Thanks,`,
    `${input.brandName}`,
  );

  return { subject: `Your Campaign Brief`, body: lines.join("\n") };
}
