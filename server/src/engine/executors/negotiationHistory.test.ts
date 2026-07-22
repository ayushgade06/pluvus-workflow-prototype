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
import type { Event, EventType, Message } from "../../db/schema.js";
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

// PLU-85: a SENT outbound Message row. Sets sentAt (the delivery gate) at `atMs`
// and, by default, an idempotencyKey so the enrich-join can recover round/action.
function outbound(
  overrides: Partial<Message> & { body: string },
  atMs: number,
): Message {
  return msg(
    { direction: "OUTBOUND", sentAt: new Date(atMs), receivedAt: null, ...overrides },
    atMs,
  );
}

console.log("\nnegotiationHistory.buildDraftHistory (PLU-85 / HARD-N2)\n");

test("interleaves our SENT outbound and creator inbounds chronologically", () => {
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 350, message: "We can offer $350." }, 20),
  ];
  const messages = [
    msg({ body: "What is the commission?", direction: "INBOUND" }, 10),
    outbound(
      { body: "We can offer $350.", idempotencyKey: "negotiation:counter_offer:i1:1" },
      20,
    ),
    msg({ body: "Sounds good, $350 works.", direction: "INBOUND" }, 30),
  ];
  const hist = buildDraftHistory(messages, new Set(), events);
  assert.equal(hist.length, 3);
  assert.equal(hist[0]!.role, "creator"); // 10
  assert.equal(hist[1]!.role, "us"); // 20
  assert.equal(hist[2]!.role, "creator"); // 30
  // Enrich-join recovers round/action from the key and rate from the event.
  assert.equal(hist[1]!.round, 1);
  assert.equal(hist[1]!.action, "COUNTER");
  assert.equal(hist[1]!.rate, 350);
  assert.equal(hist[1]!.message, "We can offer $350.");
  // Every entry carries its source messageId for auditability.
  assert.equal(hist[1]!.messageId, "m20");
  assert.equal(hist[0]!.messageId, "m10");
});

test("excludes brand-reply inbound messages from the creator transcript", () => {
  const messages = [
    msg({ body: "creator asking a thing", direction: "INBOUND", externalMessageId: "c1" }, 10),
    msg({ body: "approve", direction: "INBOUND", externalMessageId: "brand1" }, 20),
  ];
  const hist = buildDraftHistory(messages, new Set(["brand1"]), []);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.role, "creator");
});

test("acceptance 3: a reserved-but-unsent outbound row (sentAt=null) is excluded", () => {
  const messages = [
    // Reserved but never flushed — no sentAt, no externalMessageId. Must NOT appear.
    msg(
      { body: "counter we never actually sent", direction: "OUTBOUND", idempotencyKey: "negotiation:counter_offer:i1:1" },
      10,
    ),
    outbound(
      { body: "the counter we DID send", idempotencyKey: "negotiation:counter_offer:i1:2" },
      20,
    ),
  ];
  const hist = buildDraftHistory(messages, new Set(), []);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.role, "us");
  assert.equal(hist[0]!.message, "the counter we DID send");
});

test("acceptance 5: an eventless manual/operator outbound row still appears (text-only)", () => {
  const messages = [
    // A manually-sent outbound with NO negotiation event and no negotiation key.
    outbound({ body: "Hey — quick manual note from the operator.", idempotencyKey: null }, 10),
  ];
  const hist = buildDraftHistory(messages, new Set(), []);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.role, "us");
  assert.equal(hist[0]!.message, "Hey — quick manual note from the operator.");
  // No owning event → round/action/rate absent, but the row is still included.
  assert.equal(hist[0]!.round, undefined);
  assert.equal(hist[0]!.action, undefined);
  assert.equal(hist[0]!.rate, undefined);
  assert.equal(hist[0]!.messageId, "m10");
});

test("acceptance 5: a sent outbound with a negotiation key but NO matching event still appears", () => {
  const messages = [
    outbound({ body: "sent copy", idempotencyKey: "negotiation:counter_offer:i1:1" }, 10),
  ];
  // Events for a DIFFERENT round → no rate to enrich; action/round come from key.
  const events = [ev("NEGOTIATION_TURN", { outcome: "counter", round: 2, rate: 400 }, 5)];
  const hist = buildDraftHistory(messages, new Set(), events);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.round, 1);
  assert.equal(hist[0]!.action, "COUNTER");
  assert.equal(hist[0]!.rate, undefined); // no round-1 event → rate not recovered
});

