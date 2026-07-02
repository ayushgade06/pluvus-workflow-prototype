// ---------------------------------------------------------------------------
// Hosted payment page — server-rendered HTML
// ---------------------------------------------------------------------------
// A lightweight, self-contained payout-information form served by the Express
// API (no SPA / React Router dependency). The token in the URL is the only
// credential; no authentication, no payment integration, no verification — this
// is purely a placeholder for collecting payout details in the prototype.
//
// Kept as pure string builders (no Express types) so the markup is unit-testable
// and there is a single source of truth for the three page states: the form, the
// "already submitted" notice, and the "thank you" confirmation.

/** The payout methods the form offers, matching the PayoutMethod enum. */
export const PAYOUT_METHODS: Array<{ value: string; label: string }> = [
  { value: "PAYPAL", label: "PayPal" },
  { value: "WISE", label: "Wise" },
  { value: "BANK_TRANSFER", label: "Bank Transfer" },
];

// Minimal HTML-escaping for interpolated dynamic text (creator/brand names).
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared page chrome. Dark palette echoing the app's theme tokens so the hosted
// page feels part of the product without importing the React design system.
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
    form { padding: 20px 24px 24px; display: flex; flex-direction: column; gap: 16px; }
    label { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 6px; color: var(--text); }
    .opt { font-weight: 400; color: var(--dim); }
    input, select, textarea {
      width: 100%; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px;
      font-size: 14px; font-family: inherit;
    }
    input:focus, select:focus, textarea:focus {
      outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(56,139,253,0.2);
    }
    textarea { resize: vertical; min-height: 68px; }
    button {
      background: var(--accent); color: #fff; border: none; border-radius: 7px;
      padding: 11px 14px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 4px;
    }
    button:hover { background: var(--accentDim); }
    .err {
      background: rgba(248,81,73,0.12); border: 1px solid rgba(248,81,73,0.4);
      color: var(--danger); border-radius: 7px; padding: 10px 12px; font-size: 13px;
    }
    .note { padding: 24px; text-align: center; }
    .badge {
      display: inline-block; width: 44px; height: 44px; line-height: 44px; border-radius: 50%;
      font-size: 22px; margin-bottom: 12px;
    }
    .ok { background: rgba(63,185,80,0.15); color: var(--success); }
    .info { background: rgba(56,139,253,0.15); color: var(--accent); }
    .foot { padding: 12px 24px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--dim); text-align: center; }
    .section-head {
      margin-top: 6px; padding-top: 16px; border-top: 1px solid var(--border);
      font-size: 12px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--muted); font-weight: 600;
    }
    .section-sub { margin: -4px 0 0; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    ${inner}
    <div class="foot">Secure payout information · No account or password required.</div>
  </div>
</body>
</html>`;
}

export interface PaymentFormPageInput {
  token: string;
  creatorName: string;
  brandName: string;
  /** When true, render the shipping-address section (campaign ships a physical
   *  product). Off by default → the form is payout-only, exactly as before. */
  showShippingAddress?: boolean | undefined;
  /** A validation error to surface above the form (e.g. after a bad POST). */
  error?: string | undefined;
  /** Previously-entered values to re-populate the form after a validation error. */
  values?: {
    method?: string;
    accountIdentifier?: string;
    country?: string;
    notes?: string;
    // Shipping address (only meaningful when showShippingAddress is true).
    shipName?: string;
    shipLine1?: string;
    shipLine2?: string;
    shipCity?: string;
    shipRegion?: string;
    shipPostalCode?: string;
    shipCountry?: string;
  };
}

/** The payout-information form page (the primary state). */
export function renderPaymentFormPage(input: PaymentFormPageInput): string {
  const v = input.values ?? {};
  const options = PAYOUT_METHODS.map(
    (m) =>
      `<option value="${m.value}"${v.method === m.value ? " selected" : ""}>${esc(m.label)}</option>`,
  ).join("");
  const errBlock = input.error ? `<div class="err">${esc(input.error)}</div>` : "";

  // Shipping-address section — rendered only when the campaign ships a physical
  // product. The field `name`s must match the POST parser in payment.ts.
  const shippingBlock = input.showShippingAddress
    ? `
      <div class="section-head">Shipping address</div>
      <p class="section-sub">You're receiving a product for this collaboration — tell us where to ship it.</p>
      <div>
        <label for="shipName">Recipient full name</label>
        <input id="shipName" name="shipName" type="text" value="${esc(v.shipName ?? "")}" placeholder="e.g. Alex Rivera" required />
      </div>
      <div>
        <label for="shipLine1">Address line 1</label>
        <input id="shipLine1" name="shipLine1" type="text" value="${esc(v.shipLine1 ?? "")}" placeholder="Street address" required />
      </div>
      <div>
        <label for="shipLine2">Address line 2 <span class="opt">(optional)</span></label>
        <input id="shipLine2" name="shipLine2" type="text" value="${esc(v.shipLine2 ?? "")}" placeholder="Apartment, suite, unit, etc." />
      </div>
      <div>
        <label for="shipCity">City</label>
        <input id="shipCity" name="shipCity" type="text" value="${esc(v.shipCity ?? "")}" placeholder="e.g. Austin" required />
      </div>
      <div>
        <label for="shipRegion">State / Province <span class="opt">(optional)</span></label>
        <input id="shipRegion" name="shipRegion" type="text" value="${esc(v.shipRegion ?? "")}" placeholder="e.g. Texas" />
      </div>
      <div>
        <label for="shipPostalCode">Postal code</label>
        <input id="shipPostalCode" name="shipPostalCode" type="text" value="${esc(v.shipPostalCode ?? "")}" placeholder="e.g. 78701" required />
      </div>
      <div>
        <label for="shipCountry">Country</label>
        <input id="shipCountry" name="shipCountry" type="text" value="${esc(v.shipCountry ?? "")}" placeholder="e.g. United States" required />
      </div>`
    : "";

  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Payout Information</h1>
      <p class="sub">Hi ${esc(input.creatorName)}, please share where we should send your payment for this collaboration.</p>
    </div>
    <form method="POST" action="/payment/${esc(input.token)}">
      ${errBlock}
      <div>
        <label for="method">Preferred payout method</label>
        <select id="method" name="method" required>${options}</select>
      </div>
      <div>
        <label for="accountIdentifier">Account identifier / email</label>
        <input id="accountIdentifier" name="accountIdentifier" type="text"
          value="${esc(v.accountIdentifier ?? "")}"
          placeholder="e.g. you@example.com or IBAN" required />
      </div>
      <div>
        <label for="country">Country <span class="opt">(optional)</span></label>
        <input id="country" name="country" type="text" value="${esc(v.country ?? "")}" placeholder="e.g. United States" />
      </div>
      ${shippingBlock}
      <div>
        <label for="notes">Additional notes <span class="opt">(optional)</span></label>
        <textarea id="notes" name="notes" placeholder="Anything else we should know?">${esc(v.notes ?? "")}</textarea>
      </div>
      <button type="submit">Submit payout information</button>
    </form>`;
  return shell("Payment Information", inner);
}

