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
import { resolveAgentMode, emailProvider } from "./providerFactory.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Run a body with EMAIL_PROVIDER + NODE_ENV temporarily set, then restore both.
function withEnv(
  env: { EMAIL_PROVIDER?: string | undefined; NODE_ENV?: string | undefined },
  fn: () => void,
): void {
  const prevEmail = process.env["EMAIL_PROVIDER"];
  const prevNode = process.env["NODE_ENV"];
  try {
    if ("EMAIL_PROVIDER" in env) {
      if (env.EMAIL_PROVIDER === undefined) delete process.env["EMAIL_PROVIDER"];
      else process.env["EMAIL_PROVIDER"] = env.EMAIL_PROVIDER;
    }
    if ("NODE_ENV" in env) {
      if (env.NODE_ENV === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = env.NODE_ENV;
    }
    fn();
  } finally {
    if (prevEmail === undefined) delete process.env["EMAIL_PROVIDER"];
    else process.env["EMAIL_PROVIDER"] = prevEmail;
    if (prevNode === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = prevNode;
  }
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

console.log("\nproviderFactory emailProvider fail-fast (MED-A1)\n");

test("unset EMAIL_PROVIDER outside test THROWS (no silent mock)", () => {
  // A misconfigured prod deploy that forgot EMAIL_PROVIDER used to advance the
  // whole funnel while sending zero real emails — now it fails fast.
  withEnv({ EMAIL_PROVIDER: undefined, NODE_ENV: "production" }, () => {
    assert.throws(() => emailProvider(), /EMAIL_PROVIDER is not set/);
  });
});

test("unset EMAIL_PROVIDER under NODE_ENV=test returns the mock", () => {
  withEnv({ EMAIL_PROVIDER: undefined, NODE_ENV: "test" }, () => {
    assert.doesNotThrow(() => emailProvider());
  });
});

test("explicit EMAIL_PROVIDER=mock is honored (opt-in)", () => {
  withEnv({ EMAIL_PROVIDER: "mock", NODE_ENV: "production" }, () => {
    assert.doesNotThrow(() => emailProvider());
  });
});

test("an unknown EMAIL_PROVIDER value THROWS rather than silently no-op'ing", () => {
  withEnv({ EMAIL_PROVIDER: "nlyas", NODE_ENV: "test" }, () => {
    assert.throws(() => emailProvider(), /Unknown EMAIL_PROVIDER/);
  });
});

console.log(`\n${n} passed\n`);
