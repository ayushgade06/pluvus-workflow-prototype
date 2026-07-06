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

// ---------------------------------------------------------------------------
// HTML → plain text (real emails from Gmail/Outlook/etc. are HTML)
// ---------------------------------------------------------------------------
// The quote/signature stripping below is line-based, but an HTML email is one
// tag blob with no ">" quote lines or "-- " delimiters — so without this step
// the raw markup ("<div><p>Hi ...</p>") reaches the classifier, which returns
// UNKNOWN/confidence-0 and routes every real reply to MANUAL_REVIEW. We convert
// HTML to plain text FIRST, then the existing line logic strips quoted history.

// Cheap, dependency-free HTML detection: a tag-shaped token anywhere in the body.
// Good enough to decide whether to run the (idempotent-ish) HTML→text pass.
const HTML_TAG_RE = /<\/?[a-z][\s\S]*?>/i;

const NAMED_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
};

/** Decode the common named + numeric HTML entities the classifier would otherwise
 *  see as literal "&#39;". Unknown entities are left untouched. */
function decodeEntities(text: string): string {
  let out = text.replace(
    /&(?:nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash|hellip|rsquo|lsquo|rdquo|ldquo);/gi,
    (m) => NAMED_ENTITIES[m.toLowerCase()] ?? NAMED_ENTITIES[m] ?? m,
  );
  // Numeric entities: decimal (&#123;) and hex (&#x1F600;).
  out = out.replace(/&#(\d+);/g, (_m, d: string) => safeFromCodePoint(parseInt(d, 10)));
  out = out.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)));
  return out;
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Convert an HTML email body to plain text: drop script/style content, turn
 * block-level and <br> tags into line breaks, strip all remaining tags, decode
 * entities, and collapse whitespace. Returns the input unchanged when it doesn't
 * look like HTML, so plain-text replies are unaffected.
 */
export function htmlToPlainText(body: string): string {
  if (typeof body !== "string" || !HTML_TAG_RE.test(body)) return body;
  let text = body;
  // Remove content we never want as text.
  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // Line breaks: <br>, and the close of common block elements, become newlines.
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  // Strip every remaining tag.
  text = text.replace(/<[^>]+>/g, "");
  // Decode entities AFTER tag removal so a decoded "<"/">" can't reopen a tag.
  text = decodeEntities(text);
  // Normalize whitespace: trim each line, drop blank runs.
  text = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/**
 * Return the creator's top-posted reply with quoted history and signature
 * removed. Falls back to the trimmed original when cleaning would leave
 * nothing meaningful.
 */
export function extractReplyText(rawBody: string): string {
  if (typeof rawBody !== "string" || rawBody.trim() === "") {
    return typeof rawBody === "string" ? rawBody : "";
  }

  // Real emails are HTML: convert to plain text FIRST so the quote/signature
  // line logic below (and the classifier/negotiation agent downstream) operate on
  // readable text, not "<div><p>...". No-op for plain-text bodies.
  const body = htmlToPlainText(rawBody);

  const lines = body.split(/\r?\n/);
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
  // because the heuristic over-cut. Fall back to the HTML-stripped body (not the
  // raw HTML) so the fallback is still readable plain text.
  if (cleaned.replace(/\s/g, "").length < MIN_CLEANED_CHARS) {
    return body.trim();
  }
  return cleaned;
}
