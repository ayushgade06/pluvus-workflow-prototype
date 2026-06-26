/**
 * Unit tests for describeDeal — derives a number-free deal-structure sentence
 * from the NEGOTIATION node config so outreach explains the real offer.
 * Run: npx tsx src/engine/dealDescription.test.ts
 */

import assert from "node:assert/strict";
import { describeDeal } from "./dealDescription.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\ndescribeDeal\n");

test("hybrid: commission + budget → fixed fee + commission, no $ figure", () => {
  const d = describeDeal({ minBudget: 200, maxBudget: 500, commissionRate: 10 });
  assert.ok(d);
  assert.match(d!, /hybrid/i);
  assert.match(d!, /fixed fee/i);
  assert.match(d!, /10% commission/i);
  // No band numbers leak.
  assert.doesNotMatch(d!, /\b200\b|\b500\b/);
});

test("affiliate: commission, no fixed budget → commission only", () => {
  const d = describeDeal({ minBudget: 0, maxBudget: 0, commissionRate: 15 });
  assert.ok(d);
  assert.match(d!, /affiliate|performance/i);
  assert.match(d!, /15% commission/i);
  assert.match(d!, /no upfront fee/i);
});

test("fixed fee: budget, no commission → flat fee", () => {
  const d = describeDeal({ minBudget: 500, maxBudget: 5000 });
  assert.ok(d);
  assert.match(d!, /fixed-fee|flat fee/i);
  assert.doesNotMatch(d!, /commission/i);
});

test("termFloor/termCeiling band (seed shape) counts as a fixed fee", () => {
  const d = describeDeal({ termFloor: { rate: 500 }, termCeiling: { rate: 2000 } });
  assert.ok(d);
  assert.match(d!, /fixed-fee|flat fee/i);
});

test("no commission and no budget → undefined (nothing to describe)", () => {
  assert.equal(describeDeal({ maxRounds: 3 }), undefined);
});

test("undefined config → undefined", () => {
  assert.equal(describeDeal(undefined), undefined);
});

test("zero commission is treated as no commission", () => {
  const d = describeDeal({ maxBudget: 500, commissionRate: 0 });
  assert.ok(d);
  assert.doesNotMatch(d!, /commission/i);
});

test("never emits a bracketed placeholder", () => {
  const d = describeDeal({ minBudget: 200, maxBudget: 500, commissionRate: 10 });
  assert.doesNotMatch(d!, /\[|\]/);
});

console.log(`\n${n} passed\n`);