/** The confirmation page shown after a successful submission. */
export function renderPaymentThankYouPage(input: {
  creatorName: string;
  brandName: string;
}): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Thank you!</h1>
    </div>
    <div class="note">
      <div class="badge ok">✓</div>
      <p class="sub">Your payout information has been received, ${esc(input.creatorName)}.<br/>
      We'll be in touch shortly with your detailed campaign content brief.</p>
    </div>`;
  return shell("Payout Information Received", inner);
}

/** Shown when the form was already submitted (idempotent revisit of the link). */
export function renderPaymentAlreadySubmittedPage(input: {
  creatorName: string;
  brandName: string;
}): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Already submitted</h1>
    </div>
    <div class="note">
      <div class="badge info">✓</div>
      <p class="sub">We already have your payout information, ${esc(input.creatorName)}.<br/>
      There's nothing more to do here — the campaign brief is on its way.</p>
    </div>`;
  return shell("Payout Information Received", inner);
}

/** Shown for an unknown/expired token. */
export function renderPaymentInvalidPage(): string {
  const inner = `
    <div class="head">
      <h1>Link not found</h1>
    </div>
    <div class="note">
      <div class="badge" style="background: rgba(248,81,73,0.15); color: var(--danger);">!</div>
      <p class="sub">This payout link is invalid or has expired.<br/>
      Please check the link in your email, or reach out to your brand contact.</p>
    </div>`;
  return shell("Link Not Found", inner);
}
