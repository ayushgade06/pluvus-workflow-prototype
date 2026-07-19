/**
 * Unit tests for the Nylas webhook replay guard (BUG-SEC4).
 * Pure — injectable clock + config, no Express, no network.
 * Run via the tsx --test glob (npm test -w server).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractDeliveryTime,
  isFreshDelivery,
  resolveMaxAgeSeconds,
  SeenDeliveryIds,
} from "./replayGuard.js";

// ── resolveMaxAgeSeconds ────────────────────────────────────────────────────

test("resolveMaxAgeSeconds: default 300 when unset", () => {
  assert.equal(resolveMaxAgeSeconds({}), 300);
});

test("resolveMaxAgeSeconds: env override", () => {
  assert.equal(resolveMaxAgeSeconds({ WEBHOOK_MAX_AGE_SECONDS: "120" }), 120);
});

test("resolveMaxAgeSeconds: 0 disables the check", () => {
  assert.equal(resolveMaxAgeSeconds({ WEBHOOK_MAX_AGE_SECONDS: "0" }), 0);
});

test("resolveMaxAgeSeconds: invalid falls back to 300", () => {
  assert.equal(resolveMaxAgeSeconds({ WEBHOOK_MAX_AGE_SECONDS: "abc" }), 300);
  assert.equal(resolveMaxAgeSeconds({ WEBHOOK_MAX_AGE_SECONDS: "-5" }), 300);
});

// ── extractDeliveryTime ─────────────────────────────────────────────────────

test("extractDeliveryTime: reads top-level numeric time", () => {
  assert.equal(extractDeliveryTime({ time: 1_700_000_000, data: {} }), 1_700_000_000);
});

test("extractDeliveryTime: undefined when absent or non-numeric", () => {
  assert.equal(extractDeliveryTime({ data: {} }), undefined);
  assert.equal(extractDeliveryTime({ time: "nope" }), undefined);
  assert.equal(extractDeliveryTime(null), undefined);
});

// ── isFreshDelivery ─────────────────────────────────────────────────────────

const NOW_SEC = 1_700_000_000;
const NOW_MS = NOW_SEC * 1000;

test("isFreshDelivery: a recent delivery is fresh", () => {
  assert.equal(isFreshDelivery(NOW_SEC - 60, NOW_MS, 300), true);
});

test("isFreshDelivery: a delivery older than the window is stale", () => {
  assert.equal(isFreshDelivery(NOW_SEC - 600, NOW_MS, 300), false);
});

test("isFreshDelivery: absent time fails OPEN (backstopped by seen-id)", () => {
  assert.equal(isFreshDelivery(undefined, NOW_MS, 300), true);
});

test("isFreshDelivery: maxAge=0 disables the check", () => {
  assert.equal(isFreshDelivery(NOW_SEC - 999_999, NOW_MS, 0), true);
});

test("isFreshDelivery: a far-future skew is also rejected", () => {
  assert.equal(isFreshDelivery(NOW_SEC + 600, NOW_MS, 300), false);
});

// ── SeenDeliveryIds ─────────────────────────────────────────────────────────

test("SeenDeliveryIds: first add accepts, repeat rejects", () => {
  const s = new SeenDeliveryIds();
  assert.equal(s.add("msg-1"), true);
  assert.equal(s.add("msg-1"), false);
  assert.equal(s.add("msg-2"), true);
});

test("SeenDeliveryIds: evicts oldest past capacity", () => {
  const s = new SeenDeliveryIds(2);
  s.add("a");
  s.add("b");
  s.add("c"); // evicts "a"
  assert.equal(s.has("a"), false);
  assert.equal(s.has("b"), true);
  assert.equal(s.has("c"), true);
  // "a" can be re-added (it was evicted) — accepted as new.
  assert.equal(s.add("a"), true);
});
