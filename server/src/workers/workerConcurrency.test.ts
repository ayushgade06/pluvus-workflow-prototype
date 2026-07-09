/**
 * HARD-S1: unit test for the env-tunable worker concurrency resolver.
 * Pure env logic — no Redis, no DB. Run with:
 *   npx tsx --test src/workers/workerConcurrency.test.ts
 *
 * Regression target: concurrency was hardcoded to 5/worker, so the whole system's
 * LLM throughput was pinned regardless of replica count or agent-service capacity.
 * It is now tunable per-worker via WORKER_CONCURRENCY / <WORKER>_CONCURRENCY.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { workerConcurrency } from "./queues.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("defaults to 5 when nothing is set", () => {
  withEnv({ WORKER_CONCURRENCY: undefined, NODE_EXECUTION_CONCURRENCY: undefined }, () => {
    assert.equal(workerConcurrency("NODE_EXECUTION_CONCURRENCY"), 5);
    assert.equal(workerConcurrency(), 5);
  });
});

test("WORKER_CONCURRENCY sets the base for all workers", () => {
  withEnv({ WORKER_CONCURRENCY: "12", NODE_EXECUTION_CONCURRENCY: undefined }, () => {
    assert.equal(workerConcurrency("NODE_EXECUTION_CONCURRENCY"), 12);
  });
});

test("a specific override wins over the base", () => {
  withEnv({ WORKER_CONCURRENCY: "8", NODE_EXECUTION_CONCURRENCY: "20" }, () => {
    assert.equal(workerConcurrency("NODE_EXECUTION_CONCURRENCY"), 20);
    // The base still applies to a worker without a specific override.
    assert.equal(workerConcurrency("INBOUND_EMAIL_CONCURRENCY"), 8);
  });
});

test("invalid / non-positive values fall back (never 0 or negative concurrency)", () => {
  withEnv({ WORKER_CONCURRENCY: "0", NODE_EXECUTION_CONCURRENCY: "-3" }, () => {
    assert.equal(workerConcurrency("NODE_EXECUTION_CONCURRENCY"), 5);
  });
  withEnv({ WORKER_CONCURRENCY: "abc", NODE_EXECUTION_CONCURRENCY: "1.5" }, () => {
    assert.equal(workerConcurrency("NODE_EXECUTION_CONCURRENCY"), 5);
  });
});
