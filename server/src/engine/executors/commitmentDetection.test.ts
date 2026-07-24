/**
 * PLU-111 §4.8 — unit tests for the sent-deferral → commitment detector.
 *
 * Pure — no DB. Run with:
 *   npx tsx --test src/engine/executors/commitmentDetection.test.ts
 */

import assert from "node:assert/strict";
import type { ConversationObligation } from "../../db/schema.js";
import { isQuestionDeferredBySentBody } from "./commitmentDetection.js";
import { normalizeObligationKey } from "./negotiationHistory.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function q(originalText: string, category?: string): ConversationObligation {
  return {
    id: "q1",
    instanceId: "i1",
    type: "CREATOR_QUESTION",
    status: "OPEN",
    originalText,
    normalizedKey: normalizeObligationKey(originalText),
    category: category ?? null,
    resolution: null,
    resolutionSource: null,
    sourceMessageId: null,
    resolutionMessageId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    resolvedAt: null,
  };
}

console.log("\nPLU-111 isQuestionDeferredBySentBody\n");

test("deferral marker + topic overlap → deferred", () => {
  const ob = q("what are the usage rights?", "usage_rights");
  const body =
    "Thanks for asking! We'll confirm the usage rights together on the next step.";
  assert.equal(isQuestionDeferredBySentBody(ob, body), true);
});

test("a DIRECT answer (no deferral marker) → not deferred", () => {
  const ob = q("what are the usage rights?", "usage_rights");
  const body = "The usage rights are 6 months of organic social usage, no paid.";
  assert.equal(isQuestionDeferredBySentBody(ob, body), false);
});

test("a deferral marker about a DIFFERENT topic → not deferred (topic link required)", () => {
  // The body defers the shipping timeline, but this question is about usage
  // rights — no topic overlap, so it must NOT be marked deferred.
  const ob = q("what are the usage rights?", "usage_rights");
  const body = "We'll confirm the shipping timeline once the address is in.";
  assert.equal(isQuestionDeferredBySentBody(ob, body), false);
});

test("topic overlap via category keyword (question wording not echoed)", () => {
  const ob = q("when will the sample arrive?", "shipping");
  const body = "Great question — we'll get back to you on the exact shipping date.";
  // "shipping" is a category keyword even though the body doesn't echo "sample".
  assert.equal(isQuestionDeferredBySentBody(ob, body), true);
});

test("no marker anywhere → not deferred even with topic words present", () => {
  const ob = q("what are the usage rights?", "usage_rights");
  const body = "Usage rights: 6-month organic license. Exclusivity: none.";
  assert.equal(isQuestionDeferredBySentBody(ob, body), false);
});

test("innocuous 'together' does NOT false-match as a deferral", () => {
  // Regression against the agent-side bug: 'together' alone is not a marker.
  const ob = q("what are the usage rights?", "usage_rights");
  const body = "Looking forward to working together on the usage rights soon!";
  assert.equal(isQuestionDeferredBySentBody(ob, body), false);
});

console.log(`\n✓ commitmentDetection: all ${n} tests passed\n`);
