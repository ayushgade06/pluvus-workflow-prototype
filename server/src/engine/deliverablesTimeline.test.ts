/**
 * Verifies brand-supplied deliverables/timeline thread from NEGOTIATION node
 * config into the NegotiationRequest.campaignConstraints (the shape sent to the
 * agent's /negotiate). Pure — no DB, no agent. Run:
 *   npx tsx src/engine/deliverablesTimeline.test.ts
 */

import assert from "node:assert/strict";
import { buildNegotiationRequest } from "./providers.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\ndeliverables/timeline threading\n");

test("config deliverables + timeline reach campaignConstraints", () => {
  const req = buildNegotiationRequest(
    0,
    {
      minBudget: 500,
      maxBudget: 2000,
      deliverables: "3 IG Reels + 1 YouTube integration",
      timeline: "Content live by Sept 15, 2026",
    },
    "Sounds interesting, what's involved?",
  );
  assert.equal(req.campaignConstraints.deliverables, "3 IG Reels + 1 YouTube integration");
  assert.equal(req.campaignConstraints.timeline, "Content live by Sept 15, 2026");
});

test("absent fields are omitted (not empty strings)", () => {
  const req = buildNegotiationRequest(0, { minBudget: 500, maxBudget: 2000 }, "hi");
  assert.equal("deliverables" in req.campaignConstraints, false);
  assert.equal("timeline" in req.campaignConstraints, false);
});

test("non-string config values are ignored", () => {
  const req = buildNegotiationRequest(
    0,
    { minBudget: 500, maxBudget: 2000, deliverables: 123, timeline: null },
    "hi",
  );
  assert.equal("deliverables" in req.campaignConstraints, false);
  assert.equal("timeline" in req.campaignConstraints, false);
});

test("only one field supplied threads just that one", () => {
  const req = buildNegotiationRequest(
    0,
    { minBudget: 500, maxBudget: 2000, deliverables: "1 TikTok" },
    "hi",
  );
  assert.equal(req.campaignConstraints.deliverables, "1 TikTok");
  assert.equal("timeline" in req.campaignConstraints, false);
});

console.log(`\n${n} passed\n`);
