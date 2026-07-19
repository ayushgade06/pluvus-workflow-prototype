/**
 * Unit tests for the rate-limit config parsing (BUG-SEC1).
 * Pure — exercises env parsing + defaults, no Express, no network.
 * Run via the tsx --test glob (npm test -w server).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { envInt, resolveRateLimitConfig } from "./rateLimit.js";

test("envInt: unset falls back", () => {
  assert.equal(envInt(undefined, 300), 300);
});

test("envInt: empty/whitespace falls back", () => {
  assert.equal(envInt("", 300), 300);
  assert.equal(envInt("   ", 300), 300);
});

test("envInt: valid integer parsed", () => {
  assert.equal(envInt("60", 300), 60);
});

test("envInt: zero is honoured (disables a bucket)", () => {
  assert.equal(envInt("0", 300), 0);
});

test("envInt: negative falls back (never a negative limit)", () => {
  assert.equal(envInt("-5", 300), 300);
});

test("envInt: non-numeric falls back", () => {
  assert.equal(envInt("abc", 300), 300);
});

test("envInt: floors a float", () => {
  assert.equal(envInt("60.9", 300), 60);
});

test("resolveRateLimitConfig: defaults when env empty", () => {
  const cfg = resolveRateLimitConfig({});
  assert.equal(cfg.globalWindowMs, 60_000);
  assert.equal(cfg.globalMax, 300);
  assert.equal(cfg.publicWindowMs, 60_000);
  assert.equal(cfg.publicMax, 60);
});

test("resolveRateLimitConfig: env overrides applied", () => {
  const cfg = resolveRateLimitConfig({
    RATE_LIMIT_WINDOW_MS: "30000",
    RATE_LIMIT_MAX: "100",
    PUBLIC_RATE_LIMIT_WINDOW_MS: "15000",
    PUBLIC_RATE_LIMIT_MAX: "10",
  });
  assert.equal(cfg.globalWindowMs, 30_000);
  assert.equal(cfg.globalMax, 100);
  assert.equal(cfg.publicWindowMs, 15_000);
  assert.equal(cfg.publicMax, 10);
});

test("resolveRateLimitConfig: *_MAX=0 disables a bucket", () => {
  const cfg = resolveRateLimitConfig({ PUBLIC_RATE_LIMIT_MAX: "0" });
  assert.equal(cfg.publicMax, 0);
});
