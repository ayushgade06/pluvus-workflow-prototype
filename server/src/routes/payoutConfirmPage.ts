// ---------------------------------------------------------------------------
// Payout confirm/dispute pages — server-rendered HTML (Phase 3)
// ---------------------------------------------------------------------------
// The creator receives two emailed magic links (confirm / dispute). Per I-5, the
// GET link renders an INTERSTITIAL whose button POSTs — GET never mutates (mail
// scanners prefetch GETs). These are pure string builders (no Express types) so
// the markup is unit-testable and there is one source of truth per page state.
//
// Shares the dark-theme chrome with the payout-information page (paymentPage.ts)
// so the two hosted pages feel like one product.

import { formatCents } from "../engine/executors/payoutSentEmail.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    :root {
      --bg: #0d1117; --panel: #161b22; --panelAlt: #1c2230; --border: #2d333b;
      --text: #e6edf3; --muted: #9198a1; --dim: #6e7681; --accent: #388bfd;
      --accentDim: #1f6feb; --success: #3fb950; --danger: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--text); min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex; align-items: flex-start; justify-content: center; padding: 40px 16px;
    }
    .card {
      width: 100%; max-width: 460px; background: var(--panel);
      border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
    }
    .head { padding: 22px 24px 14px; border-bottom: 1px solid var(--border); }
    .brand { font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--dim); }
    h1 { font-size: 19px; margin: 8px 0 4px; }
    .sub { font-size: 13.5px; color: var(--muted); line-height: 1.5; margin: 0; }
    .body { padding: 20px 24px 24px; display: flex; flex-direction: column; gap: 14px; }
    .amount { font-size: 30px; font-weight: 700; color: var(--text); }
    .kv { font-size: 13px; color: var(--muted); }
    .kv b { color: var(--text); font-weight: 600; }
    form { margin: 0; }
    button {
      width: 100%; color: #fff; border: none; border-radius: 7px;
      padding: 12px 14px; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    button.confirm { background: var(--success); }
    button.confirm:hover { background: #2ea043; }
    button.dispute { background: var(--danger); }
    button.dispute:hover { background: #da3633; }
    .note { padding: 24px; text-align: center; }
    .badge {
      display: inline-block; width: 44px; height: 44px; line-height: 44px; border-radius: 50%;
      font-size: 22px; margin-bottom: 12px;
    }
    .ok { background: rgba(63,185,80,0.15); color: var(--success); }
    .warn { background: rgba(248,81,73,0.15); color: var(--danger); }
    .info { background: rgba(56,139,253,0.15); color: var(--accent); }
    .foot { padding: 12px 24px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--dim); text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    ${inner}
    <div class="foot">Secure payout confirmation · No account or password required.</div>
  </div>
</body>
</html>`;
}

export interface PayoutInterstitialInput {
  payoutId: string;
  token: string;
  creatorName: string;
  brandName: string;
  amountCents: number;
  currency: string;
  reference?: string | null;
  /** "confirm" renders the green confirm button + POSTs to /payout/confirm/:id;
   *  "dispute" renders the red button + POSTs to /payout/dispute/:id. */
  action: "confirm" | "dispute";
}

/** The interstitial (primary GET state): one button that POSTs with the token. */
export function renderPayoutInterstitialPage(input: PayoutInterstitialInput): string {
  const amount = formatCents(input.amountCents, input.currency);
  const isConfirm = input.action === "confirm";
  const heading = isConfirm ? "Confirm your payout" : "Report a missing payout";
  const lead = isConfirm
    ? `Please confirm you received this payment from ${esc(input.brandName)}.`
    : `Let ${esc(input.brandName)} know you did NOT receive this payment.`;
  const buttonClass = isConfirm ? "confirm" : "dispute";
  const buttonText = isConfirm ? "Confirm I received this" : "I did not receive this";
  const actionPath = isConfirm ? "confirm" : "dispute";

  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>${esc(heading)}</h1>
      <p class="sub">Hi ${esc(input.creatorName)}, ${lead}</p>
    </div>
    <div class="body">
      <div class="amount">${esc(amount)}</div>
      ${input.reference ? `<div class="kv">Reference: <b>${esc(input.reference)}</b></div>` : ""}
      <form method="POST" action="/payout/${actionPath}/${esc(input.payoutId)}">
        <input type="hidden" name="token" value="${esc(input.token)}" />
        <button type="submit" class="${buttonClass}">${esc(buttonText)}</button>
      </form>
    </div>`;
  return shell(heading, inner);
}

/** Thank-you page after a successful confirm (POST). */
export function renderPayoutConfirmedPage(input: {
  creatorName: string;
  brandName: string;
  amountCents: number;
  currency: string;
}): string {
  const amount = formatCents(input.amountCents, input.currency);
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Payment confirmed</h1>
    </div>
    <div class="note">
      <div class="badge ok">✓</div>
      <p class="sub">Thank you, ${esc(input.creatorName)}. We've recorded that you received your ${esc(amount)} payout.<br/>
      Nothing more to do here.</p>
    </div>`;
  return shell("Payment Confirmed", inner);
}

/** Page after a successful dispute (POST). */
export function renderPayoutDisputedPage(input: {
  creatorName: string;
  brandName: string;
}): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>We've flagged this</h1>
    </div>
    <div class="note">
      <div class="badge warn">!</div>
      <p class="sub">Thanks, ${esc(input.creatorName)}. We've let ${esc(input.brandName)} know you did not receive this payment.<br/>
      They'll follow up with you directly to resolve it.</p>
    </div>`;
  return shell("Payment Disputed", inner);
}

/** Idempotent notice when the payout was already actioned (mail-prefetch safe). */
export function renderPayoutAlreadyActionedPage(input: {
  brandName: string;
  status: string;
}): string {
  const label =
    input.status === "SETTLED"
      ? "already settled"
      : input.status === "DISPUTED"
        ? "already reported as not received"
        : input.status === "CONFIRMED"
          ? "already confirmed"
          : `already ${input.status.toLowerCase()}`;
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Nothing to do</h1>
    </div>
    <div class="note">
      <div class="badge info">✓</div>
      <p class="sub">This payout has been ${esc(label)}. There's nothing more to do here.</p>
    </div>`;
  return shell("Already Handled", inner);
}

/** Friendly expired-link page. */
export function renderPayoutExpiredPage(input: { brandName: string | null }): string {
  const brand = input.brandName ? esc(input.brandName) : "your brand contact";
  const inner = `
    <div class="head">
      <h1>Link expired</h1>
    </div>
    <div class="note">
      <div class="badge warn">!</div>
      <p class="sub">This confirmation link has expired.<br/>
      Please reach out to ${brand} to sort out your payout.</p>
    </div>`;
  return shell("Link Expired", inner);
}

/** Invalid / not-found link (unknown payout or token mismatch — no detail). */
export function renderPayoutInvalidPage(): string {
  const inner = `
    <div class="head">
      <h1>Link not found</h1>
    </div>
    <div class="note">
      <div class="badge warn">!</div>
      <p class="sub">This payout link is invalid or has expired.<br/>
      Please check the link in your email, or reach out to your brand contact.</p>
    </div>`;
  return shell("Link Not Found", inner);
}
