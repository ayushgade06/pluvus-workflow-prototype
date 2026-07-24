// ---------------------------------------------------------------------------
// Manual Initial Outreach — template variable allow-list (single source of truth)
// ---------------------------------------------------------------------------
//
// The operator writes the initial outreach email by hand in the builder and can
// personalize it with {{variables}} that are substituted per-creator at send
// time. This module is the ONE canonical list of which variables exist, how each
// resolves, and its fallback when the source value is empty.
//
// It is imported by:
//   - the render seam (MockEmailProvider.draft) — the actual substitution + the
//     send-time strip of any unknown {{token}} that slipped past validation;
//   - graph validation (server) — reject a publish that references an unknown
//     variable, with a "did you mean" hint;
//   - (mirrored) the web builder palette + live preview.
// Keeping renderer, validator, and palette off one list means they can never
// drift — a variable added here is instantly known everywhere.

import type { Creator } from "../db/schema.js";

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------

export interface OutreachVariable {
  /** Token name WITHOUT braces, e.g. "creatorName" for {{creatorName}}. */
  readonly name: string;
  /** Grouping for the UI palette. */
  readonly group: "Creator" | "Brand" | "Campaign";
  /** One-line description of what it resolves to (shown as a tooltip/hint). */
  readonly label: string;
  /** Human note about the fallback when the source is empty. */
  readonly fallbackNote: string;
}

// Order here is the palette order in the UI.
export const OUTREACH_VARIABLES: readonly OutreachVariable[] = [
  // Creator
  { name: "creatorName", group: "Creator", label: "The creator's name", fallbackNote: "always present" },
  { name: "platform", group: "Creator", label: "The creator's platform (e.g. Instagram)", fallbackNote: "\"social media\" when unknown" },
  { name: "niche", group: "Creator", label: "The creator's niche (e.g. fitness)", fallbackNote: "\"your niche\" when unknown" },
  // Brand
  { name: "brandName", group: "Brand", label: "The brand's name", fallbackNote: "falls back to the sender name" },
  { name: "senderName", group: "Brand", label: "The sender / partnerships identity", fallbackNote: "\"Pluvus Partnerships\" when unset" },
  { name: "brandDescription", group: "Brand", label: "What the brand does", fallbackNote: "blank when unset" },
  // Campaign
  { name: "rewardDescription", group: "Campaign", label: "The product / sample reward blurb", fallbackNote: "blank when cash-only" },
  { name: "deliverables", group: "Campaign", label: "What the creator would produce", fallbackNote: "blank when unset" },
  { name: "timeline", group: "Campaign", label: "The campaign timeline", fallbackNote: "blank when unset" },
] as const;

/** Set of allowed variable names for O(1) membership checks. */
export const OUTREACH_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  OUTREACH_VARIABLES.map((v) => v.name),
);

// ---------------------------------------------------------------------------
// Token scanning
// ---------------------------------------------------------------------------

// Matches a {{token}} with optional inner whitespace: {{ creatorName }}.
// Global so we can iterate every occurrence. Token capture is the trimmed name.
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Return the distinct variable names referenced in a template string that are
 * NOT in the allow-list. Empty array when the template is clean. Used by
 * validation to block a publish and by the UI to highlight typos.
 */
export function extractUnknownTokens(template: string): string[] {
  if (!template) return [];
  const unknown = new Set<string>();
  for (const m of template.matchAll(TOKEN_RE)) {
    const name = m[1];
    if (name && !OUTREACH_VARIABLE_NAMES.has(name)) unknown.add(name);
  }
  return [...unknown];
}

/**
 * Cheap Levenshtein-distance suggestion: given an unknown token, return the
 * closest known variable name within edit distance 3, else undefined. Powers the
 * "did you mean {{creatorName}}?" hint. Small N (9 vars) so this is trivial.
 */
export function suggestVariable(unknown: string): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  const lower = unknown.toLowerCase();
  for (const v of OUTREACH_VARIABLES) {
    const d = editDistance(lower, v.name.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = v.name;
    }
  }
  return bestDist <= 3 ? best : undefined;
}

