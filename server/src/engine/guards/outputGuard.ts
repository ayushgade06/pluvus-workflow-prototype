// ---------------------------------------------------------------------------
// Outbound draft output guard (FIX-4)
// ---------------------------------------------------------------------------
// A mandatory net before any AI-generated email is sent to a creator. The
// negotiation prompt instructs the model to NEVER reveal the internal floor or
// ceiling, but a prompt rule is not a control: one model slip or one prompt
// injection and the budget bounds go out the door. This guard scans the
// rendered draft for those numbers (and any configured internal terms) and
// blocks the send on a hit so the executor can route to MANUAL_REVIEW instead.
//
// Pure function — no IO — so it is fully unit-testable without a DB or network.

export interface GuardDraft {
  subject?: string | null;
  body: string;
}

export interface GuardConstraints {
  /** Internal minimum we must never disclose. */
  floor?: number | undefined;
  /** Internal maximum we must never disclose. */
  ceiling?: number | undefined;
  /**
   * The rate we deliberately intend to present this turn (the offer being
   * made). It is allowlisted so a legitimate offer that happens to coincide
   * with a bound is not falsely blocked.
   */
  allowedRate?: number | undefined;
  /** Extra internal strings that must never appear (case-insensitive). */
  internalTerms?: string[] | undefined;
}

export interface GuardHit {
  kind: "floor" | "ceiling" | "term";
  value: string;
}

export type GuardResult = { ok: true } | { ok: false; hits: GuardHit[] };

// Match a specific number as a standalone money-ish token: optional leading $,
// optional thousands separators, optional .00 — but NOT as a substring of a
// larger number (so 500 does not match inside 1500). Word boundaries on both
// sides via surrounding non-digit assertions.
function numberAppears(text: string, n: number): boolean {
  // Build patterns for the integer with and without thousands separators.
  const plain = String(n);
  const grouped = n.toLocaleString("en-US"); // e.g. 1,000
  const alternatives = new Set<string>([plain, grouped]);

  for (const num of alternatives) {
    // Escape regex metachars in the grouped form (the comma is literal).
    const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // (?<![\d.,]) — not preceded by a digit/sep (avoids matching 2500 for 500)
    // (?:\.\d+)?  — tolerate a trailing decimal part
    // (?![\d])    — not followed by another digit
    const re = new RegExp(`(?<![\\d.,])\\$?${escaped}(?:\\.\\d+)?(?![\\d])`);
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Scan a rendered outbound draft for disclosure of internal bounds.
 *
 * Returns `{ ok: true }` when the draft is clean, or `{ ok: false, hits }`
 * listing every leak found. The `allowedRate` is excluded from floor/ceiling
 * matching so a legitimate on-policy offer is never blocked.
 */
export function scanOutboundDraft(draft: GuardDraft, constraints: GuardConstraints): GuardResult {
  const haystack = `${draft.subject ?? ""}\n${draft.body}`;
  const hits: GuardHit[] = [];

  const { floor, ceiling, allowedRate, internalTerms } = constraints;

  // Floor/ceiling checks are skipped when the bound equals the rate we are
  // intentionally presenting this turn.
  if (floor !== undefined && floor !== allowedRate && numberAppears(haystack, floor)) {
    hits.push({ kind: "floor", value: String(floor) });
  }
  if (ceiling !== undefined && ceiling !== allowedRate && numberAppears(haystack, ceiling)) {
    hits.push({ kind: "ceiling", value: String(ceiling) });
  }

  const lower = haystack.toLowerCase();
  for (const term of internalTerms ?? []) {
    const t = term.trim().toLowerCase();
    if (t.length > 0 && lower.includes(t)) {
      hits.push({ kind: "term", value: term });
    }
  }

  return hits.length === 0 ? { ok: true } : { ok: false, hits };
}

/**
 * Pull guard constraints out of a node config's term floor/ceiling, with an
 * optional allowlisted rate and extra internal terms.
 */
export function guardConstraintsFromConfig(
  config: Record<string, unknown>,
  allowedRate?: number,
): GuardConstraints {
  const floor = rateOf(config["termFloor"]);
  const ceiling = rateOf(config["termCeiling"]);
  const internalTerms = Array.isArray(config["internalTerms"])
    ? (config["internalTerms"] as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  return {
    ...(floor !== undefined ? { floor } : {}),
    ...(ceiling !== undefined ? { ceiling } : {}),
    ...(allowedRate !== undefined ? { allowedRate } : {}),
    ...(internalTerms ? { internalTerms } : {}),
  };
}

function rateOf(term: unknown): number | undefined {
  if (term && typeof term === "object") {
    const r = (term as Record<string, unknown>)["rate"];
    if (typeof r === "number" && Number.isFinite(r)) return r;
  }
  return undefined;
}
