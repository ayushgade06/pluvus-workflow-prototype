/**
 * Tests for the fail-loud-on-missing-brand escalation (L4).
 * Verifies the escalation NodeResult shape and that the state machine permits the
 * three new transitions the reward/payment/content-brief executors use when no
 * brand name can be resolved (config AND campaign both missing it).
 *
 * Run with:  npx tsx src/engine/executors/missingBrand.test.ts
 */

import assert from "node:assert/strict";
import { blockedByMissingBrand } from "./guardEscalation.js";
import { assertTransition } from "../stateMachine.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nmissing-brand fail-loud (L4)\n");

test("blockedByMissingBrand routes to MANUAL_REVIEW with an auditable reason", () => {
  const r = blockedByMissingBrand("REWARD_SETUP");
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(r.nextNodeId, null);
  assert.equal(r.eventType, "MANUAL_REVIEW_FLAGGED");
  assert.equal(r.eventPayload?.["reason"], "missing_brand_name");
  assert.equal(r.eventPayload?.["node"], "REWARD_SETUP");
});

test("state machine permits the three L4 escalation transitions", () => {
  // These are the states the reward/payment/content-brief executors run from.
  assertTransition("ACCEPTED", "MANUAL_REVIEW");
  assertTransition("REWARD_CONFIRMED", "MANUAL_REVIEW");
  assertTransition("PAYMENT_RECEIVED", "MANUAL_REVIEW");
});

test("the normal happy-path transitions still hold", () => {
  assertTransition("ACCEPTED", "REWARD_PENDING");
  assertTransition("REWARD_CONFIRMED", "PAYMENT_PENDING");
  assertTransition("PAYMENT_RECEIVED", "CONTENT_BRIEF_SENT");
});

console.log(`\n${n} passed\n`);