test("model integrity: transcript uses the SENT body, not the event's draft copy", () => {
  // Operator-edit simulation: event.payload.message = "X" but the sent body = "Y".
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 350, message: "X (the AI draft)" }, 20),
  ];
  const messages = [
    outbound(
      { body: "Y (what the operator actually sent)", idempotencyKey: "negotiation:counter_offer:i1:1" },
      20,
    ),
  ];
  const hist = buildDraftHistory(messages, new Set(), events);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.message, "Y (what the operator actually sent)");
  // ...but round/action/rate are still enriched from the event.
  assert.equal(hist[0]!.rate, 350);
});

test("acceptance 6: ordering uses sentAt/receivedAt (delayed send), not event time", () => {
  // Decision at t=10 but the send flushes at t=30 (5-min delay window). A creator
  // reply arrives at t=20 IN BETWEEN. Ordering must be by delivery time, so the
  // creator reply comes BEFORE our sent counter — not after (as event time = 10
  // would place it).
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 350, message: "offer" }, 10),
  ];
  const messages = [
    outbound({ body: "our counter, flushed late", idempotencyKey: "negotiation:counter_offer:i1:1" }, 30),
    msg({ body: "creator reply that arrived first", direction: "INBOUND" }, 20),
  ];
  const hist = buildDraftHistory(messages, new Set(), events);
  assert.equal(hist.length, 2);
  assert.equal(hist[0]!.role, "creator"); // received at 20
  assert.equal(hist[1]!.role, "us"); // sent at 30 (NOT event time 10)
});

test("ordering falls back to createdAt only when the primary time is null", () => {
  // An inbound row with receivedAt = null falls back to createdAt.
  const messages = [
    msg({ body: "later, created at 30", direction: "INBOUND", receivedAt: null, createdAt: new Date(30) }, 30),
    outbound({ body: "sent at 10" }, 10),
  ];
  const hist = buildDraftHistory(messages, new Set(), []);
  assert.equal(hist[0]!.message, "sent at 10"); // sentAt 10
  assert.equal(hist[1]!.message, "later, created at 30"); // createdAt fallback 30
});

test("empty-text inbound rows are still dropped (extractReplyText)", () => {
  const messages = [
    // A blank/whitespace-only inbound reply extracts to empty → dropped.
    msg({ body: "   \n  \n", direction: "INBOUND" }, 10),
    outbound({ body: "our real sent copy" }, 20),
  ];
  const hist = buildDraftHistory(messages, new Set(), []);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.role, "us");
});

test("empty-bodied outbound rows are dropped", () => {
  const messages = [
    // A sent row with a whitespace-only body contributes nothing.
    outbound({ body: "   " }, 10),
    outbound({ body: "real copy" }, 20),
  ];
  const hist = buildDraftHistory(messages, new Set(), []);
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.message, "real copy");
});

test("acceptance 4: decision history (buildPriorContextFromEvents) is untouched", () => {
  // The money path reads events, NOT the message-sourced transcript. Feeding a
  // divergent sent body must not change the event-sourced decision context.
  const events = [
    ev("NEGOTIATION_TURN", { outcome: "counter", round: 1, rate: 200, message: "X" }, 10),
    ev("NEGOTIATION_TURN", { outcome: "accept", round: 2, rate: 250, message: "X2" }, 20),
  ];
  const ctx = buildPriorContextFromEvents(events);
  assert.deepEqual(ctx.history.map((h) => h.rate), [200, 250]);
  assert.equal(ctx.currentOffer, 250);
});

test("present key with trailing inboundId parses round correctly", () => {
  const messages = [
    outbound(
      { body: "here's our rate", idempotencyKey: "negotiation:present:i1:1:inbound_abc" },
      10,
    ),
  ];
  const events = [ev("NEGOTIATION_TURN", { outcome: "present_offer", round: 1, rate: 300 }, 8)];
  const hist = buildDraftHistory(messages, new Set(), events);
  assert.equal(hist[0]!.round, 1);
  assert.equal(hist[0]!.action, "PRESENT_OFFER");
  assert.equal(hist[0]!.rate, 300);
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
