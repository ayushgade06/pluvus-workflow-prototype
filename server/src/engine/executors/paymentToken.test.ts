/**
 * BUG-S1: unit tests for the payment magic-link token — hash round-trip,
 * timing-safe compare (match / tamper / absent / length-mismatch), TTL, and the
 * invariant that the stored value is the HASH, never the raw token. Pure: no DB,
 * no Express, no network. Mirrors payoutToken.test.ts.
 *
 * Run: cd server && npm test
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  hashPaymentToken,
  mintPaymentToken,
  paymentTokenExpiry,
  paymentTokenMatches,
  paymentTokenTtlDays,
} from "./paymentToken.js";

describe("BUG-S1 paymentToken", () => {
  it("mint produces a raw token and its sha256 hash (not equal)", () => {
    const t = mintPaymentToken();
    assert.ok(t.rawToken.length > 0);
    assert.notEqual(t.tokenHash, t.rawToken, "the stored hash must not equal the raw token");
    assert.equal(t.tokenHash, hashPaymentToken(t.rawToken));
  });

  it("hashPaymentToken is sha256 hex (64 lowercase hex chars)", () => {
    const h = hashPaymentToken("some-token");
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("hashPaymentToken matches the inline recipe the DB layer uses", () => {
    // db/paymentInfo.ts hashes inline with node:crypto to avoid importing engine/.
    // Lock the two recipes together so they can never drift.
    const raw = mintPaymentToken().rawToken;
    const inline = createHash("sha256").update(raw).digest("hex");
    assert.equal(hashPaymentToken(raw), inline);
  });

  it("matches the correct raw token against its stored hash", () => {
    const t = mintPaymentToken();
    assert.ok(paymentTokenMatches(t.rawToken, t.tokenHash));
  });

  it("rejects a tampered token", () => {
    const t = mintPaymentToken();
    assert.ok(!paymentTokenMatches(t.rawToken + "x", t.tokenHash));
  });

  it("rejects absent / non-string inputs without throwing", () => {
    const t = mintPaymentToken();
    assert.ok(!paymentTokenMatches(undefined, t.tokenHash));
    assert.ok(!paymentTokenMatches(null, t.tokenHash));
    assert.ok(!paymentTokenMatches("", t.tokenHash));
    assert.ok(!paymentTokenMatches(t.rawToken, null));
    assert.ok(!paymentTokenMatches(t.rawToken, undefined));
    assert.ok(!paymentTokenMatches(t.rawToken, ""));
  });

  it("TTL defaults to 7 days (BUG-C1a reconciliation: was 30 in code)", () => {
    const prev = process.env["PAYMENT_TOKEN_TTL_DAYS"];
    delete process.env["PAYMENT_TOKEN_TTL_DAYS"];
    try {
      assert.equal(paymentTokenTtlDays(), 7);
      const now = new Date("2026-01-01T00:00:00.000Z");
      const exp = paymentTokenExpiry(now);
      assert.equal(exp.getTime() - now.getTime(), 7 * 24 * 60 * 60 * 1000);
    } finally {
      if (prev === undefined) delete process.env["PAYMENT_TOKEN_TTL_DAYS"];
      else process.env["PAYMENT_TOKEN_TTL_DAYS"] = prev;
    }
  });

  it("TTL honours a positive PAYMENT_TOKEN_TTL_DAYS override", () => {
    const prev = process.env["PAYMENT_TOKEN_TTL_DAYS"];
    process.env["PAYMENT_TOKEN_TTL_DAYS"] = "14";
    try {
      assert.equal(paymentTokenTtlDays(), 14);
    } finally {
      if (prev === undefined) delete process.env["PAYMENT_TOKEN_TTL_DAYS"];
      else process.env["PAYMENT_TOKEN_TTL_DAYS"] = prev;
    }
  });
});
