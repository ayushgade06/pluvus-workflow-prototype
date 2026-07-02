/**
 * Unit tests for the "rate is finalized" auto-reply copy. Pure — no DB/network.
 * Run: npx tsx src/engine/executors/rateFixedEmail.test.ts
 */

import assert from "node:assert/strict";
import { renderRateFixedEmail } from "./rateFixedEmail.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nRate-fixed auto-reply copy\n");

test("reward stage: states the fee is fixed and asks to confirm", () => {
  const { subject, body } = renderRateFixedEmail("reward", {
    creatorName: "Ayush",
    brandName: "PeakRoast Coffee",
    senderName: "PeakRoast Coffee",
    agreedFee: 350,
  });
  assert.match(subject, /Agreement Confirmation/);
  assert.match(body, /Hi Ayush,/);
  assert.match(body, /\$350/);
  assert.match(body, /fixed and cannot be changed/i);
  assert.match(body, /"I Agree"/);
  assert.match(body, /questions about the campaign/i);
  assert.match(body, /Best,\nPeakRoast Coffee/);
  // Reward-stage copy must NOT reference the payout form.
  assert.doesNotMatch(body, /payout|form/i);
});

test("payment stage: states the fee is fixed and points at the form link", () => {
  const { subject, body } = renderRateFixedEmail("payment", {
    creatorName: "Ayush",
    brandName: "PeakRoast Coffee",
    senderName: "PeakRoast Coffee",
    agreedFee: 350,
    formLink: "http://localhost:3001/payment/tok_abc",
  });
  assert.match(subject, /Payment Information/);
  assert.match(body, /\$350/);
  assert.match(body, /fixed and cannot be changed/i);
  assert.match(body, /payout information/i);
  assert.match(body, /http:\/\/localhost:3001\/payment\/tok_abc/);
});

test("payment stage: mentions shipping address when collected", () => {
  const { body } = renderRateFixedEmail("payment", {
    creatorName: "Ayush",
    brandName: "PeakRoast Coffee",
    senderName: "PeakRoast Coffee",
    agreedFee: 350,
    formLink: "http://x/payment/t",
    collectShippingAddress: true,
  });
  assert.match(body, /shipping address/i);
});

test("falls back to generic fee wording when the fee is unknown", () => {
  const { body } = renderRateFixedEmail("reward", {
    creatorName: "Ayush",
    brandName: "PeakRoast Coffee",
    senderName: "PeakRoast Coffee",
    agreedFee: undefined,
  });
  assert.match(body, /the agreed fee is fixed/i);
  assert.doesNotMatch(body, /\$undefined/);
});

console.log(`\n${n} passed\n`);
