/**
 * Unit tests for process-role resolution (HARD-A1). Pure — no env mutation
 * needed; resolveProcessRole is a pure function of its argument.
 * Run:  npx tsx src/processRole.test.ts
 */

import assert from "node:assert/strict";
import {
  resolveProcessRole,
  runsApi,
  runsWorkers,
  runsScheduler,
} from "./processRole.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nprocessRole (HARD-A1)\n");

test("explicit roles resolve as-is (case-insensitive, trimmed)", () => {
  assert.equal(resolveProcessRole("api"), "api");
  assert.equal(resolveProcessRole("WORKER"), "worker");
  assert.equal(resolveProcessRole("  scheduler "), "scheduler");
  assert.equal(resolveProcessRole("all"), "all");
});

test("unset / blank / unknown defaults to all (backward-compatible)", () => {
  assert.equal(resolveProcessRole(undefined), "all");
  assert.equal(resolveProcessRole(""), "all");
  assert.equal(resolveProcessRole("   "), "all");
  assert.equal(resolveProcessRole("typo"), "all");
});

test("api role runs ONLY the API", () => {
  assert.equal(runsApi("api"), true);
  assert.equal(runsWorkers("api"), false);
  assert.equal(runsScheduler("api"), false);
});

test("worker role runs ONLY the workers", () => {
  assert.equal(runsApi("worker"), false);
  assert.equal(runsWorkers("worker"), true);
  assert.equal(runsScheduler("worker"), false);
});

test("scheduler role runs ONLY the scheduler", () => {
  assert.equal(runsApi("scheduler"), false);
  assert.equal(runsWorkers("scheduler"), false);
  assert.equal(runsScheduler("scheduler"), true);
});

test("all role runs everything (the default single-process behavior)", () => {
  assert.equal(runsApi("all"), true);
  assert.equal(runsWorkers("all"), true);
  assert.equal(runsScheduler("all"), true);
});

console.log(`\n${n} passed\n`);
