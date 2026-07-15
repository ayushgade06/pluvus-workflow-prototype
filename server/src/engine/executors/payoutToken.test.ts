/**
 * Unit tests for the payout confirm/dispute token — hash round-trip, timing-safe
 * compare (match / tamper / absent / length-mismatch), and expiry. Pure: no DB,
 * no Express, no network.
 *
 * Run: cd server && npm test   (or npx tsx src/engine/executors/payoutToken.test.ts)
 */

import assert from "node:assert/strict";
import {
  hashPayoutToken,
  isPayoutTokenExpired,
  mintPayoutToken,
  payoutConfirmExpiry,
  payoutConfirmLink,
  payoutConfirmTtlDays,
  payoutDisputeLink,
  payoutTokenMatches,
} from "./payoutToken.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\npayoutToken\n");

// ── mint ────────────────────────────────────────────────────────────────────

test("mint produces a 64-hex-char raw token (32 bytes)", () => {
  const t = mintPayoutToken();
  assert.match(t.rawToken, /^[0-9a-f]{64}$/);
});

test("mint stores the sha256 hash of the raw token, not the token", () => {
  const t = mintPayoutToken();
  assert.notEqual(t.tokenHash, t.rawToken);
  assert.equal(t.tokenHash, hashPayoutToken(t.rawToken));
  assert.match(t.tokenHash, /^[0-9a-f]{64}$/); // sha256 hex
});

test("two mints produce distinct tokens", () => {
  const a = mintPayoutToken();
  const b = mintPayoutToken();
  assert.notEqual(a.rawToken, b.rawToken);
  assert.notEqual(a.tokenHash, b.tokenHash);
});

// ── hash round-trip + timing-safe compare ────────────────────────────────────

test("matches: correct raw token against its stored hash", () => {
  const t = mintPayoutToken();
  assert.equal(payoutTokenMatches(t.rawToken, t.tokenHash), true);
});

test("tamper: a wrong token does NOT match", () => {
  const t = mintPayoutToken();
  const other = mintPayoutToken();
  assert.equal(payoutTokenMatches(other.rawToken, t.tokenHash), false);
});

test("tamper: a one-char-off token does NOT match", () => {
  const t = mintPayoutToken();
  const flipped = t.rawToken.slice(0, -1) + (t.rawToken.endsWith("0") ? "1" : "0");
  assert.equal(payoutTokenMatches(flipped, t.tokenHash), false);
});

test("absent: undefined / empty presented token never matches", () => {
  const t = mintPayoutToken();
  assert.equal(payoutTokenMatches(undefined, t.tokenHash), false);
  assert.equal(payoutTokenMatches("", t.tokenHash), false);
  assert.equal(payoutTokenMatches(null, t.tokenHash), false);
});

test("absent: a null / empty stored hash never matches", () => {
  assert.equal(payoutTokenMatches("anything", null), false);
  assert.equal(payoutTokenMatches("anything", ""), false);
  assert.equal(payoutTokenMatches("anything", undefined), false);
});

test("compare is over equal-length hex buffers (no throw on odd input)", () => {
  // hashPayoutToken always yields 64 hex chars, so the timingSafeEqual buffers
  // are always equal length — but a non-hex/short presented token must still
  // return false, not throw.
  const t = mintPayoutToken();
  assert.doesNotThrow(() => payoutTokenMatches("zz", t.tokenHash));
  assert.equal(payoutTokenMatches("zz", t.tokenHash), false);
});

// ── expiry ───────────────────────────────────────────────────────────────────

test("TTL defaults to 7 days when the env var is unset/invalid", () => {
  const prev = process.env["PAYOUT_CONFIRM_TTL_DAYS"];
  delete process.env["PAYOUT_CONFIRM_TTL_DAYS"];
  assert.equal(payoutConfirmTtlDays(), 7);
  process.env["PAYOUT_CONFIRM_TTL_DAYS"] = "0"; // invalid → fallback
  assert.equal(payoutConfirmTtlDays(), 7);
  process.env["PAYOUT_CONFIRM_TTL_DAYS"] = "14";
  assert.equal(payoutConfirmTtlDays(), 14);
  if (prev === undefined) delete process.env["PAYOUT_CONFIRM_TTL_DAYS"];
  else process.env["PAYOUT_CONFIRM_TTL_DAYS"] = prev;
});

test("expiry is TTL days in the future from `now`", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const prev = process.env["PAYOUT_CONFIRM_TTL_DAYS"];
  process.env["PAYOUT_CONFIRM_TTL_DAYS"] = "7";
  const exp = payoutConfirmExpiry(now);
  assert.equal(exp.toISOString(), "2026-07-22T00:00:00.000Z");
  if (prev === undefined) delete process.env["PAYOUT_CONFIRM_TTL_DAYS"];
  else process.env["PAYOUT_CONFIRM_TTL_DAYS"] = prev;
});

test("isPayoutTokenExpired: past → true, future → false, null → never", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  assert.equal(isPayoutTokenExpired(new Date("2026-07-15T11:59:59.000Z"), now), true);
  assert.equal(isPayoutTokenExpired(new Date("2026-07-15T12:00:01.000Z"), now), false);
  assert.equal(isPayoutTokenExpired(null, now), false);
  assert.equal(isPayoutTokenExpired(undefined, now), false);
});

// ── links ──────────────────────────────────────────────────────────────────

test("confirm/dispute links embed the payout id + raw token on distinct paths", () => {
  const prev = process.env["PAYMENT_BASE_URL"];
  process.env["PAYMENT_BASE_URL"] = "https://pay.example.com";
  const c = payoutConfirmLink("payout_1", "rawtok");
  const d = payoutDisputeLink("payout_1", "rawtok");
  assert.equal(c, "https://pay.example.com/payout/confirm/payout_1?token=rawtok");
  assert.equal(d, "https://pay.example.com/payout/dispute/payout_1?token=rawtok");
  if (prev === undefined) delete process.env["PAYMENT_BASE_URL"];
  else process.env["PAYMENT_BASE_URL"] = prev;
});

console.log(`\n${n} passed\n`);
