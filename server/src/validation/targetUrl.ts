// ---------------------------------------------------------------------------
// targetUrl validation (BUG-SEC5 — open-redirect / future SSRF)
// ---------------------------------------------------------------------------
// A campaign's `targetUrl` is stored and later 302-redirected to by /t/:code
// (via the minted partnership trackingLink). The audit found it was persisted
// with only `.trim()` — no scheme/host validation — so a malicious or typo'd
// value (javascript:, data:, file:, an unparseable string) could be stored and
// redirected to, an open-redirect today and an SSRF vector once anything
// server-side fetches it.
//
// This is the single source of truth for what a valid targetUrl is:
//   - must parse as an absolute URL
//   - scheme MUST be http: or https: (rejects javascript:/data:/file:/ftp:/etc.)
//   - must have a host
// It is applied at campaign create/update (reject with 422) and re-applied as
// defense-in-depth in buildTrackingLink (a bad URL yields a null trackingLink →
// the /t redirect 404s instead of bouncing to it).

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export interface TargetUrlResult {
  valid: boolean;
  /** The normalized (parsed → stringified) URL when valid. */
  url?: string;
  /** A human-readable reason when invalid. */
  reason?: string;
}

/**
 * Validate a campaign targetUrl. `null`/`undefined`/empty is treated as "no
 * targetUrl" (valid — a campaign may have none); a NON-empty value must be a
 * well-formed http(s) URL with a host.
 */
export function validateTargetUrl(raw: string | null | undefined): TargetUrlResult {
  if (raw === null || raw === undefined) return { valid: true };
  const trimmed = raw.trim();
  if (trimmed === "") return { valid: true };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: "targetUrl is not a valid URL" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      valid: false,
      reason: `targetUrl must use http or https (got "${parsed.protocol}")`,
    };
  }
  if (!parsed.hostname) {
    return { valid: false, reason: "targetUrl must include a host" };
  }
  return { valid: true, url: parsed.toString() };
}

/**
 * Boolean convenience used on the defense-in-depth path (buildTrackingLink):
 * true only for a NON-empty, well-formed http(s) URL. An empty/absent value is
 * NOT a safe redirect target here (there is nothing to redirect to), so this
 * returns false for it — distinct from validateTargetUrl's "empty is allowed at
 * storage time" semantics.
 */
export function isSafeRedirectUrl(raw: string | null | undefined): boolean {
  if (!raw || !raw.trim()) return false;
  const r = validateTargetUrl(raw);
  return r.valid && r.url !== undefined;
}
