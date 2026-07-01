/**
 * Unit tests for stampRewardFromNegotiation — mirrors the brand's negotiation
 * commission onto the Reward Setup node so the builder + runtime always show the
 * CURRENT value (not a frozen copy). Pure — no DB, no network. Run:
 *   npx tsx src/routes/stampRewardCommission.test.ts
 */

import assert from "node:assert/strict";
import { stampRewardFromNegotiation } from "./workflows.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

type Node = { id: string; type: string; order: number; config: Record<string, unknown> };

function graph(commission: number | undefined): Node[] {
  return [
    { id: "neg", type: "NEGOTIATION", order: 0, config: commission === undefined ? {} : { commissionRate: commission } },
    { id: "reward", type: "REWARD_SETUP", order: 1, config: {} },
  ];
}

function rewardConfig(nodes: unknown): Record<string, unknown> {
  const arr = nodes as Node[];
  return arr.find((x) => x.type === "REWARD_SETUP")!.config;
}

console.log("\nstampRewardFromNegotiation\n");

test("copies the negotiation commission onto the reward node", () => {
  const out = stampRewardFromNegotiation(graph(20));
  assert.equal(rewardConfig(out)["commissionRate"], 20);
});

test("tracks an edited commission (overwrites a stale value)", () => {
  const nodes = graph(25);
  // Simulate a stale 10% already on the reward node.
  (nodes[1] as Node).config = { commissionRate: 10, brandName: "Acme" };
  const out = stampRewardFromNegotiation(nodes);
  assert.equal(rewardConfig(out)["commissionRate"], 25);
  // Unrelated reward-node config is preserved.
  assert.equal(rewardConfig(out)["brandName"], "Acme");
});

test("removes commission when the negotiation has none (fixed-fee deal)", () => {
  const nodes = graph(undefined);
  (nodes[1] as Node).config = { commissionRate: 10 }; // stale
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false);
});

test("commission of 0 is treated as no commission", () => {
  const out = stampRewardFromNegotiation(graph(0));
  assert.equal("commissionRate" in rewardConfig(out), false);
});

test("leaves non-reward nodes untouched", () => {
  const out = stampRewardFromNegotiation(graph(15)) as Node[];
  const neg = out.find((x) => x.type === "NEGOTIATION")!;
  assert.equal(neg.config["commissionRate"], 15);
  assert.equal("commissionRate" in neg.config, true);
});

test("no negotiation node → reward node commission cleared, no crash", () => {
  const nodes: Node[] = [{ id: "reward", type: "REWARD_SETUP", order: 0, config: { commissionRate: 12 } }];
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false);
});

console.log(`\n${n} passed\n`);
