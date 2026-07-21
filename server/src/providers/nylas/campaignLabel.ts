// ---------------------------------------------------------------------------
// campaignLabelName - presentation policy for the Gmail campaign label
// ---------------------------------------------------------------------------
// Pure transform (no I/O, no provider concepts), mirroring buildReplySubject's
// "presentation policy" pattern (threadContext.ts): same input -> same output.
//
// The label is ALWAYS `<prefix>/<Campaign name>` - no id, no hash, ever
// (spec section 6.2, Refinement #2). Human readability inside Gmail is the
// priority; two campaigns that intentionally share a name share the label
// (accepted for v1). The only transformations are those Gmail/Nylas REQUIRE to
// accept the string as a label - none of them add uniqueness.
//
// Decisions recorded in ADR-labels-nylas.md (sections 6, 7):
//   - inner "/" (and "\") in the campaign name -> "-", so a campaign literally
//     named "A/B Test" does NOT create a spurious nesting level under Gmail's
//     "/"-nesting (would otherwise become "Pluvus/A/B Test"). Result:
//     "Pluvus/A-B Test".
//   - total label bounded to 225 chars (safe for Gmail's per-component limit and
//     Nylas's 1..1024 create constraint); the campaign portion is truncated, the
//     "<prefix>/" is never cut.

/** Max length of the full derived label (ADR section 7 - safe for Gmail + Nylas). */
export const MAX_LABEL_LENGTH = 225;

/** Default parent namespace; overridable via env GMAIL_LABEL_PREFIX (section 8). */
export const DEFAULT_LABEL_PREFIX = "Pluvus";

const ELLIPSIS = "…"; // a single horizontal-ellipsis char

/**
 * Derive the Gmail label for a campaign: `<prefix>/<sanitized campaign name>`.
 *
 * @param campaignName the human campaign name (Campaign.name). Empty/whitespace
 *        falls back to "Untitled" so we NEVER emit a bare "<prefix>/" (defensive;
 *        the column is notNull, so this should be unreachable).
 * @param prefix parent namespace, default "Pluvus".
 */
export function campaignLabelName(
  campaignName: string,
  prefix: string = DEFAULT_LABEL_PREFIX,
): string {
  // The prefix is itself sanitized + defaulted so a blank env override can't
  // produce a leading "/" or an inner-"/" second nesting level.
  const safePrefix = sanitizeSegment(prefix) || DEFAULT_LABEL_PREFIX;

  // Sanitize the campaign name; fall back to "Untitled" when empty after cleanup
  // so the output is never a bare "<prefix>/".
  const safeName = sanitizeSegment(campaignName) || "Untitled";

  const full = `${safePrefix}/${safeName}`;
  if (full.length <= MAX_LABEL_LENGTH) return full;

  // Over-length: keep the "<prefix>/" whole and truncate the name portion,
  // marking the cut with an ellipsis so it's visibly abbreviated in the sidebar.
  const budget = MAX_LABEL_LENGTH - safePrefix.length - 1; // 1 for the "/"
  // Guard the pathological case where the prefix alone eats the budget: never
  // return a negative-length slice; fall back to the whole prefix + "/".
  if (budget <= ELLIPSIS.length) return `${safePrefix}/`.slice(0, MAX_LABEL_LENGTH);
  const truncatedName = safeName.slice(0, budget - ELLIPSIS.length) + ELLIPSIS;
  return `${safePrefix}/${truncatedName}`;
}

// Control characters Gmail rejects in label names: the C0 range U+0000..U+001F
// plus DEL U+007F. Written as explicit unicode escapes so no literal control
// byte ever lives in this source file.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const NESTING_SEPARATORS = /[/\\]/g;
const WHITESPACE_RUNS = /\s+/g;

/**
 * Clean a single label segment (prefix or campaign name):
 *   - flatten "/" and "\" to "-" so the segment can't introduce nesting,
 *   - drop control chars Gmail rejects,
 *   - collapse internal whitespace runs to a single space,
 *   - trim leading/trailing whitespace.
 * Returns "" when nothing usable remains (caller supplies the fallback).
 */
function sanitizeSegment(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(NESTING_SEPARATORS, "-")
    // Collapse whitespace FIRST — \s covers tab/newline/CR, so a "Tab\tHere"
    // becomes "Tab Here" (one space) rather than "TabHere". Doing this before
    // the control-char strip means whitespace control chars turn into a visible
    // space instead of vanishing.
    .replace(WHITESPACE_RUNS, " ")
    // Then drop any REMAINING (non-whitespace) control chars Gmail rejects.
    .replace(CONTROL_CHARS, "")
    .trim();
}
