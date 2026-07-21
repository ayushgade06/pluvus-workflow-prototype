/**
 * Unit tests for the Payment Info "Payment Information Required" email renderer
 * and the payout-form link builder. Pure — no DB, no network. Run:
 *   npx tsx src/engine/executors/paymentEmail.test.ts
 */

import assert from "node:assert/strict";
import {
  renderPaymentRequestEmail,
  paymentFormLink,
  paymentBaseUrl,
} from "./paymentEmail.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\npaymentEmail\n");

// ── Email copy ─────────────────────────────────────────────────────────────
test("subject is exactly 'Payment Information Required'", () => {
  const draft = renderPaymentRequestEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    senderName: "Pluvus Partnerships",
    formLink: "http://localhost:3001/payment/tok123",
  });
  assert.equal(draft.subject, "Payment Information Required");
});

test("body greets the creator and thanks them for confirming with the brand", () => {
  const { body } = renderPaymentRequestEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    senderName: "Pluvus Partnerships",
    formLink: "http://localhost:3001/payment/tok123",
  });
  assert.match(body, /^Hi Ada,/);
  assert.match(body, /working together on the Pluvus campaign!/);
});

test("body includes the payout form link verbatim", () => {
  const link = "http://localhost:3001/payment/tok-abc-123";
  const { body } = renderPaymentRequestEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    senderName: "Pluvus",
    formLink: link,
  });
  assert.ok(body.includes(link), "link should appear in the email body");
});

test("body promises the content brief after submission and signs off as the sender", () => {
  const { body } = renderPaymentRequestEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    senderName: "Jordan from Pluvus",
    formLink: "http://localhost:3001/payment/tok123",
  });
  assert.match(body, /Once submitted, we'll send you the detailed campaign content brief\./);
  assert.match(body, /Jordan from Pluvus$/);
});

test("does not ask for payment method inline (that's on the form, not the email)", () => {
  const { body } = renderPaymentRequestEmail({
    creatorName: "Ada",
    brandName: "Pluvus",
    senderName: "Pluvus",
    formLink: "http://localhost:3001/payment/tok123",
  });
  // The email points to the secure form; it must not itself enumerate methods.
  assert.doesNotMatch(body, /PayPal|Wise|Bank Transfer/i);
});

// ── Link builder ───────────────────────────────────────────────────────────
test("paymentFormLink embeds the token under /payment/", () => {
  const link = paymentFormLink("abc-123");
  assert.match(link, /\/payment\/abc-123$/);
});

test("paymentBaseUrl honors PAYMENT_BASE_URL and strips trailing slashes", () => {
  const prev = process.env["PAYMENT_BASE_URL"];
  process.env["PAYMENT_BASE_URL"] = "https://pay.example.com/";
  assert.equal(paymentBaseUrl(), "https://pay.example.com");
  assert.equal(paymentFormLink("t"), "https://pay.example.com/payment/t");
  if (prev === undefined) delete process.env["PAYMENT_BASE_URL"];
  else process.env["PAYMENT_BASE_URL"] = prev;
});

test("paymentBaseUrl defaults to localhost:PORT when unset", () => {
  const prevBase = process.env["PAYMENT_BASE_URL"];
  const prevPort = process.env["PORT"];
  delete process.env["PAYMENT_BASE_URL"];
  process.env["PORT"] = "3001";
  assert.equal(paymentBaseUrl(), "http://localhost:3001");
  if (prevBase !== undefined) process.env["PAYMENT_BASE_URL"] = prevBase;
  if (prevPort === undefined) delete process.env["PORT"];
  else process.env["PORT"] = prevPort;
});

console.log(`\n${n} passed\n`);
