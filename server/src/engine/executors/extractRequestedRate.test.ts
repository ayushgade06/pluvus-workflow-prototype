/**
 * Unit tests for extractRequestedRate — pulls the dollar amount a creator named
 * in their reply so the counter copy can acknowledge it. Run:
 *   npx tsx src/engine/executors/extractRequestedRate.test.ts
 *
 * This is acknowledgement-only; it never drives the money decision.
 */

import assert from "node:assert/strict";
import { extractRequestedRate } from "./negotiation.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nextractRequestedRate\n");

test("dollar sign amount", () => {
  assert.equal(extractRequestedRate("I charge $480 for a post"), 480);
});
test("worded dollars", () => {
  assert.equal(extractRequestedRate("my rate is 480 dollars"), 480);
});
test("usd suffix", () => {
  assert.equal(extractRequestedRate("around 350 USD works"), 350);
});
test("comma thousands", () => {
  assert.equal(extractRequestedRate("I'd want $1,500"), 1500);
});
test("decimal", () => {
  assert.equal(extractRequestedRate("$480.50 please"), 480.5);
});
test("prefers $ amount over a bare number", () => {
  assert.equal(extractRequestedRate("for 3 posts my rate is $480"), 480);
});
test("no amount → undefined", () => {
  assert.equal(extractRequestedRate("yes I'm interested, let's talk"), undefined);
});
test("bare number with no currency cue → undefined (avoid false anchor)", () => {
  // "I have 3 reels ready" must not be read as a $3 ask.
  assert.equal(extractRequestedRate("I have 3 reels ready to go"), undefined);
});
test("empty / undefined input", () => {
  assert.equal(extractRequestedRate(""), undefined);
  assert.equal(extractRequestedRate(undefined), undefined);
});

console.log(`\n${n} passed\n`);
