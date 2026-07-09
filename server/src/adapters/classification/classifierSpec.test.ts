/**
 * MED-A2 — the TS mock classifier is built from shared/classifier-spec.json and
 * must classify the spec's `fixture` exactly as labeled. This is the TS half of
 * the cross-language drift guard (the Python half is
 * agent/tests/test_classifier_spec_parity.py). Together they ensure a gate edit
 * on either side that isn't reflected in the shared spec fails a test.
 * Run:  npx tsx src/adapters/classification/classifierSpec.test.ts
 */

import assert from "node:assert/strict";
import { loadClassifierSpec, compiledGates, type FixtureCase } from "./classifierSpec.js";
import { MockClassificationProvider } from "./MockClassificationProvider.js";

let n = 0;
function test(name: string, fn: () => void | Promise<void>): void {
  const r = fn();
  if (r instanceof Promise) throw new Error(`${name}: use runAsync for async tests`);
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nclassifierSpec (MED-A2)\n");

test("spec loads with the four ordered gates", () => {
  const spec = loadClassifierSpec();
  assert.deepEqual(spec.order, ["opt_out", "injection", "rate", "question"]);
});

test("gates compile without error", () => {
  const g = compiledGates();
  assert.ok(g.optOut.length > 0 && g.injection.length > 0 && g.rate.length > 0);
});

// The mock's public API is classify() → intent. Map each fixture gate to the
// intent + confidence the mock must return when that gate fires (mirrors
// classify.py). "none" means no deterministic gate fired (keyword fallthrough),
// so we only assert that NONE of the four gate-intents at confidence 1.0 fired
// spuriously.
const GATE_TO_INTENT: Record<string, { intent: string; confidence: number }> = {
  opt_out: { intent: "OPT_OUT", confidence: 1.0 },
  injection: { intent: "UNKNOWN", confidence: 0.0 },
  rate: { intent: "POSITIVE", confidence: 1.0 },
  question: { intent: "QUESTION", confidence: 1.0 },
};

async function runFixture(): Promise<void> {
  const spec = loadClassifierSpec();
  const provider = new MockClassificationProvider();
  for (const c of spec.fixture as FixtureCase[]) {
    const res = await provider.classify({ message: c.text });
    if (c.gate === "none") {
      // No deterministic gate should have fired at confidence 1.0.
      const firedGate =
        res.confidence === 1.0 &&
        ["OPT_OUT", "POSITIVE", "QUESTION"].includes(res.intent);
      assert.equal(firedGate, false, `expected no gate for "${c.text}", got ${res.intent}`);
      continue;
    }
    const expected = GATE_TO_INTENT[c.gate]!;
    assert.equal(res.intent, expected.intent, `"${c.text}" → ${res.intent}, want ${expected.intent}`);
    assert.equal(
      res.confidence,
      expected.confidence,
      `"${c.text}" confidence ${res.confidence}, want ${expected.confidence}`,
    );
  }
  n++;
  console.log(`  ✓ every fixture case classifies as the spec labels it`);
}

await runFixture();

console.log(`\n${n} passed\n`);
