/**
 * Unit tests for the negotiation price-band resolver.
 * Pure logic — run with:
 *   npx tsx src/engine/band.test.ts
 *
 * Regression target: a Workflow Builder UI / template config carries the band
 * as minBudget/maxBudget, but the negotiation request builder and output guard
 * historically only read termFloor/termCeiling — so the band never reached the
 * agent (floor 0 / ceiling +inf) and the accept/counter/escalate logic was
 * inert. resolveBand bridges both shapes; these tests lock that in.
 */

import assert from "node:assert/strict";
import { resolveBand } from "./band.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nband resolver\n");

// ── termFloor/termCeiling shape (seed snapshots) ──────────────────────────────
test("reads termFloor/termCeiling rate", () => {
  const b = resolveBand({ termFloor: { rate: 200 }, termCeiling: { rate: 500 } });
  assert.equal(b.floor, 200);
  assert.equal(b.ceiling, 500);
  assert.equal(b.termFloor.rate, 200);
  assert.equal(b.termCeiling.rate, 500);
});

// ── minBudget/maxBudget shape (UI + templates) — THE bug being fixed ──────────
test("reads minBudget/maxBudget when termFloor/termCeiling absent", () => {
  const b = resolveBand({ minBudget: 200, maxBudget: 500 });
  assert.equal(b.floor, 200, "minBudget must resolve to floor");
  assert.equal(b.ceiling, 500, "maxBudget must resolve to ceiling");
  assert.equal(b.termFloor.rate, 200);
  assert.equal(b.termCeiling.rate, 500);
});

test("UI config produces a non-empty band (regression: was {} → 0/+inf)", () => {
  const uiConfig = {
    brandName: "Towel",
    minBudget: 200,
    maxBudget: 500,
    maxRounds: 4,
    senderName: "Towel",
    approvalMode: "auto",
    commissionRate: 10,
  };
  const b = resolveBand(uiConfig);
  assert.notEqual(b.floor, undefined, "floor must be resolved from minBudget");
  assert.notEqual(b.ceiling, undefined, "ceiling must be resolved from maxBudget");
  assert.equal(b.floor, 200);
  assert.equal(b.ceiling, 500);
});

// ── precedence ────────────────────────────────────────────────────────────────
test("termFloor/termCeiling take precedence over minBudget/maxBudget", () => {
  const b = resolveBand({
    termFloor: { rate: 500 },
    termCeiling: { rate: 2000 },
    minBudget: 200,
    maxBudget: 500,
  });
  assert.equal(b.floor, 500);
  assert.equal(b.ceiling, 2000);
});

test("preserves extra term fields while injecting the rate", () => {
  const b = resolveBand({
    termFloor: { rate: 200, deliverables: ["1 post"] },
    termCeiling: { rate: 500 },
  });
  assert.deepEqual(b.termFloor.deliverables, ["1 post"]);
  assert.equal(b.termFloor.rate, 200);
});

// ── unconfigured node — defaulting behaviour unchanged ────────────────────────
test("empty config yields empty terms (downstream defaults to 0 / +inf)", () => {
  const b = resolveBand({});
  assert.equal(b.floor, undefined);
  assert.equal(b.ceiling, undefined);
  assert.deepEqual(b.termFloor, {});
  assert.deepEqual(b.termCeiling, {});
});

test("non-finite / non-number budgets are ignored", () => {
  const b = resolveBand({ minBudget: "200", maxBudget: NaN });
  assert.equal(b.floor, undefined, "string minBudget must not resolve");
  assert.equal(b.ceiling, undefined, "NaN maxBudget must not resolve");
});

test("partial band — only maxBudget set", () => {
  const b = resolveBand({ maxBudget: 500 });
  assert.equal(b.floor, undefined);
  assert.equal(b.ceiling, 500);
});

console.log(`\n${n} passed\n`);
