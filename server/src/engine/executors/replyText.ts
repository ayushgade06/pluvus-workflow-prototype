// ---------------------------------------------------------------------------
// Inbound reply-text extraction (H1)
// ---------------------------------------------------------------------------
// The raw email body a creator sends back includes the quoted thread they are
// replying to (our own outreach copy) and their signature. Classifying that raw
// body means the classifier keys off OUR quoted words — "interested", "rate",
// "commission", "partnership" — instead of the creator's actual reply. A creator
// whose real reply is "No." can be classified POSITIVE/QUESTION because the
// quoted history dominates the signal.
//
// extractReplyText() returns just the creator's top-posted reply: it removes the
// quoted thread (lines beginning with ">", and everything after a quote header
// like "On <date> <name> wrote:" or "-----Original Message-----") and a trailing
// signature block ("-- " on its own line).
//
// CONSERVATISM IS THE POINT. This is a heuristic, and cutting a real sentence is
// worse than leaving some quoted text in. So:
//   * we only cut at HIGH-CONFIDENCE quote/signature markers, and
//   * if the result is empty or collapses to almost nothing, we FALL BACK to the
//     original body (never classify an empty string).
// The caller keeps the raw body persisted for audit; only the text handed to the
// classifier / negotiation agent is cleaned.

// A line that opens a quoted reply block. Everything from here down is quoted
// history and is dropped. Case-insensitive; matched per-line.
const QUOTE_HEADER_PATTERNS: RegExp[] = [
  // "On Mon, Jan 1, 2026 at 10:00 AM, Jane Doe <jane@x.com> wrote:"
  /^\s*On\b.*\bwrote:\s*$/i,
  // "On <...> wrote:" split across a wrap is common; also accept a trailing
  // "wrote:" preceded by an email/name on the same logical line.
  /^\s*On\b.*\b(?:wrote|schrieb|escribió):?\s*$/i,
  // Outlook / other clients.
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/, // long underscore rule some clients insert before quoted text
  // Header block that introduces a forwarded/quoted message.
  /^\s*From:\s*.+$/i,
];

// A line that begins a signature block. Everything from here down is dropped.
const SIGNATURE_DELIMITERS: RegExp[] = [
  /^--\s*$/, // RFC 3676 signature delimiter: "-- " on its own line
  /^__+\s*$/, // some clients use underscores
  /^\s*Sent from my\b.*$/i, // "Sent from my iPhone"
];

// If cleaning leaves fewer than this many non-whitespace chars, assume we cut too
// aggressively and fall back to the raw body.
const MIN_CLEANED_CHARS = 2;

/**
 * Return the creator's top-posted reply with quoted history and signature
 * removed. Falls back to the trimmed original when cleaning would leave
 * nothing meaningful.
 */
export function extractReplyText(rawBody: string): string {
  if (typeof rawBody !== "string" || rawBody.trim() === "") {
    return typeof rawBody === "string" ? rawBody : "";
  }

  const lines = rawBody.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    // Stop at the first quote header or signature delimiter — everything below
    // is quoted thread or signature.
    if (QUOTE_HEADER_PATTERNS.some((re) => re.test(line))) break;
    if (SIGNATURE_DELIMITERS.some((re) => re.test(line))) break;

    // Drop individual quoted lines ("> ...") but keep scanning: some clients
    // interleave a short top-post above quoted lines without a header.
    if (/^\s*>+/.test(line)) continue;

    kept.push(line);
  }

  // Collapse 3+ blank lines and trim.
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Safety net: never hand the classifier an empty/near-empty string just
  // because the heuristic over-cut. Fall back to the raw (trimmed) body.
  if (cleaned.replace(/\s/g, "").length < MIN_CLEANED_CHARS) {
    return rawBody.trim();
  }
  return cleaned;
}
