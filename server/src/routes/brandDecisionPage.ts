// ---------------------------------------------------------------------------
// Hosted brand-decision confirmation pages — server-rendered HTML
// ---------------------------------------------------------------------------
// The pages shown when a brand clicks a one-click magic-link action on an
// escalation email (GET /brand-decision/:token/{approve,reject,counter,handoff}).
// Mirrors paymentPage.ts: pure string builders (no Express types), a shared
// dark-theme shell, and one page per outcome. The token in the URL is the only
// credential (prototype scope) — no auth.

// Minimal HTML-escaping for interpolated dynamic text.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared page chrome — the same palette as the payout page so the hosted
// surfaces feel like one product.
function shell(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    :root {
      --bg: #0d1117; --panel: #161b22; --border: #2d333b;
      --text: #e6edf3; --muted: #9198a1; --dim: #6e7681; --accent: #388bfd;
      --success: #3fb950; --danger: #f85149; --warn: #d29922;
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
    .note { padding: 24px; text-align: center; }
    .badge {
      display: inline-block; width: 44px; height: 44px; line-height: 44px; border-radius: 50%;
      font-size: 22px; margin-bottom: 12px;
    }
    .ok { background: rgba(63,185,80,0.15); color: var(--success); }
    .info { background: rgba(56,139,253,0.15); color: var(--accent); }
    .danger { background: rgba(248,81,73,0.15); color: var(--danger); }
    .warn { background: rgba(210,153,34,0.15); color: var(--warn); }
    .foot { padding: 12px 24px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--dim); text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    ${inner}
    <div class="foot">Pluvus Workflow Automation · No account or password required.</div>
  </div>
</body>
</html>`;
}

export interface BrandDecisionResultPageInput {
  brandName: string;
  creatorName: string;
}

/** The confirmation shown after a successful one-click resolution. Copy varies
 *  per action so the brand knows exactly what will happen next. */
export function renderBrandDecisionResultPage(
  action: "approve" | "reject" | "counter" | "handoff",
  input: BrandDecisionResultPageInput & { amount?: number },
): string {
  const brand = esc(input.brandName);
  const creator = esc(input.creatorName);

  const variants: Record<
    typeof action,
    { title: string; badgeClass: string; icon: string; body: string }
  > = {
    approve: {
      title: "Approved",
      badgeClass: "ok",
      icon: "✓",
      body: `You approved the deal with ${creator}. We'll finalize the agreement and take it from here — no further action needed.`,
    },
    reject: {
      title: "Passed",
      badgeClass: "danger",
      icon: "✕",
      body: `You passed on ${creator}. We'll close out this conversation. Nothing more to do here.`,
    },
    counter: {
      title: "Counter recorded",
      badgeClass: "info",
      icon: "→",
      body:
        input.amount !== undefined
          ? `Your final counter of ${esc(String(input.amount))} for ${creator} has been recorded. This is a take-it-or-leave-it offer — we won't negotiate further.`
          : `Your final counter for ${creator} has been recorded. This is a take-it-or-leave-it offer — we won't negotiate further.`,
    },
    handoff: {
      title: "Handed to a human",
      badgeClass: "warn",
      icon: "⤳",
      body: `We've routed ${creator} to your manual review queue. A human on your team can now take over in the dashboard.`,
    },
  };

  const v = variants[action];
  const inner = `
    <div class="head">
      <div class="brand">${brand}</div>
      <h1>${esc(v.title)}</h1>
    </div>
    <div class="note">
      <div class="badge ${v.badgeClass}">${v.icon}</div>
      <p class="sub">${v.body}</p>
    </div>`;
  return shell(`Decision · ${v.title}`, inner);
}

/** Shown when the decision was already resolved (link clicked twice / prefetched
 *  / already answered by an email reply). Idempotent, not an error. */
export function renderBrandDecisionAlreadyDonePage(
  input: BrandDecisionResultPageInput,
): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Already decided</h1>
    </div>
    <div class="note">
      <div class="badge info">✓</div>
      <p class="sub">This decision for ${esc(input.creatorName)} has already been resolved.<br/>
      There's nothing more to do here.</p>
    </div>`;
  return shell("Decision · Already decided", inner);
}

/** Shown for an unknown/expired token. */
export function renderBrandDecisionInvalidPage(): string {
  const inner = `
    <div class="head">
      <h1>Link not found</h1>
    </div>
    <div class="note">
      <div class="badge danger">!</div>
      <p class="sub">This decision link is invalid or has expired.<br/>
      Please check the link in your email, or open the Pluvus dashboard.</p>
    </div>`;
  return shell("Link Not Found", inner);
}

/** Shown when a counter link arrives without a usable amount. */
export function renderBrandDecisionNeedsAmountPage(
  input: BrandDecisionResultPageInput,
): string {
  const inner = `
    <div class="head">
      <div class="brand">${esc(input.brandName)}</div>
      <h1>Counter needs an amount</h1>
    </div>
    <div class="note">
      <div class="badge warn">?</div>
      <p class="sub">To make a final counter-offer for ${esc(input.creatorName)}, reply to the
      email with <strong>COUNTER &lt;amount&gt;</strong> (e.g. COUNTER 350),<br/>
      or use one of the other one-click actions.</p>
    </div>`;
  return shell("Decision · Counter needs an amount", inner);
}