/**
 * Format the "did you mean" clause for an unknown token, e.g.
 *   ` — did you mean {{creatorName}}?`
 * Returns "" when there's no close match. Pure string helper shared by the
 * server and web validators so the wording matches.
 */
export function didYouMeanClause(unknown: string): string {
  const s = suggestVariable(unknown);
  return s ? ` — did you mean {{${s}}}?` : "";
}

// ---------------------------------------------------------------------------
// Validation (shared logic for the graph validators)
// ---------------------------------------------------------------------------

export type OutreachValidationCode =
  | "MISSING_SUBJECT"
  | "MISSING_BODY"
  | "UNKNOWN_VARIABLE";

export interface OutreachValidationIssue {
  code: OutreachValidationCode;
  message: string;
}

/**
 * Validate an INITIAL_OUTREACH node's outreach copy. Returns the first blocking
 * issue, or null when valid. Mode-aware:
 *   - "manual"  → subject AND body are required (they ARE the email), and any
 *                 unknown {{token}} in either is rejected (with a suggestion).
 *   - "ai" / absent → subject/body are optional (they're only the AI fallback);
 *                 we still reject an unknown {{token}} IF one is present, so a
 *                 typo in a fallback template can't silently mail literal braces.
 *
 * Absent mode is treated as "ai" here to match the executor's legacy default —
 * re-validating an old AI-mode draft never suddenly fails on empty copy.
 */
export function validateOutreachConfig(cfg: Record<string, unknown>): OutreachValidationIssue | null {
  const mode = cfg["outreachMode"] === "manual" ? "manual" : "ai";
  const subject = typeof cfg["subjectTemplate"] === "string" ? cfg["subjectTemplate"] : "";
  const body = typeof cfg["bodyTemplate"] === "string" ? cfg["bodyTemplate"] : "";

  if (mode === "manual") {
    if (subject.trim().length === 0)
      return { code: "MISSING_SUBJECT", message: "Initial Outreach needs an email subject." };
    if (body.trim().length === 0)
      return { code: "MISSING_BODY", message: "Initial Outreach needs an email body." };
  }

  // Unknown-variable check runs for BOTH modes (a typo in an AI-fallback template
  // is still a latent bug). Subject first so its error surfaces first.
  for (const [field, text] of [["subject", subject], ["body", body]] as const) {
    const unknown = extractUnknownTokens(text);
    if (unknown.length > 0) {
      const bad = unknown[0]!;
      return {
        code: "UNKNOWN_VARIABLE",
        message: `The outreach ${field} uses {{${bad}}}, which is not a known variable${didYouMeanClause(bad)}`,
      };
    }
  }
  return null;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Resolve every allow-listed variable in `template` from the creator + config,
 * and STRIP any surviving unknown {{token}} to empty string (the send-time net
 * so a validation miss can never mail a creator literal braces).
 *
 * This is the single substitution function used by MockEmailProvider.draft for
 * both the manual outreach body and subject. Values come from the same merged
 * config the executor already built (mergeCampaignFallback stamps the campaign
 * fields), so no new plumbing is needed.
 */
export function resolveOutreachTemplate(
  template: string,
  creator: Pick<Creator, "name" | "platform" | "niche">,
  config: Record<string, unknown>,
): string {
  const str = (key: string): string =>
    typeof config[key] === "string" ? (config[key] as string) : "";

  const senderName = str("senderName") || "Pluvus Partnerships";
  const brandName = str("brandName") || senderName;
  const platform =
    typeof creator.platform === "string" && creator.platform.trim().length > 0
      ? creator.platform
      : "social media";
  const niche =
    typeof creator.niche === "string" && creator.niche.trim().length > 0
      ? creator.niche
      : "your niche";

  const values: Record<string, string> = {
    creatorName: creator.name,
    platform,
    niche,
    brandName,
    senderName,
    brandDescription: str("brandDescription"),
    rewardDescription: str("rewardDescription"),
    deliverables: str("deliverables"),
    timeline: str("timeline"),
  };

  // One pass: known tokens → their value, unknown tokens → "" (stripped).
  return template.replace(TOKEN_RE, (_full, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : "",
  );
}
