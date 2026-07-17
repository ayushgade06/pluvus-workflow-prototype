// P4 — the daily spend MONITOR predicate. Pure (no DB): given trailing-24h spend
// and the raw LLM_DAILY_SPEND_ALERT_USD env string, decide whether the daily
// budget is crossed. Unset/blank/invalid ⇒ guard off, so local Ollama ($0) and
// deployments that haven't opted in are never flagged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSpendGuard } from "./repository.js";

test("P4: unset threshold disables the guard (never exceeded)", () => {
  const g = computeSpendGuard(9999, undefined);
  assert.equal(g.thresholdUsd, null);
  assert.equal(g.exceeded, false);
  assert.equal(g.ratio, null);
  assert.equal(g.spentUsd, 9999);
});

test("P4: blank / non-numeric / non-positive threshold disables the guard", () => {
  for (const raw of ["", "   ", "abc", "0", "-5", "NaN"]) {
    const g = computeSpendGuard(100, raw);
    assert.equal(g.thresholdUsd, null, `raw=${JSON.stringify(raw)}`);
    assert.equal(g.exceeded, false, `raw=${JSON.stringify(raw)}`);
  }
});

test("P4: spend under the threshold is not exceeded", () => {
  const g = computeSpendGuard(10, "25");
  assert.equal(g.thresholdUsd, 25);
  assert.equal(g.exceeded, false);
  assert.equal(g.spentUsd, 10);
  assert.equal(g.ratio, 0.4);
});

test("P4: spend over the threshold is exceeded", () => {
  const g = computeSpendGuard(30, "25");
  assert.equal(g.thresholdUsd, 25);
  assert.equal(g.exceeded, true);
  assert.equal(g.ratio, 1.2);
});

test("P4: exactly at the threshold is NOT exceeded (strict >)", () => {
  const g = computeSpendGuard(25, "25");
  assert.equal(g.exceeded, false);
  assert.equal(g.ratio, 1);
});

test("P4: zero spend against a set threshold reports off-but-armed", () => {
  const g = computeSpendGuard(0, "25");
  assert.equal(g.thresholdUsd, 25);
  assert.equal(g.exceeded, false);
  assert.equal(g.spentUsd, 0);
  assert.equal(g.ratio, 0);
});

test("P4: spend + ratio are rounded to 6 dp", () => {
  const g = computeSpendGuard(1 / 3, "1");
  assert.equal(g.spentUsd, 0.333333);
  assert.equal(g.ratio, 0.333333);
});

test("P4: a threshold with surrounding whitespace still parses", () => {
  const g = computeSpendGuard(50, "  25  ");
  assert.equal(g.thresholdUsd, 25);
  assert.equal(g.exceeded, true);
});
