/**
 * Unit tests for executeReplyDetection routing.
 *
 * Focus: the active-negotiation short-circuit. A reply that arrives while a
 * negotiation is already in progress (negotiationRound >= 1) must route to the
 * negotiation agent (-> NEGOTIATING) instead of being re-classified by the
 * first-reply classifier — re-classification is what let a plain
 * "I charge 480 dollars" be labeled NEGATIVE and terminate the instance at
 * REJECTED even though 480 was within the $500 ceiling.
 *
 * Uses the injectable DB seam (ReplyDetectionDeps) so no live database is
 * needed.
 *
 * Run with:  npx tsx --test src/engine/executors/replyDetection.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Message, ReplyIntent } from "@prisma/client";
import {
  executeReplyDetection,
  type ReplyDetectionDeps,
} from "./replyDetection.js";

const NODES = [
  { id: "node-reply-detection", type: "REPLY_DETECTION", order: 4, config: {} },
  { id: "node-negotiation", type: "NEGOTIATION", order: 5, config: {} },
];

function ctx(negotiationRound: number) {
  return {
    instance: { id: "i1", currentState: "REPLY_RECEIVED", negotiationRound },
    node: NODES[0],
    nodeGraph: NODES,
    creator: { id: "c1", name: "Alex" },
  } as never;
}

const fakeEmail = {} as never;

// Track classify / classification-write calls so we can assert the
// short-circuit truly bypasses both.
function makeDeps() {
  const calls = { classify: 0, updateClassification: 0 };
  const agent = {
    classify: async (_body: string, _intent?: string) => {
      calls.classify++;
      return { intent: returnIntent as ReplyIntent, confidence: returnConfidence };
    },
  } as never;
  let returnIntent = "NEGATIVE";
  let returnConfidence = 1;
  const deps: ReplyDetectionDeps = {
    listMessagesByInstance: async () =>
      [{ id: "m1", instanceId: "i1", direction: "INBOUND", body: "I charge 480 dollars" } as unknown as Message],
    updateMessageClassification: async () => {
      calls.updateClassification++;
    },
  };
  return {
    calls,
    deps,
    agent,
    setIntent: (i: string) => {
      returnIntent = i;
    },
    setConfidence: (c: number) => {
      returnConfidence = c;
    },
  };
}

test("mid-negotiation reply (round >= 1) routes to NEGOTIATING without classifying", async () => {
  const { calls, deps, agent } = makeDeps();
  const result = await executeReplyDetection(ctx(1), fakeEmail, agent, deps);

  assert.equal(result.nextState, "NEGOTIATING");
  assert.equal(result.nextNodeId, "node-negotiation");
  assert.equal(calls.classify, 0, "classifier should be bypassed mid-negotiation");
  assert.equal(calls.updateClassification, 0, "no classification write on the routed reply");
  assert.equal((result.eventPayload as Record<string, unknown>)["routedToNegotiation"], true);
});

test("first reply (round 0) NEGATIVE still terminates at REJECTED via classifier", async () => {
  const { calls, deps, agent, setIntent } = makeDeps();
  setIntent("NEGATIVE");
  const result = await executeReplyDetection(ctx(0), fakeEmail, agent, deps);

  assert.equal(calls.classify, 1, "first reply must be classified");
  assert.equal(result.nextState, "REJECTED");
});

test("first reply (round 0) POSITIVE advances to NEGOTIATING (unchanged)", async () => {
  const { calls, deps, agent, setIntent } = makeDeps();
  setIntent("POSITIVE");
  const result = await executeReplyDetection(ctx(0), fakeEmail, agent, deps);

  assert.equal(calls.classify, 1);
  assert.equal(result.nextState, "NEGOTIATING");
});

test("A1/A2: UNKNOWN intent routes to MANUAL_REVIEW (low_confidence_reply) instead of dead-ending silently", async () => {
  // V1 (#14): escalation is a clean one-way handoff. An unclassifiable reply
  // routes to MANUAL_REVIEW (terminal); runtime emails the brand an FYI and the
  // conversation surfaces in the Manual Queue for a human to read the intent.
  const { calls, deps, agent, setIntent } = makeDeps();
  setIntent("UNKNOWN");
  const result = await executeReplyDetection(ctx(0), fakeEmail, agent, deps);

  assert.equal(calls.classify, 1, "the reply is classified first");
  assert.equal(result.nextState, "MANUAL_REVIEW", "unclassifiable reply → clean human handoff");
  assert.equal(result.eventType, "MANUAL_REVIEW_FLAGGED");
  const payload = result.eventPayload as Record<string, unknown>;
  assert.equal(payload["reason"], "low_confidence_reply", "audit reason preserved for the Manual Queue");
  assert.equal(payload["intent"], "UNKNOWN");
});

test("A1/A2: low-confidence classification (below threshold) also routes to MANUAL_REVIEW", async () => {
  // A confident-looking POSITIVE, but below the 0.50 threshold → overridden to
  // UNKNOWN → MANUAL_REVIEW (not auto-advanced to NEGOTIATING).
  const { deps, agent, setIntent, setConfidence } = makeDeps();
  setIntent("POSITIVE");
  setConfidence(0.3);
  const result = await executeReplyDetection(ctx(0), fakeEmail, agent, deps);

  assert.equal(result.nextState, "MANUAL_REVIEW");
  assert.equal((result.eventPayload as Record<string, unknown>)["reason"], "low_confidence_reply");
});
