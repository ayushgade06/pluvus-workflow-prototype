/**
 * W-4 — the queue-injection (mutation) endpoints must not be reachable on an
 * exposed production port.
 *
 * POST /queues/node-execution and POST /queues/inbound-email enqueue REAL jobs
 * that drive the live state machine — and inbound-email can force a `mockIntent`
 * that fabricates a creator's "acceptance" (a forged money-path input). This
 * locks the gating predicate: enabled ONLY under NODE_ENV=test or an explicit
 * ENABLE_QUEUE_INJECTION=true dev opt-in; disabled (→ 404) everywhere else.
 *
 * Run: npx tsx --test src/routes/queues.injectionGate.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { queueInjectionAllowed } from "./queues.js";

test("W-4: enabled under NODE_ENV=test (so the existing suites/harnesses still inject)", () => {
  assert.equal(queueInjectionAllowed("test", undefined), true);
  assert.equal(queueInjectionAllowed("TEST", undefined), true);
});

test("W-4: disabled in production by default — the forge surface is a 404", () => {
  assert.equal(queueInjectionAllowed("production", undefined), false);
  assert.equal(queueInjectionAllowed("production", ""), false);
  assert.equal(queueInjectionAllowed(undefined, undefined), false);
});

test("W-4: disabled in development by default (still not reachable without opt-in)", () => {
  assert.equal(queueInjectionAllowed("development", undefined), false);
});

test("W-4: explicit ENABLE_QUEUE_INJECTION=true opts a trusted dev box in", () => {
  assert.equal(queueInjectionAllowed("development", "true"), true);
  assert.equal(queueInjectionAllowed("production", "TRUE"), true);
});

test("W-4: only the literal true opts in — a stray value does not", () => {
  assert.equal(queueInjectionAllowed("production", "1"), false);
  assert.equal(queueInjectionAllowed("production", "yes"), false);
});
