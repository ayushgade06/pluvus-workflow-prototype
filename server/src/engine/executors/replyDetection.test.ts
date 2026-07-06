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
  const calls = { classify: 0, updateClassification: 0, openBrandDecision: 0 };
  const agent = {
    classify: async (_body: string, _intent?: string) => {
      calls.classify++;
      return { intent: returnIntent as ReplyIntent, confidence: returnConfidence };
    },
  } as never;
  let returnIntent = "NEGATIVE";
  let returnConfidence = 1;
  // Capture the input openBrandDecision was called with so the UNKNOWN test can
  // assert the reason/actions/context, without touching the DB or email.
  let lastBrandDecisionInput: Record<string, unknown> | null = null;
  const deps: ReplyDetectionDeps = {
    listMessagesByInstance: async () =>
      [{ id: "m1", instanceId: "i1", direction: "INBOUND", body: "I charge 480 dollars" } as unknown as Message],
    updateMessageClassification: async () => {
      calls.updateClassification++;
    },
    openBrandDecision: (async (_ctx, _email, input) => {
      calls.openBrandDecision++;
      lastBrandDecisionInput = input as unknown as Record<string, unknown>;
      // Mimic the real return: the run parks in AWAITING_BRAND_DECISION on the
      // escalating node.
      return {
        nextState: "AWAITING_BRAND_DECISION",
        nextNodeId: "node-reply-detection",
        eventType: input.eventType,
        eventPayload: { ...(input.eventPayload ?? {}), brandDecisionOpened: true },
      };
    }) as ReplyDetectionDeps["openBrandDecision"],
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
    getBrandDecisionInput: () => lastBrandDecisionInput,
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

test("A1/A2: UNKNOWN intent opens a brand decision (low_confidence_reply) instead of dead-ending", async () => {
  const { calls, deps, agent, setIntent, getBrandDecisionInput } = makeDeps();
  setIntent("UNKNOWN");
  const result = await executeReplyDetection(ctx(0), fakeEmail, agent, deps);

  assert.equal(calls.classify, 1, "the reply is classified first");
  assert.equal(calls.openBrandDecision, 1, "UNKNOWN routes to the brand-decision hand-off");
  assert.equal(result.nextState, "AWAITING_BRAND_DECISION", "no longer MANUAL_REVIEW");

  const input = getBrandDecisionInput()!;
  assert.equal(input["reason"], "low_confidence_reply");
  assert.deepEqual(input["actions"], ["approve", "reject", "counter", "handoff"]);
  const context = input["context"] as Record<string, unknown>;
  assert.equal(context["reason"], "low_confidence_reply");
  assert.equal(context["negotiationNodeId"], "node-negotiation", "resume target is the negotiation node");
});

test("A1/A2: low-confidence classification (below threshold) also opens a brand decision", async () => {
  const { calls, deps, agent, setIntent, setConfidence } = makeDeps();
  // A confident-looking POSITIVE, but below the 0.50 threshold → overridden to
  // UNKNOWN → brand decision (not auto-advanced to NEGOTIATING).
  setIntent("POSITIVE");
  setConfidence(0.3);
  const result = await executeReplyDetection(ctx(0), fakeEmail, agent, deps);

  assert.equal(calls.openBrandDecision, 1);
  assert.equal(result.nextState, "AWAITING_BRAND_DECISION");
});
