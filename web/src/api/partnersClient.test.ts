/**
 * Unit tests for partnersClient utilities.
 *   - formatCents: shared dollar formatter (spec: no ad-hoc /100 in components)
 *
 * Run: npx tsx web/src/api/partnersClient.test.ts
 */

import assert from "node:assert/strict";
import { formatCents } from "./partnersClient.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nformatCents\n");

test("zero → $0.00", () => {
  assert.equal(formatCents(0), "$0.00");
});

test("100 cents → $1.00", () => {
  assert.equal(formatCents(100), "$1.00");
});

test("4999 cents → $49.99", () => {
  assert.equal(formatCents(4999), "$49.99");
});

test("5000 cents → $50.00", () => {
  assert.equal(formatCents(5000), "$50.00");
});

test("1 cent → $0.01", () => {
  assert.equal(formatCents(1), "$0.01");
});

test("negative → -$X.XX", () => {
  assert.equal(formatCents(-199), "-$1.99");
});

test("non-USD currency prefix", () => {
  assert.equal(formatCents(100, "EUR"), "EUR 1.00");
});

test("NaN → em dash", () => {
  assert.equal(formatCents(NaN), "—");
});

test("Infinity → em dash", () => {
  assert.equal(formatCents(Infinity), "—");
});

test("large amount: 1_000_000 cents → $10000.00", () => {
  assert.equal(formatCents(1_000_000), "$10000.00");
});

console.log(`\n${n} passed\n`);
