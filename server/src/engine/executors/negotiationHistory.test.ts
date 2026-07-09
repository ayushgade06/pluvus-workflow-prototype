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
import type { Event, EventType, Message } from "@prisma/client";
import {
  buildPriorContextFromEvents,
  buildDraftHistory,
  computeOpenQuestions,
} from "./negotiationHistory.js";

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

// ---------------------------------------------------------------------------
// HARD-N2: buildDraftHistory + computeOpenQuestions
// ---------------------------------------------------------------------------

function msg(
  overrides: Partial<Message> & { body: string; direction: Message["direction"] },
  atMs: number,
): Message {
  return {
    id: `m${atMs}`,
    instanceId: "i1",
    subject: null,
    threadId: null,
    senderEmail: null,
    externalMessageId: null,
    idempotencyKey: null,
    replyIntent: null,
    classifyConfidence: null,
    sentAt: null,
    receivedAt: new Date(atMs),
    processedAt: null,
    createdAt: new Date(atMs),
    ...overrides,
  } as Message;
}

console.log("\nnegotiationHistory.buildDraftHistory (HARD-N2)\n");

test("interleaves our turns and creator inbounds chronologically", () => {
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 350, message: "We can offer $350." }, 20),
  ];
  const messages = [
    msg({ body: "What is the commission?", direction: "INBOUND" }, 10),
    msg({ body: "Sounds good, $350 works.", direction: "INBOUND" }, 30),
  ];
  const hist = buildDraftHistory(events, messages, new Set());
  assert.equal(hist.length, 3);
  assert.equal(hist[0]!.role, "creator"); // 10
  assert.equal(hist[1]!.role, "us"); // 20
  assert.equal(hist[2]!.role, "creator"); // 30
  assert.equal(hist[1]!.action, "COUNTER");
  assert.equal(hist[1]!.rate, 350);
});

test("excludes brand-reply inbound messages from the creator transcript", () => {
  const messages = [
    msg({ body: "creator asking a thing", direction: "INBOUND", externalMessageId: "c1" }, 10),
    msg({ body: "approve", direction: "INBOUND", externalMessageId: "brand1" }, 20),
  ];
  const hist = buildDraftHistory([], messages, new Set(["brand1"]));
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.role, "creator");
});

test("skips outbound messages and empty-bodied turns", () => {
  const events = [
    // A draft-failure escalation carries no `message` → contributes nothing.
    ev("NEGOTIATION_TURN", { outcome: "escalate", round: 1 }, 20),
  ];
  const messages = [
    msg({ body: "our outbound copy", direction: "OUTBOUND" }, 10),
    msg({ body: "real creator reply", direction: "INBOUND" }, 30),
  ];
  const hist = buildDraftHistory(events, messages, new Set());
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.role, "creator");
});

console.log("\nnegotiationHistory.computeOpenQuestions (HARD-N2)\n");

test("surfaces an earlier-round question not asked again this turn", () => {
  const events = [
    ev(
      "NEGOTIATION_TURN",
      { outcome: "counter", round: 1, creatorQuestions: ["when do I get paid?", "what's the fee?"] },
      10,
    ),
  ];
  // This turn only re-asks the fee → "when do I get paid?" is still open.
  const open = computeOpenQuestions(events, ["what's the fee?"]);
  assert.deepEqual(open, ["when do I get paid?"]);
});

test("de-duplicates and excludes this turn's questions case-insensitively", () => {
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, creatorQuestions: ["Usage rights?"] }, 10),
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 2, creatorQuestions: ["usage rights?", "Exclusivity?"] }, 20),
  ];
  const open = computeOpenQuestions(events, ["exclusivity?"]);
  // "usage rights?" (asked twice) appears once; "Exclusivity?" excluded as it's this turn's.
  assert.deepEqual(open, ["Usage rights?"]);
});

test("returns [] when every prior question was re-asked this turn", () => {
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, creatorQuestions: ["what's the fee?"] }, 10),
  ];
  assert.deepEqual(computeOpenQuestions(events, ["what's the fee?"]), []);
});

console.log(`\n✓ negotiationHistory: all ${n} tests passed\n`);
