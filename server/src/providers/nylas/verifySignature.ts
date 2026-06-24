import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Nylas webhook signature verification
// ---------------------------------------------------------------------------
// Nylas v3 signs each webhook POST with a hex-encoded HMAC-SHA256 of the RAW
// request body, keyed by the endpoint's webhook_secret, in the
// `X-Nylas-Signature` header.
//
// Critical: the HMAC is computed over the exact raw bytes Nylas sent. The body
// MUST be verified before JSON parsing (re-serializing parsed JSON would not
// reproduce the original bytes). The webhook route therefore uses express.raw()
// so `rawBody` here is a Buffer of those exact bytes.
//
// Docs: https://developer.nylas.com/docs/v3/notifications/

/**
 * Compute the expected hex HMAC-SHA256 signature for a raw body + secret.
 * Exported for tests and for the mock client to sign simulated deliveries.
 */
export function computeSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Verify the X-Nylas-Signature header against the raw body.
 * Returns true only if the secret is configured, a signature was provided, and
 * it matches via a constant-time comparison.
 */
export function verifyNylasSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signatureHeader) {
    return false;
  }

  const expected = computeSignature(rawBody, secret);

  // Both are fixed-length lowercase hex (64 chars for SHA-256). Guard against
  // length mismatch before timingSafeEqual, which throws on unequal lengths.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
