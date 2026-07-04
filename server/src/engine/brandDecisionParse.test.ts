/**
 * Unit tests for the deterministic brand-decision token scanner (§2.4). Pure —
 * no DB, no network, no agent. Proves that an explicit cue in the brand's reply
 * resolves to the right action (and amount) WITHOUT an AI hop, and that the
 * ambiguous / no-cue cases fall through to null so the AI fallback runs.
 *
 * Run with:  npx tsx src/engine/brandDecisionParse.test.ts
 */

import assert from "node:assert/strict";
import { scanBrandDecisionTokens } from "./brandDecisionParse.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nbrand-decision deterministic token scan\n");

// ── APPROVE ─────────────────────────────────────────────────────────────────
test("bare APPROVE resolves to APPROVE (confidence 1, source token)", () => {
  const r = scanBrandDecisionTokens("APPROVE");
  assert.equal(r?.decision, "APPROVE");
  assert.equal(r?.confidence, 1);
  assert.equal(r?.source, "token");
});

test("'yes, go ahead' resolves to APPROVE", () => {
  assert.equal(scanBrandDecisionTokens("yes, go ahead")?.decision, "APPROVE");
});

// ── REJECT (and precedence over a stray affirmative) ─────────────────────────
test("REJECT resolves to REJECT", () => {
  assert.equal(scanBrandDecisionTokens("REJECT")?.decision, "REJECT");
});

test("'pass on this one' resolves to REJECT", () => {
  assert.equal(scanBrandDecisionTokens("let's pass on this one")?.decision, "REJECT");
});

// ── HANDOFF (wins over a stray affirmative) ──────────────────────────────────
test("HANDOFF resolves to HANDOFF", () => {
  assert.equal(scanBrandDecisionTokens("HANDOFF")?.decision, "HANDOFF");
});

test("'no, hand this to a human' → HANDOFF (handoff/reject before approve)", () => {
  // Contains no APPROVE synonym; 'human' triggers HANDOFF, and HANDOFF is
  // checked before REJECT here — either way it must NOT read as APPROVE.
  const r = scanBrandDecisionTokens("please have a human take over");
  assert.equal(r?.decision, "HANDOFF");
});

// ── COUNTER (requires a number) ──────────────────────────────────────────────
test("'COUNTER 350' resolves to COUNTER with value 350", () => {
  const r = scanBrandDecisionTokens("COUNTER 350");
  assert.equal(r?.decision, "COUNTER");
  assert.equal(r?.value, 350);
});

test("'counter at $1,200' parses the comma amount", () => {
  const r = scanBrandDecisionTokens("counter at $1,200 and that's final");
  assert.equal(r?.decision, "COUNTER");
  assert.equal(r?.value, 1200);
});

test("'COUNTER' with no number falls through to null (AI fallback / re-ask)", () => {
  assert.equal(scanBrandDecisionTokens("let's counter"), null);
});

// ── No cue → null (AI fallback) ──────────────────────────────────────────────
test("free-text with no cue returns null", () => {
  assert.equal(scanBrandDecisionTokens("hmm, not sure, what do you think?"), null);
});

test("empty body returns null", () => {
  assert.equal(scanBrandDecisionTokens(""), null);
});

console.log(`\n${n} passed\n`);
