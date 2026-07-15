import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { paymentBaseUrl } from "./paymentEmail.js";

// ---------------------------------------------------------------------------
// Payout confirm/dispute magic-link token (Phase 3)
// ---------------------------------------------------------------------------
// The brand marks a payout SENT; the creator confirms or disputes receipt via
// two emailed magic links. The link carries a 32-byte random token; the DB
// stores ONLY its sha256 hash (Payout.confirmTokenHash) + an expiry
// (confirmTokenExpiresAt). The raw token exists solely in the email — a DB dump
// cannot forge a confirmation. Exact recipe ported from the parent
// (Pluvus/server/routes/api/payouts.ts:588-592), upgraded with a timing-safe
// compare and an interstitial-POST flow (I-5) rather than the parent's GET-mutation.

const DEFAULT_CONFIRM_TTL_DAYS = 7;

/** Lifetime of a confirm/dispute token — PAYOUT_CONFIRM_TTL_DAYS (default 7). */
export function payoutConfirmTtlDays(): number {
  const raw = Number(process.env["PAYOUT_CONFIRM_TTL_DAYS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONFIRM_TTL_DAYS;
}

export function payoutConfirmExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + payoutConfirmTtlDays() * 24 * 60 * 60 * 1000);
}

/** sha256 hex of a raw token — what we persist and compare against. */
export function hashPayoutToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface MintedPayoutToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Mint a fresh confirm/dispute token: 32 random bytes (hex), its hash, + expiry. */
export function mintPayoutToken(now: Date = new Date()): MintedPayoutToken {
  const rawToken = randomBytes(32).toString("hex");
  return {
    rawToken,
    tokenHash: hashPayoutToken(rawToken),
    expiresAt: payoutConfirmExpiry(now),
  };
}

/**
 * Constant-time comparison of a presented raw token against a stored hash.
 * Hashes the presented token, then timing-safe-compares the two hex buffers.
 * Returns false on any length mismatch, absent hash, or non-string input —
 * never throws, so callers can treat false as "invalid link".
 */
export function payoutTokenMatches(
  presentedRaw: string | undefined | null,
  storedHash: string | null | undefined,
): boolean {
  if (typeof presentedRaw !== "string" || !presentedRaw) return false;
  if (typeof storedHash !== "string" || !storedHash) return false;
  const a = Buffer.from(hashPayoutToken(presentedRaw), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** True when a token expiry has passed. A null expiry never expires (grandfathered). */
export function isPayoutTokenExpired(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() <= now.getTime();
}

/** The creator-facing confirm link for a payout + raw token. */
export function payoutConfirmLink(payoutId: string, rawToken: string): string {
  return `${paymentBaseUrl()}/payout/confirm/${payoutId}?token=${rawToken}`;
}

/** The creator-facing dispute link for a payout + raw token. */
export function payoutDisputeLink(payoutId: string, rawToken: string): string {
  return `${paymentBaseUrl()}/payout/dispute/${payoutId}?token=${rawToken}`;
}
