/**
 * Unit tests for Reward Setup fee resolution — resolveAgreedFee derives the
 * final fixed fee to show/confirm from the persisted negotiation history.
 *
 * CRITICAL-3: it no longer falls back to the negotiation band (ceiling → floor)
 * when there's no genuine agreed rate — that fallback stated the INTERNAL CEILING
 * as "the agreed fee" in contract-forming emails. It now returns `undefined`, and
 * the contract-forming callers (Reward Setup / Content Brief) escalate to a human
 * rather than fabricate a fee. Pure — no DB, no network. Run:
 *   npx tsx src/engine/executors/rewardSetup.test.ts
 */

import assert from "node:assert/strict";
import type { Event } from "@prisma/client";
import { resolveAgreedFee } from "./rewardSetup.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Build a minimal NEGOTIATION_TURN event. Only type/occurredAt/payload are read
// by buildPriorContextFromEvents (via resolveAgreedFee).
let seq = 0;
function turn(payload: Record<string, unknown>): Event {
  seq += 1;
  return {
    id: `evt-${seq}`,
    instanceId: "inst-1",
    type: "NEGOTIATION_TURN",
    nodeId: "node-negotiation",
    payload,
    // Deterministic increasing timestamps so chronological ordering is stable.
    occurredAt: new Date(1_700_000_000_000 + seq * 1000),
  } as Event;
}

console.log("\nresolveAgreedFee\n");

test("uses the rate from the ACCEPT turn (the closed deal)", () => {
  const events = [
    turn({ outcome: "counter", round: 1, rate: 300 }),
    turn({ outcome: "accept", round: 2, rate: 450 }),
  ];
  assert.equal(resolveAgreedFee(events, { minBudget: 0, maxBudget: 500 }), 450);
});

test("uses the last offer on the table when the accept carried no explicit rate", () => {
  // ACCEPT with no rate → currentOffer falls back to the last COUNTER rate.
  const events = [
    turn({ outcome: "counter", round: 1, rate: 320 }),
    turn({ outcome: "accept", round: 2 }),
  ];
  assert.equal(resolveAgreedFee(events, { minBudget: 0, maxBudget: 500 }), 320);
});

// CRITICAL-3: with no genuine agreed rate in the history, resolveAgreedFee must
// return undefined — NOT the band ceiling/floor. These previously asserted the
// old ceiling/floor fallback (the bug); they now assert the hard-fail so callers
// escalate instead of stating a fabricated fee.
test("no negotiation history → undefined (no ceiling fallback)", () => {
  assert.equal(resolveAgreedFee([], { minBudget: 100, maxBudget: 800 }), undefined);
});

test("no history, floor only → undefined (no floor fallback)", () => {
  assert.equal(resolveAgreedFee([], { minBudget: 250 }), undefined);
});

test("no history and no band → undefined", () => {
  assert.equal(resolveAgreedFee([], {}), undefined);
});

test("termFloor/termCeiling band is NOT used as a fee fallback", () => {
  assert.equal(
    resolveAgreedFee([], { termFloor: { rate: 200 }, termCeiling: { rate: 900 } }),
    undefined,
  );
});

test("the reward node's own band is NOT used as a fee fallback either", () => {
  // Empty negotiation config, band only on the fallback (reward) config.
  assert.equal(resolveAgreedFee([], {}, { minBudget: 150, maxBudget: 600 }), undefined);
});

test("a terminal ACCEPT turn (outcome ACCEPT + rate) IS recovered as the agreed fee", () => {
  // CRITICAL-3: the final ACCEPT turn carries outcome:ACCEPT + the agreed rate, so
  // the closing number flows through to the finalized-terms resolver even when an
  // earlier counter proposed a different figure.
  const events = [
    turn({ outcome: "counter", round: 1, rate: 400 }),
    turn({ outcome: "ACCEPT", rate: 425 }),
  ];
  assert.equal(resolveAgreedFee(events, { minBudget: 200, maxBudget: 500 }), 425);
});

console.log(`\n${n} passed\n`);
