import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Content-links nudge copy (no-URL reply while awaiting content links)
// ---------------------------------------------------------------------------
// While an instance is parked in CONTENT_LINKS_PENDING we asked the creator to
// reply in the thread with the link(s) to their published content. If they reply
// but the message contains no URLs (a question, "will do", "not live yet"), send
// a gentle nudge asking them to paste the link(s), and keep waiting.
//
// Deterministic template (like rateFixedEmail.ts): no AI. Pure builder so it is
// the single source of truth for the copy and is unit-testable without a DB.

export interface ContentLinksNudgeInput {
  creatorName: string;
  /** Signs off the email; falls back to the brand name in the caller. */
  senderName: string;
}

/** Render the "please share your content link(s)" nudge body + subject. */
export function renderContentLinksNudgeEmail(input: ContentLinksNudgeInput): EmailDraft {
  const body = [
    `Hi ${input.creatorName},`,
    ``,
    `Thanks for getting back to us! Once your content is live, please reply to this email with the link(s) to your posted content so we can review it.`,
    ``,
    `If it isn't live yet, no problem — just send the link(s) whenever it's ready.`,
    ``,
    `Best,`,
    `${input.senderName}`,
  ].join("\n");
  return { subject: `Re: Your Campaign Brief`, body };
}
