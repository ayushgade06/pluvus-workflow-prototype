/**
 * H7 — unknown negotiation outcome must NEVER guess a money state.
 *
 * Two layers defend the money path against an out-of-band `action`/`outcome`
 * arriving across the agent HTTP seam:
 *   1. mapNegotiationResponse (providers.ts) maps an unrecognized ACTION to the
 *      "escalate" outcome (this file's subject).
 *   2. executeNegotiation's switch has a `default` that routes any unrecognized
 *      OUTCOME to MANUAL_REVIEW instead of falling off the end and returning
 *      undefined (which would silently break the NodeResult contract).
 *
 * This test locks layer 1: a bogus action deterministically becomes "escalate"
 * (→ the executor then routes it to a human). No DB/model needed.
 *
 * Run: npx tsx --test src/engine/providers.negotiateOutcome.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mapNegotiationResponse } from "./providers.js";

test("H7: an unrecognized action maps to 'escalate' (never a money outcome)", () => {
  const result = mapNegotiationResponse(
    { action: "TOTALLY_BOGUS_ACTION", reasoning: "who knows" },
    2,
  );
  assert.equal(result.outcome, "escalate", "unknown action → escalate to a human");
});

test("H7: an unrecognized action carries a message rather than throwing", () => {
  const result = mapNegotiationResponse({ action: "42" as unknown as string }, 0);
  assert.equal(result.outcome, "escalate");
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0, "there is a human-readable reason");
});

test("H7: a known action still maps normally (default arm doesn't over-trigger)", () => {
  const accept = mapNegotiationResponse({ action: "ACCEPT", proposedTerms: { rate: 300 } }, 1);
  assert.equal(accept.outcome, "accept");
  assert.equal(accept.proposedRate, 300);

  const counter = mapNegotiationResponse({ action: "COUNTER", proposedTerms: { rate: 350 } }, 1);
  assert.equal(counter.outcome, "counter");
  assert.equal(counter.proposedRate, 350);

  const escalate = mapNegotiationResponse({ action: "ESCALATE", reasoning: "over ceiling" }, 3);
  assert.equal(escalate.outcome, "escalate");
});
