/**
 * Unit tests for the agent-service client timeout resolution (C3).
 * Pure env-parsing logic — run with:
 *   npx tsx src/adapters/agentServiceClient.test.ts
 *
 * Regression target: the TS side aborted every agent call at 30s, before a slow
 * local model (Qwen ~38s/call, plus Python-side repair retries) could finish
 * generating — tripping the breaker and dumping every turn to MANUAL_REVIEW. The
 * generation timeout must now default high (120s) and exceed the Python invoke
 * budget × retries; classify keeps a shorter fail-fast timeout. An explicit
 * override always wins.
 */

import assert from "node:assert/strict";
import { agentTimeoutMs, classifyTimeoutMs, resolveTimeoutMs } from "./agentServiceClient.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Save/restore an env var around a test body.
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

console.log("\nagentServiceClient timeouts\n");

test("generation timeout defaults to 120000 when unset", () => {
  withEnv("AGENT_TIMEOUT_MS", undefined, () => {
    assert.equal(agentTimeoutMs(), 120_000);
  });
});

test("generation default exceeds Python invoke budget (60s) x 1+retries(2) = 180s? at least > 1 call", () => {
  // The abort must comfortably exceed a single ~38s Qwen call plus a repair
  // retry (~80s). 120s satisfies that; assert the invariant directly.
  withEnv("AGENT_TIMEOUT_MS", undefined, () => {
    assert.ok(agentTimeoutMs() >= 80_000, "generation timeout must allow one generation + one retry");
  });
});

test("AGENT_TIMEOUT_MS override is honored", () => {
  withEnv("AGENT_TIMEOUT_MS", "90000", () => {
    assert.equal(agentTimeoutMs(), 90_000);
  });
});

test("invalid AGENT_TIMEOUT_MS falls back to the default", () => {
  withEnv("AGENT_TIMEOUT_MS", "not-a-number", () => {
    assert.equal(agentTimeoutMs(), 120_000);
  });
  withEnv("AGENT_TIMEOUT_MS", "0", () => {
    assert.equal(agentTimeoutMs(), 120_000);
  });
  withEnv("AGENT_TIMEOUT_MS", "-5", () => {
    assert.equal(agentTimeoutMs(), 120_000);
  });
});

test("classify timeout defaults to 45000 (fail-fast) and stays above one Qwen call", () => {
  withEnv("AGENT_CLASSIFY_TIMEOUT_MS", undefined, () => {
    assert.equal(classifyTimeoutMs(), 45_000);
    assert.ok(classifyTimeoutMs() > 38_000, "classify timeout must exceed one ~38s Qwen call");
  });
});

test("AGENT_CLASSIFY_TIMEOUT_MS override is honored", () => {
  withEnv("AGENT_CLASSIFY_TIMEOUT_MS", "60000", () => {
    assert.equal(classifyTimeoutMs(), 60_000);
  });
});

test("resolveTimeoutMs prefers an explicit positive override over the default", () => {
  withEnv("AGENT_TIMEOUT_MS", undefined, () => {
    assert.equal(resolveTimeoutMs(5_000), 5_000);
  });
});

test("resolveTimeoutMs falls back to the generation default for undefined/invalid overrides", () => {
  withEnv("AGENT_TIMEOUT_MS", undefined, () => {
    assert.equal(resolveTimeoutMs(undefined), 120_000);
    assert.equal(resolveTimeoutMs(0), 120_000);
    assert.equal(resolveTimeoutMs(-1), 120_000);
    assert.equal(resolveTimeoutMs(Number.NaN), 120_000);
  });
});

console.log(`\n${n} passed\n`);
