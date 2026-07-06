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

import { resolveBand } from "../band.js";

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
  /**
   * Additional rates that may legitimately appear in the draft even when they
   * coincide with a bound. The primary use is the CREATOR'S OWN STATED ASK: if
   * the creator proposed $500 and our ceiling is also $500, echoing their number
   * back ("we hear you'd like $500") is not a leak — they said it first, so it
   * discloses nothing internal. A bound the creator NEVER mentioned still blocks.
   * `allowedRate` (our presented offer) is always treated as allowlisted too.
   */
  allowedRates?: number[] | undefined;
  /**
   * The brand-set commission % for this campaign (hybrid deals). It is NON-
   * negotiable: the outbound draft may only ever state THIS percentage as the
   * commission. If the draft states any OTHER commission % (e.g. the model caved
   * to a creator's "make it 15%"), that is a promise the brand never authorized —
   * the draft is blocked. Undefined disables the check (cash-only / no commission).
   */
  commissionRate?: number | undefined;
  /** Extra internal strings that must never appear (case-insensitive). */
  internalTerms?: string[] | undefined;
}

export interface GuardHit {
  kind: "floor" | "ceiling" | "term" | "commission";
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

// Find every percentage in the text that is used as a COMMISSION rate, i.e. a
// number immediately followed by "%" (or "percent") that sits near the word
// "commission". Returns the distinct numeric values found. Used to enforce that
// the only commission % the draft states is the brand's configured one — the
// creator cannot negotiate the commission, so a different % is an unauthorized
// promise, not a leak. Deliberately narrow (must be adjacent to "commission")
// so an unrelated percentage — "30-day usage rights", "grew 15%" — is ignored.
function commissionPercentsMentioned(text: string): number[] {
  const found = new Set<number>();
  // A percentage token: 15%, 15 %, 15.5%, 15 percent.
  const pct = "(\\d+(?:\\.\\d+)?)\\s*(?:%|percent)";
  // The percentage within ~40 chars BEFORE or AFTER the word "commission".
  const patterns = [
    new RegExp(`${pct}[^.]{0,40}?commission`, "gi"),
    new RegExp(`commission[^.]{0,40}?${pct}`, "gi"),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) found.add(n);
    }
  }
  return [...found];
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

  const { floor, ceiling, allowedRate, allowedRates, commissionRate, internalTerms } = constraints;

  // A bound is allowlisted (not a leak) when it equals the rate we are
  // intentionally presenting this turn (`allowedRate`) OR any rate in
  // `allowedRates` — chiefly the creator's own stated ask, which they disclosed
  // to us, so repeating it discloses nothing internal.
  const allow = new Set<number>();
  if (allowedRate !== undefined) allow.add(allowedRate);
  for (const r of allowedRates ?? []) allow.add(r);

  if (floor !== undefined && !allow.has(floor) && numberAppears(haystack, floor)) {
    hits.push({ kind: "floor", value: String(floor) });
  }
  if (ceiling !== undefined && !allow.has(ceiling) && numberAppears(haystack, ceiling)) {
    hits.push({ kind: "ceiling", value: String(ceiling) });
  }

  const lower = haystack.toLowerCase();
  for (const term of internalTerms ?? []) {
    const t = term.trim().toLowerCase();
    if (t.length > 0 && lower.includes(t)) {
      hits.push({ kind: "term", value: term });
    }
  }

  // Commission is brand-set and NON-negotiable: the draft may only ever state the
  // configured commission %. Any OTHER commission % is a promise the creator
  // pushed for and the model wrongly conceded — block it. Skipped when no
  // commission is configured (cash-only deals never mention a commission rate).
  if (commissionRate !== undefined) {
    for (const pct of commissionPercentsMentioned(haystack)) {
      if (pct !== commissionRate) {
        hits.push({ kind: "commission", value: `${pct}% (expected ${commissionRate}%)` });
      }
    }
  }

  return hits.length === 0 ? { ok: true } : { ok: false, hits };
}

/**
 * Pull guard constraints out of a node config's price band (termFloor/termCeiling
 * or minBudget/maxBudget), with an optional allowlisted rate and extra internal
 * terms.
 */
export function guardConstraintsFromConfig(
  config: Record<string, unknown>,
  allowedRate?: number,
  creatorRate?: number,
): GuardConstraints {
  // Resolve floor/ceiling from EITHER termFloor/termCeiling or minBudget/
  // maxBudget so a UI-built workflow's bounds are still scanned for leaks (the
  // guard previously saw no band for UI configs — see resolveBand).
  const { floor, ceiling } = resolveBand(config);
  const internalTerms = Array.isArray(config["internalTerms"])
    ? (config["internalTerms"] as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  // The creator's own stated ask is allowlisted: echoing a number they gave us
  // is not a disclosure of an internal bound, even when the two coincide. This
  // is what lets a deal close/counter AT the ceiling or floor without the guard
  // falsely flagging the creator's number as a leak.
  const allowedRates =
    typeof creatorRate === "number" && Number.isFinite(creatorRate) ? [creatorRate] : undefined;

  // Brand-set commission % (hybrid deals). Non-negotiable — the guard blocks a
  // draft that states any other commission %. Absent for cash-only campaigns.
  const commissionRate =
    typeof config["commissionRate"] === "number" && Number.isFinite(config["commissionRate"])
      ? (config["commissionRate"] as number)
      : undefined;

  return {
    ...(floor !== undefined ? { floor } : {}),
    ...(ceiling !== undefined ? { ceiling } : {}),
    ...(allowedRate !== undefined ? { allowedRate } : {}),
    ...(allowedRates ? { allowedRates } : {}),
    ...(commissionRate !== undefined ? { commissionRate } : {}),
    ...(internalTerms ? { internalTerms } : {}),
  };
}
