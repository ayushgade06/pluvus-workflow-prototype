/**
 * Unit tests for the circuit breaker (FIX-9).
 * Pure logic, injectable clock — run with:
 *   npx tsx src/adapters/circuitBreaker.test.ts
 */

import assert from "node:assert/strict";
import { CircuitBreaker, OpenCircuitError } from "./circuitBreaker.js";

let n = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    n++;
    console.log(`  ✓ ${name}`);
  });
}

// A controllable clock so we never sleep.
function clock(start = 0) {
  const c = { t: start };
  return { now: () => c.t, advance: (ms: number) => (c.t += ms) };
}

const ok = async () => "ok";
const fail = async () => {
  throw new Error("boom");
};

async function main() {
  console.log("\ncircuitBreaker\n");

  await test("passes through while closed", async () => {
    const cb = new CircuitBreaker("t", { failureThreshold: 3 });
    assert.equal(await cb.run(ok), "ok");
    assert.equal(cb.currentState(), "closed");
  });

  await test("opens after N consecutive failures", async () => {
    const cb = new CircuitBreaker("t", { failureThreshold: 3, cooldownMs: 1000 });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(cb.run(fail), /boom/);
    }
    assert.equal(cb.currentState(), "open");
  });

  await test("open circuit fast-fails with OpenCircuitError (no fn call)", async () => {
    const cb = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 10_000 });
    await assert.rejects(cb.run(fail), /boom/); // trips open
    let called = false;
    await assert.rejects(
      cb.run(async () => {
        called = true;
        return "x";
      }),
      OpenCircuitError,
    );
    assert.equal(called, false, "fn must not run while open");
  });

  await test("a success resets the consecutive-failure count", async () => {
    const cb = new CircuitBreaker("t", { failureThreshold: 3 });
    await assert.rejects(cb.run(fail), /boom/);
    await assert.rejects(cb.run(fail), /boom/);
    await cb.run(ok); // resets count
    await assert.rejects(cb.run(fail), /boom/);
    await assert.rejects(cb.run(fail), /boom/);
    assert.equal(cb.currentState(), "closed", "two failures after reset must not open (threshold 3)");
  });

  await test("transitions to half-open after cooldown", async () => {
    const ck = clock();
    const cb = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 1000, now: ck.now });
    await assert.rejects(cb.run(fail), /boom/); // open at t=0
    assert.equal(cb.currentState(), "open");
    ck.advance(1000);
    assert.equal(cb.currentState(), "half-open");
  });

  await test("successful probe in half-open closes the breaker", async () => {
    const ck = clock();
    const cb = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 1000, now: ck.now });
    await assert.rejects(cb.run(fail), /boom/);
    ck.advance(1000);
    assert.equal(await cb.run(ok), "ok");
    assert.equal(cb.currentState(), "closed");
  });

  await test("failed probe in half-open re-opens immediately", async () => {
    const ck = clock();
    const cb = new CircuitBreaker("t", { failureThreshold: 5, cooldownMs: 1000, now: ck.now });
    // Trip to open via a single half-open failure path: first reach open.
    for (let i = 0; i < 5; i++) await assert.rejects(cb.run(fail), /boom/);
    assert.equal(cb.currentState(), "open");
    ck.advance(1000);
    assert.equal(cb.currentState(), "half-open");
    await assert.rejects(cb.run(fail), /boom/); // probe fails
    assert.equal(cb.currentState(), "open", "a failed probe must re-open without N more failures");
  });

  await test("reset() returns a tripped breaker to closed", async () => {
    const cb = new CircuitBreaker("t", { failureThreshold: 1, cooldownMs: 10_000 });
    await assert.rejects(cb.run(fail), /boom/);
    assert.equal(cb.currentState(), "open");
    cb.reset();
    assert.equal(cb.currentState(), "closed");
    assert.equal(await cb.run(ok), "ok");
  });

  console.log(`\n✓ circuitBreaker: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
