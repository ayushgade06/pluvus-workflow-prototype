/**
 * Unit tests for Reward Setup fee resolution — resolveAgreedFee derives the
 * final fixed fee to show/confirm from the persisted negotiation history, with
 * a band fallback. Pure — no DB, no network. Run:
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

test("no negotiation history → falls back to band ceiling (maxBudget)", () => {
  assert.equal(resolveAgreedFee([], { minBudget: 100, maxBudget: 800 }), 800);
});

test("no history, no ceiling → falls back to floor (minBudget)", () => {
  assert.equal(resolveAgreedFee([], { minBudget: 250 }), 250);
});

test("no history and no band → undefined", () => {
  assert.equal(resolveAgreedFee([], {}), undefined);
});

test("termFloor/termCeiling band shape is honored", () => {
  assert.equal(
    resolveAgreedFee([], { termFloor: { rate: 200 }, termCeiling: { rate: 900 } }),
    900,
  );
});

test("falls back to the reward node's own band when the negotiation node has none", () => {
  // Empty negotiation config, band only on the fallback (reward) config.
  assert.equal(resolveAgreedFee([], {}, { minBudget: 150, maxBudget: 600 }), 600);
});

console.log(`\n${n} passed\n`);
