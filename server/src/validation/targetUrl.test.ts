/**
 * Unit tests for targetUrl validation (BUG-SEC5 — open-redirect / SSRF).
 * Pure — run via the tsx --test glob (npm test -w server).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateTargetUrl, isSafeRedirectUrl } from "./targetUrl.js";

// ── validateTargetUrl: allowed ──────────────────────────────────────────────

test("null/undefined/empty is allowed (no target)", () => {
  assert.equal(validateTargetUrl(null).valid, true);
  assert.equal(validateTargetUrl(undefined).valid, true);
  assert.equal(validateTargetUrl("").valid, true);
  assert.equal(validateTargetUrl("   ").valid, true);
});

test("https URL is accepted and normalized", () => {
  const r = validateTargetUrl("https://example.com/shop");
  assert.equal(r.valid, true);
  assert.equal(r.url, "https://example.com/shop");
});

test("http URL is accepted", () => {
  assert.equal(validateTargetUrl("http://example.com").valid, true);
});

// ── validateTargetUrl: rejected schemes ─────────────────────────────────────

test("javascript: scheme is rejected", () => {
  const r = validateTargetUrl("javascript:alert(1)");
  assert.equal(r.valid, false);
  assert.ok(r.reason?.includes("http"));
});

test("data: scheme is rejected", () => {
  assert.equal(validateTargetUrl("data:text/html,<script>alert(1)</script>").valid, false);
});

test("file: scheme is rejected", () => {
  assert.equal(validateTargetUrl("file:///etc/passwd").valid, false);
});

test("ftp: scheme is rejected", () => {
  assert.equal(validateTargetUrl("ftp://example.com/x").valid, false);
});

test("unparseable string is rejected", () => {
  const r = validateTargetUrl("not a url");
  assert.equal(r.valid, false);
});

// ── isSafeRedirectUrl (defense-in-depth for buildTrackingLink) ──────────────

test("isSafeRedirectUrl: empty is NOT a safe redirect target", () => {
  assert.equal(isSafeRedirectUrl(""), false);
  assert.equal(isSafeRedirectUrl(null), false);
  assert.equal(isSafeRedirectUrl(undefined), false);
});

test("isSafeRedirectUrl: https ok, javascript rejected", () => {
  assert.equal(isSafeRedirectUrl("https://example.com"), true);
  assert.equal(isSafeRedirectUrl("javascript:alert(1)"), false);
});
