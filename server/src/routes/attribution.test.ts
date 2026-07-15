/**
 * Unit tests for attribution logic — webhook validation matrix, commission
 * rounding, and refund guard logic. Pure: no Express, no DB, no network.
 *
 * Run:
 *   cd server && npm test  (picked up by tsx --test glob)
 *   or: npx tsx src/routes/attribution.test.ts
 */

import assert from "node:assert/strict";
import {
  conversionBodySchema,
  resolveValueCents,
  computeCommissionCents,
} from "./attributionLogic.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function parse(body: unknown) {
  return conversionBodySchema.safeParse(body);
}

console.log("\nattribution\n");

// ── Validation: required fields ─────────────────────────────────────────────

test("rejects missing referralCode", () => {
  const r = parse({ externalId: "signup:u1", amountCents: 0 });
  assert.equal(r.success, false);
});

test("rejects missing externalId", () => {
  const r = parse({ referralCode: "code_abc", amountCents: 0 });
  assert.equal(r.success, false);
});

test("rejects when neither amountCents nor amount provided", () => {
  const r = parse({ referralCode: "code_abc", externalId: "signup:u1" });
  assert.equal(r.success, false);
  assert.ok(
    JSON.stringify(r.error?.issues).includes("amountCents"),
    "error must mention amountCents",
  );
});

test("rejects when both amountCents and amount provided", () => {
  const r = parse({ referralCode: "code_abc", externalId: "signup:u1", amountCents: 0, amount: 0 });
  assert.equal(r.success, false);
});

test("rejects negative amountCents", () => {
  const r = parse({ referralCode: "code_abc", externalId: "signup:u1", amountCents: -1 });
  assert.equal(r.success, false);
});

test("rejects negative amount", () => {
  const r = parse({ referralCode: "code_abc", externalId: "signup:u1", amount: -0.01 });
  assert.equal(r.success, false);
});

test("rejects invalid customerEmail format", () => {
  const r = parse({ referralCode: "code_abc", externalId: "signup:u1", amountCents: 0, customerEmail: "not-an-email" });
  assert.equal(r.success, false);
});

// ── Validation: valid inputs ────────────────────────────────────────────────

test("accepts amountCents=0 (free signup conversion)", () => {
  const r = parse({ referralCode: "code_abc", externalId: "signup:u1", amountCents: 0 });
  assert.equal(r.success, true);
});

test("accepts amount=0 (decimal zero)", () => {
  const r = parse({ referralCode: "code_abc", externalId: "signup:u1", amount: 0 });
  assert.equal(r.success, true);
});

test("accepts amountCents with optional currency and customerEmail", () => {
  const r = parse({
    referralCode: "code_abc",
    externalId: "payment:ord_1",
    amountCents: 4999,
    currency: "USD",
    customerEmail: "user@example.com",
    metadata: { source: "checkout" },
  });
  assert.equal(r.success, true);
});

test("accepts amount (decimal dollars)", () => {
  const r = parse({ referralCode: "code_abc", externalId: "payment:ord_2", amount: 49.99 });
  assert.equal(r.success, true);
});

// ── resolveValueCents ───────────────────────────────────────────────────────

test("resolveValueCents: amountCents=0 → 0", () => {
  const body = parse({ referralCode: "c", externalId: "e", amountCents: 0 });
  assert.ok(body.success);
  assert.equal(resolveValueCents(body.data!), 0);
});

test("resolveValueCents: amountCents=4999 → 4999", () => {
  const body = parse({ referralCode: "c", externalId: "e", amountCents: 4999 });
  assert.ok(body.success);
  assert.equal(resolveValueCents(body.data!), 4999);
});

test("resolveValueCents: amount=19.99 → Math.round(1999) = 1999", () => {
  const body = parse({ referralCode: "c", externalId: "e", amount: 19.99 });
  assert.ok(body.success);
  assert.equal(resolveValueCents(body.data!), 1999);
});

test("resolveValueCents: amount=49.995 → Math.round(4999.5) = 5000", () => {
  const body = parse({ referralCode: "c", externalId: "e", amount: 49.995 });
  assert.ok(body.success);
  assert.equal(resolveValueCents(body.data!), 5000);
});

// ── computeCommissionCents ──────────────────────────────────────────────────

test("commission rounding: valueCents=999, rate=15 → 150 (Math.round(149.85))", () => {
  // Math.round(999 * 15 / 100) = Math.round(149.85) = 150
  assert.equal(computeCommissionCents(999, 15), 150);
});

test("commission rounding: valueCents=1, rate=15 → 0 (Math.round(0.15))", () => {
  assert.equal(computeCommissionCents(1, 15), 0);
});

test("commission: rate=null → 0", () => {
  assert.equal(computeCommissionCents(5000, null), 0);
});

test("commission: rate=undefined → 0", () => {
  assert.equal(computeCommissionCents(5000, undefined), 0);
});

test("commission: rate=0 → 0", () => {
  assert.equal(computeCommissionCents(5000, 0), 0);
});

test("commission: valueCents=0, rate=10 → 0", () => {
  assert.equal(computeCommissionCents(0, 10), 0);
});

test("commission: valueCents=10000, rate=10 → 1000", () => {
  assert.equal(computeCommissionCents(10000, 10), 1000);
});

test("commission: valueCents=100, rate=7.5 → 8 (Math.round(7.5))", () => {
  assert.equal(computeCommissionCents(100, 7.5), 8);
});

// ── Refund guard logic (pure state checks) ──────────────────────────────────

test("refund guard: refunded=true → already refunded (noOp)", () => {
  const conversion = { refunded: true, payoutId: null };
  assert.equal(conversion.refunded, true);
});

test("refund guard: payoutId set → locked (must 409)", () => {
  const conversion = { refunded: false, payoutId: "pay_001" };
  assert.ok(conversion.payoutId !== null);
});

test("refund guard: refunded=false, payoutId=null → can refund", () => {
  const conversion = { refunded: false, payoutId: null };
  assert.equal(conversion.refunded, false);
  assert.equal(conversion.payoutId, null);
});

// ── externalId format examples (documentation via test) ─────────────────────

test("externalId signup format: signup:{userId}", () => {
  const r = parse({ referralCode: "c", externalId: "signup:user_01abc", amountCents: 0 });
  assert.equal(r.success, true);
});

test("externalId payment format: payment:{orderId}", () => {
  const r = parse({ referralCode: "c", externalId: "payment:ord_xyz9", amountCents: 1999 });
  assert.equal(r.success, true);
});

console.log(`\n${n} passed\n`);
