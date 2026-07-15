/**
 * Unit tests for the payout email templates + the brand-recipient precedence
 * chain + the auto-settle cutoff. Pure: no DB, no Express, no network.
 *
 * Run: cd server && npm test   (or npx tsx src/engine/executors/payoutEmails.test.ts)
 */

import assert from "node:assert/strict";
import { formatCents, renderPayoutSentEmail } from "./payoutSentEmail.js";
import { renderPayoutDisputedEmail } from "./payoutDisputedEmail.js";
import { resolveBrandRecipient } from "../../notifications/escalation.js";
import { autoSettleCutoff } from "../../scheduler/payoutSweep.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\npayoutEmails\n");

// ── cents rendering ──────────────────────────────────────────────────────────

test("formatCents renders integer cents as USD currency", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(100), "$1.00");
  assert.equal(formatCents(123456), "$1,234.56");
});

test("formatCents honors a non-USD currency code", () => {
  // Intl formats EUR with the € symbol in en-US.
  assert.ok(formatCents(100, "EUR").includes("€"));
});

test("formatCents falls back gracefully on an invalid currency (never throws)", () => {
  // A malformed currency code would make Intl.NumberFormat throw a RangeError,
  // which on the email/interstitial path would break the whole render.
  assert.doesNotThrow(() => formatCents(4200, "not-a-code"));
  const out = formatCents(4200, "not-a-code");
  assert.ok(out.includes("42.00"), "amount still renders");
  assert.doesNotThrow(() => formatCents(4200, ""));
  assert.ok(formatCents(4200, "").includes("42.00"), "empty currency falls back too");
});

// ── payout-sent email (to creator) ────────────────────────────────────────────

test("sent email subject states brand + amount from cents", () => {
  const draft = renderPayoutSentEmail({
    creatorName: "Casey",
    brandName: "Acme",
    amountCents: 4200,
    currency: "USD",
    reference: "TXN-9",
    confirmLink: "https://x/confirm",
    disputeLink: "https://x/dispute",
    ttlDays: 7,
  });
  assert.equal(draft.subject, "Acme sent you $42.00");
});

test("sent email body carries amount, reference, BOTH links, and the expiry note", () => {
  const draft = renderPayoutSentEmail({
    creatorName: "Casey",
    brandName: "Acme",
    amountCents: 4200,
    currency: "USD",
    reference: "TXN-9",
    confirmLink: "https://x/confirm/abc",
    disputeLink: "https://x/dispute/abc",
    ttlDays: 7,
  });
  assert.ok(draft.body.includes("$42.00"), "amount");
  assert.ok(draft.body.includes("TXN-9"), "reference");
  assert.ok(draft.body.includes("https://x/confirm/abc"), "confirm link");
  assert.ok(draft.body.includes("https://x/dispute/abc"), "dispute link");
  assert.ok(draft.body.includes("7 days"), "expiry note");
  assert.ok(/settled automatically/i.test(draft.body), "no-action-needed note");
});

test("sent email omits the reference line when none supplied", () => {
  const draft = renderPayoutSentEmail({
    creatorName: "Casey",
    brandName: "Acme",
    amountCents: 500,
    currency: "USD",
    reference: null,
    confirmLink: "https://x/confirm",
    disputeLink: "https://x/dispute",
    ttlDays: 7,
  });
  assert.ok(!/Transaction reference/i.test(draft.body));
});

// ── payout-disputed email (to brand) ──────────────────────────────────────────

test("disputed email subject is [DISPUTE] + creator + amount from cents", () => {
  const draft = renderPayoutDisputedEmail({
    creatorName: "Casey",
    brandName: "Acme",
    amountCents: 4200,
    currency: "USD",
    reference: "TXN-9",
    payoutId: "payout_1",
  });
  assert.equal(draft.subject, "[DISPUTE] Casey did not receive $42.00");
  assert.ok(draft.body.includes("$42.00"));
  assert.ok(draft.body.includes("payout_1"));
  assert.ok(draft.body.includes("TXN-9"));
});

// ── brand recipient precedence (Phase-11 chain, reused verbatim) ──────────────

test("recipient precedence: campaign.notifyEmail wins", () => {
  const prev = process.env["BRAND_NOTIFY_EMAIL"];
  process.env["BRAND_NOTIFY_EMAIL"] = "workspace@brand.com";
  assert.equal(resolveBrandRecipient("perCampaign@brand.com"), "perCampaign@brand.com");
  if (prev === undefined) delete process.env["BRAND_NOTIFY_EMAIL"];
  else process.env["BRAND_NOTIFY_EMAIL"] = prev;
});

test("recipient precedence: falls to BRAND_NOTIFY_EMAIL when no campaign email", () => {
  const prev = process.env["BRAND_NOTIFY_EMAIL"];
  process.env["BRAND_NOTIFY_EMAIL"] = "workspace@brand.com";
  assert.equal(resolveBrandRecipient(null), "workspace@brand.com");
  assert.equal(resolveBrandRecipient("   "), "workspace@brand.com");
  if (prev === undefined) delete process.env["BRAND_NOTIFY_EMAIL"];
  else process.env["BRAND_NOTIFY_EMAIL"] = prev;
});

test("recipient precedence: falls to the operator default when both unset", () => {
  const prev = process.env["BRAND_NOTIFY_EMAIL"];
  delete process.env["BRAND_NOTIFY_EMAIL"];
  assert.equal(resolveBrandRecipient(null), "affiliatepartner@pluvus.com");
  if (prev === undefined) delete process.env["BRAND_NOTIFY_EMAIL"];
  else process.env["BRAND_NOTIFY_EMAIL"] = prev;
});

// ── auto-settle cutoff ────────────────────────────────────────────────────────

test("autoSettleCutoff is N days before `now` (default 7)", () => {
  const prev = process.env["PAYOUT_AUTO_SETTLE_DAYS"];
  delete process.env["PAYOUT_AUTO_SETTLE_DAYS"];
  const now = new Date("2026-07-15T00:00:00.000Z");
  assert.equal(autoSettleCutoff(now).toISOString(), "2026-07-08T00:00:00.000Z");
  process.env["PAYOUT_AUTO_SETTLE_DAYS"] = "3";
  assert.equal(autoSettleCutoff(now).toISOString(), "2026-07-12T00:00:00.000Z");
  if (prev === undefined) delete process.env["PAYOUT_AUTO_SETTLE_DAYS"];
  else process.env["PAYOUT_AUTO_SETTLE_DAYS"] = prev;
});

console.log(`\n${n} passed\n`);
