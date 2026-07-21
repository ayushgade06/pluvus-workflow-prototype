import type { EmailDraft } from "../types.js";

// ---------------------------------------------------------------------------
// Payout Sent — "you've been paid" email to the creator (Phase 3)
// ---------------------------------------------------------------------------
// Sent when the brand marks a payout SENT. Carries the amount, the PayPal
// transaction reference, the two magic links (confirm / dispute), and the expiry
// note. Pure deterministic builder (like paymentEmail.ts) so it is the single
// source of truth for the copy and is unit-testable without a DB.

/** Format integer cents as a localized currency string ($1,234.50).
 *  A malformed currency code (bad import, empty string, lowercase) would make
 *  Intl.NumberFormat throw a RangeError — which, on the email/interstitial path,
 *  would break the whole render. Fall back to a plain `<amount> <CODE>` string
 *  so money always renders. */
export function formatCents(amountCents: number, currency = "USD"): string {
  const dollars = amountCents / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(dollars);
  } catch {
    return `${dollars.toFixed(2)} ${(currency || "USD").toUpperCase()}`;
  }
}

export interface PayoutSentInput {
  creatorName: string;
  brandName: string;
  amountCents: number;
  currency: string;
  /** PayPal transaction reference, if the brand supplied one. */
  reference?: string | null;
  confirmLink: string;
  disputeLink: string;
  /** Token lifetime in days, for the "links valid N days" note. */
  ttlDays: number;
}

export function renderPayoutSentEmail(input: PayoutSentInput): EmailDraft {
  const amount = formatCents(input.amountCents, input.currency);
  const subject = `${input.brandName} sent you ${amount}`;

  const body = [
    `Hi ${input.creatorName},`,
    ``,
    `Great news — ${input.brandName} has just sent you a payout of ${amount} for your collaboration. Thank you for the great work!`,
    ...(input.reference
      ? [``, `Transaction reference: ${input.reference}`]
      : []),
    ``,
    `You don't need to do anything — once it lands in your account we'll mark it settled automatically after ${input.ttlDays} days. But if you'd like to confirm it early, or something doesn't look right, these two links are here for you:`,
    ``,
    `Confirm you received the payment:`,
    input.confirmLink,
    ``,
    `Let us know if it hasn't arrived:`,
    input.disputeLink,
    ``,
    `It was a pleasure working with you — we hope to partner again soon!`,
    ``,
    `Best,`,
    `${input.brandName}`,
  ].join("\n");

  return { subject, body };
}
