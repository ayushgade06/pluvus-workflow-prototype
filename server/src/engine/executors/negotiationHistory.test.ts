/**
 * Standalone unit tests for buildPriorContextFromEvents (FIX-1 / FIX-2).
 *
 * Pure function over already-fetched events — no DB, no network. Run with:
 *   npx tsx src/engine/executors/negotiationHistory.test.ts
 *
 * (The project has no TS test runner; this mirrors the harness pattern of a
 * self-contained script that exits non-zero on failure.)
 */

import assert from "node:assert/strict";
import type { Event, EventType } from "@prisma/client";
import { buildPriorContextFromEvents } from "./negotiationHistory.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Minimal Event factory — only the fields the function reads.
function ev(
  type: EventType,
  payload: Record<string, unknown> | null,
  occurredAtMs: number,
): Event {
  return {
    id: `e${occurredAtMs}`,
    instanceId: "i1",
    type,
    nodeId: null,
    payload: payload as Event["payload"],
    occurredAt: new Date(occurredAtMs),
  };
}

console.log("\nnegotiationHistory.buildPriorContextFromEvents\n");

test("empty events → empty history, no current offer", () => {
  const ctx = buildPriorContextFromEvents([]);
  assert.deepEqual(ctx.history, []);
  assert.equal(ctx.currentOffer, undefined);
});

test("ignores non-NEGOTIATION_TURN events", () => {
  const ctx = buildPriorContextFromEvents([
    ev("STATE_TRANSITION", { from: "A", to: "B" }, 1),
    ev("REPLY_CLASSIFIED", { intent: "POSITIVE" }, 2),
  ]);
  assert.deepEqual(ctx.history, []);
});

test("orders turns chronologically regardless of input order", () => {
  const ctx = buildPriorContextFromEvents([
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 2, rate: 250 }, 30),
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 200 }, 10),
  ]);
  assert.deepEqual(
    ctx.history.map((h) => h.round),
    [1, 2],
  );
});

test("currentOffer = last ACCEPT/COUNTER rate", () => {
  const ctx = buildPriorContextFromEvents([
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 200 }, 10),
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 2, rate: 250 }, 20),
  ]);
  assert.equal(ctx.currentOffer, 250);
});

test("REJECT / ESCALATE do not set currentOffer", () => {
  const ctx = buildPriorContextFromEvents([
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 200 }, 10),
    ev("NEGOTIATION_TURN", { outcome: "ESCALATE", round: 2 }, 20),
  ]);
  // currentOffer stays at the last real offer (the counter), not cleared.
  assert.equal(ctx.currentOffer, 200);
});

test("normalizes lowercase + uppercase outcomes to canonical action", () => {
  const ctx = buildPriorContextFromEvents([
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 200 }, 10),
    ev("NEGOTIATION_TURN", { outcome: "ACCEPT", round: 2, rate: 220 }, 20),
  ]);
  assert.deepEqual(
    ctx.history.map((h) => h.action),
    ["COUNTER", "ACCEPT"],
  );
});

test("tolerates missing rate (pre-FIX events) without crashing", () => {
  const ctx = buildPriorContextFromEvents([
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, message: "hi" }, 10),
  ]);
  assert.equal(ctx.history[0]!.rate, undefined);
  assert.equal(ctx.currentOffer, undefined);
  assert.equal(ctx.history[0]!.message, "hi");
});

test("skips malformed payloads (no/invalid outcome)", () => {
  const ctx = buildPriorContextFromEvents([
    ev("NEGOTIATION_TURN", null, 5),
    ev("NEGOTIATION_TURN", { outcome: "WAT", round: 1 }, 10),
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 2, rate: 300 }, 20),
  ]);
  assert.equal(ctx.history.length, 1);
  assert.equal(ctx.history[0]!.action, "COUNTER");
});

test("derives round from position when round field absent", () => {
  const ctx = buildPriorContextFromEvents([
    ev("NEGOTIATION_TURN", { outcome: "counter", rate: 100 }, 10),
    ev("NEGOTIATION_TURN", { outcome: "counter", rate: 150 }, 20),
  ]);
  assert.deepEqual(
    ctx.history.map((h) => h.round),
    [0, 1],
  );
});

console.log(`\n✓ negotiationHistory: all ${n} tests passed\n`);
