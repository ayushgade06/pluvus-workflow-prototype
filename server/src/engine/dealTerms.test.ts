/**
 * PLU-70 — agreed-compensation formatting.
 *
 * This string is what an operator reads in the deal-finalization email and in
 * the Manual Queue row, and it is the ONLY place the closed terms are stated
 * outside the structured record. Getting it wrong (e.g. rendering "0% commission"
 * for a fixed-fee-only deal) would put a term in front of a human that nobody
 * agreed to. Pure — no DB. Run:
 *   npx tsx src/engine/dealTerms.test.ts
 */

import assert from "node:assert/strict";
import { formatAgreedCompensation } from "./dealTerms.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\ndeal terms — agreed compensation\n");

test("hybrid: fee + commission", () => {
  assert.equal(formatAgreedCompensation(750, 30), "$750 fixed fee + 30% commission");
});

test("affiliate: commission only (no fee is NORMAL, not missing data)", () => {
  assert.equal(formatAgreedCompensation(null, 30), "30% commission");
  assert.equal(formatAgreedCompensation(undefined, 30), "30% commission");
});

test("fixed fee only", () => {
  assert.equal(formatAgreedCompensation(750, null), "$750 fixed fee");
});

test("neither recorded renders an em dash, never a fabricated 0", () => {
  assert.equal(formatAgreedCompensation(null, null), "—");
  assert.equal(formatAgreedCompensation(undefined, undefined), "—");
});

test("zero is treated as absent, not as a real term", () => {
  // "$0 fixed fee" / "0% commission" would read to an operator as a negotiated
  // outcome. They mean "not part of this deal".
  assert.equal(formatAgreedCompensation(0, 30), "30% commission");
  assert.equal(formatAgreedCompensation(750, 0), "$750 fixed fee");
  assert.equal(formatAgreedCompensation(0, 0), "—");
});

test("non-finite values are ignored rather than rendered as NaN", () => {
  assert.equal(formatAgreedCompensation(Number.NaN, 30), "30% commission");
  assert.equal(formatAgreedCompensation(750, Number.POSITIVE_INFINITY), "$750 fixed fee");
});

test("fractional amounts keep their decimals; whole numbers don't gain any", () => {
  assert.equal(formatAgreedCompensation(1250.5, 12.5), "$1250.5 fixed fee + 12.5% commission");
  assert.equal(formatAgreedCompensation(1000, 10), "$1000 fixed fee + 10% commission");
});

console.log(`\n${n} passed\n`);
