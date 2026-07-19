import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Payment magic-link token (Payment Info / Content Brief payout form)
// ---------------------------------------------------------------------------
// BUG-S1: the payout-form link carries a bearer token that resolves to exactly
// one ExecutionInstance (and thus that creator's payout form). It MUST NOT be
// stored in the clear — a DB read/dump of a plaintext token yields a working
// link an attacker can use to submit/alter the creator's PayPal/IBAN
// destination. So we store ONLY sha256(token) (PaymentInfo.token now holds the
// hash) + an expiry; the raw token exists solely in the email link (and, for
// idempotent reuse, in the persisted PAYMENT_INFO_SENT event payload). This
// mirrors the sibling payout-confirm token (payoutToken.ts) exactly:
// sha256-at-rest, timing-safe compare, raw-only-in-email.

const DEFAULT_PAYMENT_TOKEN_TTL_DAYS = 7;

/** Lifetime of a payment-form token — PAYMENT_TOKEN_TTL_DAYS (default 7). */
export function paymentTokenTtlDays(): number {
  const raw = Number(process.env["PAYMENT_TOKEN_TTL_DAYS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PAYMENT_TOKEN_TTL_DAYS;
}

export function paymentTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + paymentTokenTtlDays() * 24 * 60 * 60 * 1000);
}

/** sha256 hex of a raw token — what we persist and compare against. */
export function hashPaymentToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** A fresh, unguessable raw token for the hosted payout-form URL. */
export function generatePaymentToken(): string {
  return randomUUID();
}

export interface MintedPaymentToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Mint a fresh payment token: a random raw token, its sha256 hash, + expiry. */
export function mintPaymentToken(now: Date = new Date()): MintedPaymentToken {
  const rawToken = generatePaymentToken();
  return {
    rawToken,
    tokenHash: hashPaymentToken(rawToken),
    expiresAt: paymentTokenExpiry(now),
  };
}

/**
 * Constant-time comparison of a presented raw token against a stored hash.
 * Hashes the presented token, then timing-safe-compares the two hex buffers.
 * Returns false on any length mismatch, absent hash, or non-string input —
 * never throws, so callers can treat false as "invalid link". Mirrors
 * payoutTokenMatches.
 */
export function paymentTokenMatches(
  presentedRaw: string | undefined | null,
  storedHash: string | null | undefined,
): boolean {
  if (typeof presentedRaw !== "string" || !presentedRaw) return false;
  if (typeof storedHash !== "string" || !storedHash) return false;
  const a = Buffer.from(hashPaymentToken(presentedRaw), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
