import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Payment Info — "Payment Information Required" email copy
// ---------------------------------------------------------------------------
// Deterministic template (like rewardEmail.ts): asks the creator to complete the
// hosted payout form at a tokenized link. Kept as a pure builder so it is the
// single source of truth for the email body and is unit-testable without a DB.

export interface PaymentRequestInput {
  creatorName: string;
  brandName: string;
  senderName: string;
  /** The absolute link to the hosted payout form, including the token. */
  formLink: string;
}

/**
 * Resolve the public base URL the hosted payout form is served from.
 *
 * The form is served by the Express API (default port 3001). PAYMENT_BASE_URL
 * lets a deployment override the origin (e.g. a tunnel or real domain) without
 * touching code; it falls back to the local API origin so the prototype works
 * out of the box on localhost.
 */
export function paymentBaseUrl(): string {
  const configured = process.env["PAYMENT_BASE_URL"];
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, "");
  const port = process.env["PORT"] ? Number(process.env["PORT"]) : 3001;
  return `http://localhost:${port}`;
}

/** Build the tokenized hosted-form link for a payout token. */
export function paymentFormLink(token: string): string {
  return `${paymentBaseUrl()}/payment/${token}`;
}

/** Render the "Payment Information Required" email body + subject. */
export function renderPaymentRequestEmail(input: PaymentRequestInput): EmailDraft {
  const body = [
    `Hi ${input.creatorName},`,
    ``,
    `Thank you for confirming your collaboration with ${input.brandName}.`,
    ``,
    `Before we begin the campaign, we need your payout information.`,
    ``,
    `Please complete the secure payout information form below.`,
    ``,
    input.formLink,
    ``,
    `Once submitted, we'll send you the detailed campaign content brief.`,
    ``,
    `We're excited to work together!`,
    ``,
    `Best,`,
    `${input.senderName}`,
  ].join("\n");

  return { subject: `Payment Information Required`, body };
}
