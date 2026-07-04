// ---------------------------------------------------------------------------
// Actionable brand-decision escalation email (MANUAL_ESCALATION_RESOLUTION.md §2.5, §5.4)
// ---------------------------------------------------------------------------
// The email we send the brand when a *business* escalation parks the run in
// AWAITING_BRAND_DECISION. Unlike the terminal MANUAL_REVIEW notice
// (escalation.ts → buildEscalationEmail, "open the dashboard"), this email is
// ACTIONABLE: it states the question, tells the brand exactly how to reply
// (the deterministic cues APPROVE / REJECT / COUNTER <n> / HANDOFF), and offers
// one-click magic links that resolve the decision with zero parsing risk.
//
// Both channels ship together (locked decision 4): the free-text reply cues and
// the magic-link buttons are peers — the brand can use either.
//
// Kept as a pure builder (like rewardEmail.ts / paymentEmail.ts) so the copy is
// the single source of truth and is unit-testable without a DB. The caller (the
// brandDecision executor) supplies the resolved question + token + context.

import type { EmailDraft } from "../engine/types.js";
import { paymentBaseUrl } from "../engine/executors/paymentEmail.js";

// The magic-link actions the email renders as buttons. `counter` carries an
// amount via a query param the brand fills in (or a per-suggestion link the
// caller may pre-build); the plain link is the take-it/leave-it fallback.
export type BrandDecisionLinkAction = "approve" | "reject" | "counter" | "handoff";

/** The absolute magic-link URL for a brand-decision action. `counter` accepts an
 *  optional amount, rendered as `?amount=<n>` so a click resolves deterministically. */
export function brandDecisionLink(
  token: string,
  action: BrandDecisionLinkAction,
  amount?: number,
): string {
  const base = `${paymentBaseUrl()}/brand-decision/${token}/${action}`;
  if (action === "counter" && amount !== undefined && Number.isFinite(amount)) {
    return `${base}?amount=${encodeURIComponent(String(amount))}`;
  }
  return base;
}

export interface BrandDecisionEmailInput {
  /** The brand's display name (falls back to "your brand" upstream). */
  brandName: string;
  /** The creator this decision is about, for the subject/greeting context. */
  creatorName: string;
  creatorHandle?: string | null;
  campaignName?: string | null;
  /** The human-readable question we're asking the brand (persisted verbatim on
   *  BrandDecision.question). Composed per-reason by the executor. */
  question: string;
  /** The decision token, embedded in the magic links (and matched on reply). */
  token: string;
  /** Which actions to offer. Over-ceiling (B10) approve/reject-only cases omit
   *  "counter"; max-rounds (B9) cases include it. Defaults to all four. */
  actions?: BrandDecisionLinkAction[];
  /** When the brand can COUNTER, an optional suggested amount pre-filled on the
   *  counter magic link (e.g. the recommended band midpoint). */
  suggestedCounter?: number;
  /** The creator's raw reply, quoted for context on the A1/A2 read-intent and
   *  unreadable-rate cases so the brand can see what the creator actually wrote. */
  quotedReply?: string;
}

const DEFAULT_ACTIONS: BrandDecisionLinkAction[] = ["approve", "reject", "counter", "handoff"];

// The reply cue each action maps to, shown in the "how to reply" block. Kept in
// lockstep with the deterministic token scanner (brandDecisionParse.ts).
const REPLY_CUE: Record<BrandDecisionLinkAction, string> = {
  approve: "APPROVE",
  reject: "REJECT",
  counter: "COUNTER <amount>   (e.g. COUNTER 350)",
  handoff: "HANDOFF",
};

const ACTION_VERB: Record<BrandDecisionLinkAction, string> = {
  approve: "Approve",
  reject: "Reject / pass",
  counter: "Make a counter-offer",
  handoff: "Hand off to a human",
};

/**
 * Render the actionable brand-decision email (subject + body).
 *
 * The body has four parts: the question, the reply cues (free-text channel), the
 * magic-link buttons (one-click channel), and a note that a reply resumes the
 * workflow automatically. Only the requested `actions` are shown — so an
 * approve/reject-only case (B10 over-ceiling) never offers a COUNTER the code
 * would then have to reject.
 */
export function buildBrandDecisionEmail(input: BrandDecisionEmailInput): EmailDraft {
  const actions = input.actions ?? DEFAULT_ACTIONS;
  const creatorLine = input.creatorHandle
    ? `${input.creatorName} (@${input.creatorHandle})`
    : input.creatorName;

  const subject = `Decision needed: ${input.creatorName}${input.campaignName ? ` — ${input.campaignName}` : ""}`;

  const cueLines = actions.map((a) => `  • Reply "${REPLY_CUE[a]}"  →  ${ACTION_VERB[a]}`);
  const linkLines = actions.map(
    (a) =>
      `  • ${ACTION_VERB[a]}:  ${brandDecisionLink(
        input.token,
        a,
        a === "counter" ? input.suggestedCounter : undefined,
      )}`,
  );

  const lines = [
    `Hi ${input.brandName} team,`,
    ``,
    `We need a quick decision on ${creatorLine} before the workflow can continue.`,
    ...(input.campaignName ? [`Campaign: ${input.campaignName}`] : []),
    ``,
    input.question,
    ...(input.quotedReply
      ? ["", `What they wrote:`, ...input.quotedReply.split("\n").map((l) => `  > ${l}`)]
      : []),
    ``,
    `── How to respond ─────────────────────────────────────────`,
    ``,
    `Option 1 — just reply to this email with one of:`,
    ...cueLines,
    ``,
    `Option 2 — click a one-click action link:`,
    ...linkLines,
    ``,
    `Either way, the workflow resumes automatically based on your answer — no`,
    `dashboard needed. If we can't tell what you meant, we'll ask once more; if`,
    `we still can't, it moves to the manual queue.`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: lines.join("\n") };
}

export interface BrandNameRequestEmailInput {
  brandName: string;
  creatorName: string;
  creatorHandle?: string | null;
  campaignName?: string | null;
  /** The question we ask, persisted verbatim on BrandDecision.question. */
  question: string;
  /** The decision token (embedded in the handoff magic link + matched on reply). */
  token: string;
}

/**
 * Render the L4 missing-brand-name request email (§3 Category D). Unlike the
 * business email, the brand replies with a NAME (free text), not a token — so
 * there are no approve/reject cues. We still offer a HANDOFF link/reply for a
 * brand that would rather a human handle it. On a reply with a name, we write it
 * back to the campaign and re-run the blocked node automatically.
 */
export function buildBrandNameRequestEmail(input: BrandNameRequestEmailInput): EmailDraft {
  const creatorLine = input.creatorHandle
    ? `${input.creatorName} (@${input.creatorHandle})`
    : input.creatorName;

  const subject = `Quick question: your brand name${input.campaignName ? ` — ${input.campaignName}` : ""}`;

  const lines = [
    `Hi ${input.brandName} team,`,
    ``,
    `We're about to email ${creatorLine} on your behalf, but we don't have a`,
    `brand name to sign as — so the workflow has paused rather than send`,
    `something addressed from "your brand".`,
    ...(input.campaignName ? [`Campaign: ${input.campaignName}`] : []),
    ``,
    input.question,
    ``,
    `── How to respond ─────────────────────────────────────────`,
    ``,
    `Just reply to this email with the brand name to use (e.g. "Acme Co.").`,
    `We'll save it and continue automatically — no dashboard needed.`,
    ``,
    `If you'd rather a human handle this, reply "HANDOFF" or click:`,
    `  ${brandDecisionLink(input.token, "handoff")}`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: lines.join("\n") };
}
