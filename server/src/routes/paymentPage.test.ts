/**
 * Unit tests for the hosted payment page HTML renderers. Pure — no Express, no
 * DB. Verifies the form fields/options, HTML-escaping, the POST action target,
 * and the notice pages. Run:
 *   npx tsx src/routes/paymentPage.test.ts
 */

import assert from "node:assert/strict";
import {
  renderPaymentFormPage,
  renderPaymentThankYouPage,
  renderPaymentAlreadySubmittedPage,
  renderPaymentInvalidPage,
  PAYOUT_METHODS,
} from "./paymentPage.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\npaymentPage\n");

// ── Form page ──────────────────────────────────────────────────────────────
test("form posts back to /payment/:token", () => {
  const html = renderPaymentFormPage({
    token: "tok-123",
    creatorName: "Ada",
    brandName: "Pluvus",
  });
  assert.match(html, /<form method="POST" action="\/payment\/tok-123">/);
});

test("form offers exactly the three payout methods", () => {
  const html = renderPaymentFormPage({ token: "t", creatorName: "Ada", brandName: "Pluvus" });
  for (const m of PAYOUT_METHODS) {
    assert.ok(html.includes(`value="${m.value}"`), `missing option ${m.value}`);
    assert.ok(html.includes(m.label), `missing label ${m.label}`);
  }
  // PayPal, Wise, Bank Transfer — and nothing else.
  assert.equal(PAYOUT_METHODS.length, 3);
});

test("form includes the required account identifier field and optional country/notes", () => {
  const html = renderPaymentFormPage({ token: "t", creatorName: "Ada", brandName: "Pluvus" });
  assert.match(html, /name="accountIdentifier"[^>]*required/);
  assert.match(html, /name="country"/);
  assert.match(html, /name="notes"/);
});

test("greets the creator by name and shows the brand", () => {
  const html = renderPaymentFormPage({ token: "t", creatorName: "Ada Lovelace", brandName: "Acme Co" });
  assert.ok(html.includes("Ada Lovelace"));
  assert.ok(html.includes("Acme Co"));
});

test("HTML-escapes creator/brand names to prevent markup injection", () => {
  const html = renderPaymentFormPage({
    token: "t",
    creatorName: "<script>alert(1)</script>",
    brandName: "A&B",
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("A&amp;B"));
});

test("shows a validation error when provided and re-populates prior values", () => {
  const html = renderPaymentFormPage({
    token: "t",
    creatorName: "Ada",
    brandName: "Pluvus",
    error: "Please enter your account identifier or email.",
    values: { method: "WISE", accountIdentifier: "ada@x.io", country: "UK", notes: "hi" },
  });
  assert.ok(html.includes("Please enter your account identifier or email."));
  assert.match(html, /<option value="WISE" selected>/);
  assert.ok(html.includes('value="ada@x.io"'));
  assert.ok(html.includes('value="UK"'));
});

// ── Shipping-address section (physical product) ──────────────────────────────
test("no shipping-address fields by default (payout-only form)", () => {
  const html = renderPaymentFormPage({ token: "t", creatorName: "Ada", brandName: "Pluvus" });
  assert.doesNotMatch(html, /name="shipLine1"/);
  assert.doesNotMatch(html, /Shipping address/i);
});

test("renders the shipping-address section when showShippingAddress is true", () => {
  const html = renderPaymentFormPage({
    token: "t",
    creatorName: "Ada",
    brandName: "Pluvus",
    showShippingAddress: true,
  });
  assert.match(html, /Shipping address/i);
  // Required address fields.
  for (const name of ["shipName", "shipLine1", "shipCity", "shipPostalCode", "shipCountry"]) {
    assert.match(html, new RegExp(`name="${name}"[^>]*required`), `missing required ${name}`);
  }
  // Optional address fields present but not required.
  assert.match(html, /name="shipLine2"/);
  assert.match(html, /name="shipRegion"/);
});

test("re-populates shipping values after a validation error", () => {
  const html = renderPaymentFormPage({
    token: "t",
    creatorName: "Ada",
    brandName: "Pluvus",
    showShippingAddress: true,
    error: "Please complete your shipping address.",
    values: {
      method: "PAYPAL",
      accountIdentifier: "ada@x.io",
      shipName: "Ada Lovelace",
      shipLine1: "12 Analytical Ave",
      shipCity: "London",
      shipPostalCode: "EC1A",
      shipCountry: "UK",
    },
  });
  assert.ok(html.includes('value="Ada Lovelace"'));
  assert.ok(html.includes('value="12 Analytical Ave"'));
  assert.ok(html.includes('value="EC1A"'));
});

// ── Notice pages ───────────────────────────────────────────────────────────
test("thank-you page confirms receipt and mentions the content brief", () => {
  const html = renderPaymentThankYouPage({ creatorName: "Ada", brandName: "Pluvus" });
  assert.match(html, /Thank you/i);
  assert.match(html, /received/i);
  assert.match(html, /content brief/i);
});

test("already-submitted page is idempotent-friendly (no form)", () => {
  const html = renderPaymentAlreadySubmittedPage({ creatorName: "Ada", brandName: "Pluvus" });
  assert.match(html, /Already submitted/i);
  assert.doesNotMatch(html, /<form/);
});

test("invalid page explains a bad/expired link", () => {
  const html = renderPaymentInvalidPage();
  assert.match(html, /not found|invalid|expired/i);
  assert.doesNotMatch(html, /<form/);
});

console.log(`\n${n} passed\n`);
