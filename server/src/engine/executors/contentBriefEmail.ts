import type { EmailDraft } from "../types.js";
import { splitDeliverables } from "./rewardEmail.js";

// ---------------------------------------------------------------------------
// Content Brief — "Your Campaign Brief" email copy (merged post-negotiation email)
// ---------------------------------------------------------------------------
// This is now the SINGLE email sent after a successful negotiation. It merges what
// used to be three separate emails (Reward Setup confirmation + Payment Info
// request + Content Brief) into one:
//   1. the finalized offer terms (fee / commission / deliverables / timeline),
//   2. a secure tokenized payout-form link the creator completes, and
//   3. the campaign brief itself (PDF attached by the executor) + optional
//      referral link and brand notes.
// Kept as a pure builder (like rewardEmail.ts / paymentEmail.ts) so it is the
// single source of truth for the body and is unit-testable without a DB or the
// file system. The PDF attachment is loaded + attached by the executor; this only
// renders the text.

export interface ContentBriefInput {
  creatorName: string;
  brandName: string;
  /** Secure tokenized payout-form link the creator must complete. Required. */
  formLink: string;
  /** Final agreed fee. Rendered as "$<n>", or "the agreed fee" when undefined. */
  fixedFee?: number | undefined;
  /** Commission %. Rendered as "<n>%", or "None" when absent/zero. */
  commissionRate?: number | undefined;
  /** Free-text deliverables scope; split into bullets. */
  deliverables?: string | undefined;
  /** Optional go-live timeline; stated only when present. */
  timeline?: string | undefined;
  /** The brand-configured referral link. Empty string when not configured. */
  referralLink: string;
  /** Optional brand-authored notes, shown in the body. Empty string when none. */
  creatorNotes: string;
  /** Optional product/sample reward blurb. Empty string for cash-only deals. */
  rewardDescription?: string;
}

/** Render the merged "Your Campaign Brief" email body + subject. */
export function renderContentBriefEmail(input: ContentBriefInput): EmailDraft {
  const referral = input.referralLink.trim();
  const notes = input.creatorNotes.trim();
  const reward = (input.rewardDescription ?? "").trim();
  const formLink = input.formLink.trim();

  // Finalized-terms block — mirrors renderRewardConfirmationEmail's formatting so
  // the offer reads identically to the old confirmation email.
  const feeLine = input.fixedFee !== undefined ? `$${input.fixedFee}` : `the agreed fee`;
  const commissionLine =
    input.commissionRate && input.commissionRate > 0 ? `${input.commissionRate}%` : `None`;
  const items = splitDeliverables(input.deliverables);
  const deliverablesBlock =
    items.length > 0 ? items.map((d) => `    - ${d}`).join("\n") : `    - To be finalized`;
  const timeline =
    typeof input.timeline === "string" && input.timeline.trim() ? input.timeline.trim() : undefined;

  const lines: string[] = [
    `Hi ${input.creatorName},`,
    ``,
    `Welcome aboard! We're excited to officially begin the campaign.`,
    ``,
    `Here are your finalized terms:`,
    ``,
    `• Fixed Fee: ${feeLine}`,
    `• Commission: ${commissionLine}`,
    `• Deliverables:`,
    deliverablesBlock,
    // Reward + Timeline are optional lines, appended only when supplied.
    ...(reward ? [`• Reward: ${reward}`] : []),
    ...(timeline ? [`• Timeline: ${timeline}`] : []),
    ``,
    `Before we begin, please complete your secure payout information here:`,
    ``,
    formLink,
    ``,
    `Attached is your campaign brief containing all campaign requirements, deliverables, timelines, and content guidelines.`,
  ];

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
