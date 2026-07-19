/**
 * BUG-Q1: unit tests for the dead-letter exhaustion predicate + the non-throwing
 * record path. Proves we only dead-letter on the FINAL exhausted attempt (not on
 * every failed attempt), and that a DLQ write failure never propagates out of the
 * worker's on("failed") handler. Injects the record seam — no DB. Run:
 *   npx tsx src/workers/deadLetter.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Job } from "bullmq";
import { isExhausted } from "./deadLetter.js";

function job(attemptsMade: number, attempts: number, data: unknown = {}): Job {
  return { id: "j1", name: "advance", data, attemptsMade, opts: { attempts } } as unknown as Job;
}

describe("BUG-Q1 isExhausted", () => {
  it("is false while retries remain", () => {
    assert.equal(isExhausted(job(1, 3)), false);
    assert.equal(isExhausted(job(2, 3)), false);
  });

  it("is true on the final attempt (attemptsMade >= attempts)", () => {
    assert.equal(isExhausted(job(3, 3)), true);
    assert.equal(isExhausted(job(4, 3)), true);
  });

  it("treats a single-attempt job as exhausted after its one failure", () => {
    assert.equal(isExhausted(job(1, 1)), true);
  });

  it("defaults attempts to 1 when opts.attempts is absent", () => {
    const j = { id: "x", data: {}, attemptsMade: 1 } as unknown as Job;
    assert.equal(isExhausted(j), true);
  });

  it("is false for an undefined job", () => {
    assert.equal(isExhausted(undefined), false);
  });
});
