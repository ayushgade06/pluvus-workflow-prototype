/**
 * Unit tests for the env-aware AI-provider default (C1).
 * Pure resolution logic — run with:
 *   npx tsx src/engine/providerFactory.test.ts
 *
 * Regression target: the classification/negotiation providers used to default to
 * `mock`, so a process started without the provider env vars silently ran ZERO
 * LLM logic on a money path. The default is now env-aware: `mock` only under
 * NODE_ENV=test, `langgraph` otherwise. An explicit value always wins.
 */

import assert from "node:assert/strict";
import { resolveAgentMode } from "./providerFactory.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nproviderFactory resolveAgentMode (C1)\n");

test("unset provider defaults to langgraph in a non-test env", () => {
  assert.equal(resolveAgentMode(undefined, "production"), "langgraph");
  assert.equal(resolveAgentMode(undefined, undefined), "langgraph");
  assert.equal(resolveAgentMode(undefined, "development"), "langgraph");
});

test("unset provider defaults to mock under NODE_ENV=test", () => {
  assert.equal(resolveAgentMode(undefined, "test"), "mock");
  assert.equal(resolveAgentMode(undefined, "TEST"), "mock");
});

test("explicit langgraph is honored regardless of NODE_ENV", () => {
  assert.equal(resolveAgentMode("langgraph", "test"), "langgraph");
  assert.equal(resolveAgentMode("LangGraph", "production"), "langgraph");
});

test("explicit mock is honored regardless of NODE_ENV", () => {
  assert.equal(resolveAgentMode("mock", "production"), "mock");
  assert.equal(resolveAgentMode("MOCK", undefined), "mock");
});

test("unknown provider value falls back to the env-aware default", () => {
  // A typo like "langraph" should NOT silently disable the LLM in prod.
  assert.equal(resolveAgentMode("langraph", "production"), "langgraph");
  assert.equal(resolveAgentMode("langraph", "test"), "mock");
});

console.log(`\n${n} passed\n`);
