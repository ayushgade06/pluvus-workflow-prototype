/**
 * State-machine transition tests. Focused on the CRITICAL-6 accepting edges: a
 * creator reply can arrive in OUTREACH_SENT (before the scheduler moved the
 * instance to AWAITING_REPLY) or mid-NEGOTIATING. Without a REPLY_RECEIVED edge
 * from those states, injectReply persisted the Message row and then threw on
 * assertTransition — losing the reply on retry. These assert the edges exist so a
 * reply is buffered, not dropped. Pure — no DB. Run:
 *   npx tsx src/engine/stateMachine.test.ts
 */

import assert from "node:assert/strict";
import { assertTransition, isTerminal, InvalidTransitionError } from "./stateMachine.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nstate machine — CRITICAL-6 accepting edges\n");

test("OUTREACH_SENT accepts a reply (→ REPLY_RECEIVED)", () => {
  // Must not throw — a reply that beats the scheduler's AWAITING_REPLY transition
  // is buffered, not dropped.
  assert.doesNotThrow(() => assertTransition("OUTREACH_SENT", "REPLY_RECEIVED"));
});

test("NEGOTIATING accepts a mid-negotiation reply (→ REPLY_RECEIVED)", () => {
  assert.doesNotThrow(() => assertTransition("NEGOTIATING", "REPLY_RECEIVED"));
});

test("AWAITING_REPLY / FOLLOWED_UP still accept a reply (unchanged)", () => {
  assert.doesNotThrow(() => assertTransition("AWAITING_REPLY", "REPLY_RECEIVED"));
  assert.doesNotThrow(() => assertTransition("FOLLOWED_UP", "REPLY_RECEIVED"));
});

test("REPLY_RECEIVED still routes onward (NEGOTIATING / REJECTED / …)", () => {
  assert.doesNotThrow(() => assertTransition("REPLY_RECEIVED", "NEGOTIATING"));
  assert.doesNotThrow(() => assertTransition("REPLY_RECEIVED", "REJECTED"));
});

test("an illegal transition still throws (guard intact)", () => {
  // A random illegal edge must still be rejected — the accepting edges are
  // additive, they don't open the machine up.
  assert.throws(() => assertTransition("CONTENT_BRIEF_SENT", "NEGOTIATING"), InvalidTransitionError);
});

test("terminal states have no outgoing edges", () => {
  for (const term of ["CONTENT_BRIEF_SENT", "REJECTED", "OPTED_OUT", "NO_RESPONSE", "MANUAL_REVIEW"] as const) {
    assert.equal(isTerminal(term), true);
    // Same-state no-op is allowed; any real move out of a terminal must throw.
    assert.throws(() => assertTransition(term, "NEGOTIATING"), InvalidTransitionError);
  }
});

console.log(`\n${n} passed\n`);
