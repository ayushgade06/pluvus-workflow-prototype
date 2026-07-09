/**
 * Unit test for EASY-W3: isPayoutFinalized decides whether the payout page shows
 * the "already submitted" notice. The payout is finalized ONLY when the
 * PaymentInfo row is PAYMENT_RECEIVED AND the instance has advanced past
 * PAYMENT_PENDING — so a row-received-but-instance-stuck state (the brick bug)
 * re-renders the form instead of a dead "already submitted" page, letting a
 * re-submit recover it. Pure — no DB. Run:
 *   npx tsx src/routes/payoutFinalized.test.ts
 */

import assert from "node:assert/strict";
import { isPayoutFinalized } from "./payment.js";
import type { findPaymentInfoByToken } from "../db/index.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Minimal payment-row shape: only status + instance.currentState are read.
type PaymentRow = NonNullable<Awaited<ReturnType<typeof findPaymentInfoByToken>>>;
function payment(status: string, currentState: string): PaymentRow {
  return { status, instance: { currentState } } as unknown as PaymentRow;
}

console.log("\nisPayoutFinalized (EASY-W3)\n");

test("received row + instance advanced (CONTENT_BRIEF_SENT) → finalized", () => {
  assert.equal(isPayoutFinalized(payment("PAYMENT_RECEIVED", "CONTENT_BRIEF_SENT")), true);
});

test("received row + instance advanced (PAYMENT_RECEIVED) → finalized (legacy)", () => {
  assert.equal(isPayoutFinalized(payment("PAYMENT_RECEIVED", "PAYMENT_RECEIVED")), true);
});

test("received row but instance STILL PAYMENT_PENDING → NOT finalized (the brick case)", () => {
  // This is the recovery path: the form re-renders so a re-submit can advance it.
  assert.equal(isPayoutFinalized(payment("PAYMENT_RECEIVED", "PAYMENT_PENDING")), false);
});

test("pending row → NOT finalized (fresh form)", () => {
  assert.equal(isPayoutFinalized(payment("PAYMENT_PENDING", "PAYMENT_PENDING")), false);
});

console.log(`\n${n} passed\n`);
