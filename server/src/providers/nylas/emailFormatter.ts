// ---------------------------------------------------------------------------
// emailFormatter — plain-text → clean business-email HTML (presentation only)
// ---------------------------------------------------------------------------
// Outbound bodies are authored as PLAIN TEXT everywhere in the system
// (MockEmailProvider.draft, the AI draftEmail layer, and the agent's raw
// `message`). Nylas/Gmail render the `body` field as HTML, so plain text with
// "\n" newlines collapses into a single robotic-looking block.
//
// This module wraps that exact same text in minimal, professional HTML so it
// reads like a human-written business email — without changing a single word.
// It ONLY touches whitespace and markup:
//   - blank-line-separated blocks become <p> paragraphs (greeting, body,
//     closing each get their own paragraph and breathing room)
//   - single newlines inside a block become <br> (so a signature's
//     "Best regards," / name lines stack instead of running together)
//   - bullet lists (-, *, •) and numbered lists (1. 2. …) become <ul>/<ol>
//   - **bold** markers already present in the copy render as <strong>
//   - bare URLs become clickable <a> links
//
// Wording is never altered. The persisted Message.body (DB) stays plain text;
// only the bytes handed to nylas.messages.send() are this HTML.

// Inline, minimal font stack + spacing. No colors beyond near-black text, no
// logos, banners, or marketing chrome — just readable typography.
const BODY_STYLE = [
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif",
  "font-size:16px",
  "line-height:1.6",
  "color:#222",
].join(";");

// Paragraphs carry their spacing as inline margins so the result survives email
// clients that strip <style> blocks / <head>.
const P_STYLE = "margin:0 0 16px 0";
const LIST_STYLE = "margin:0 0 16px 0;padding-left:24px";

/** Escape the five HTML-significant characters so the text renders verbatim. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Apply inline presentation markup to an ALREADY html-escaped line:
 *   - **bold** → <strong>bold</strong> (markers already in the copy)
 *   - bare http(s) URLs → clickable links
 * Operates on escaped text so it never introduces unescaped user content.
 */
function inlineMarkup(escaped: string): string {
  // Bold: **text** → <strong>text</strong>. Non-greedy, no nested ** support
  // needed for our copy. Leaves single asterisks (bullets) untouched.
  let out = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Linkify bare URLs. The URL was html-escaped first, so "&" in query strings
  // is already "&amp;"; we keep the displayed text identical to the source.
  out = out.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}">${url}</a>`,
  );

  return out;
}

// A block is one or more consecutive non-blank lines (paragraph, list, or
// signature). Blocks are separated by one or more blank lines.
function splitIntoBlocks(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n+/) // one or more blank lines = block boundary
    .map((b) => b.replace(/^\n+|\n+$/g, ""))
    .filter((b) => b.length > 0);
}

const BULLET_RE = /^[ \t]*[-*•]\s+(.*)$/;
const ORDERED_RE = /^[ \t]*\d+[.)]\s+(.*)$/;

function isBulletBlock(lines: string[]): boolean {
  return lines.every((l) => BULLET_RE.test(l));
}

function isOrderedBlock(lines: string[]): boolean {
  return lines.every((l) => ORDERED_RE.test(l));
}

function renderListItems(lines: string[], re: RegExp): string {
  return lines
    .map((l) => {
      const m = l.match(re);
      const item = m?.[1] ?? l;
      return `<li>${inlineMarkup(escapeHtml(item))}</li>`;
    })
    .join("");
}

/** Render one block as a <p>, <ul>, or <ol>. */
function renderBlock(block: string): string {
  const lines = block.split("\n");

  if (lines.length > 1 && isBulletBlock(lines)) {
    return `<ul style="${LIST_STYLE}">${renderListItems(lines, BULLET_RE)}</ul>`;
  }
  if (lines.length > 1 && isOrderedBlock(lines)) {
    return `<ol style="${LIST_STYLE}">${renderListItems(lines, ORDERED_RE)}</ol>`;
  }

  // Plain paragraph: join its lines with <br> so intentional line breaks within
  // a block (e.g. a signature) are preserved.
  const inner = lines
    .map((l) => inlineMarkup(escapeHtml(l)))
    .join("<br>");
  return `<p style="${P_STYLE}">${inner}</p>`;
}

/**
 * Convert a plain-text email body to clean, minimal business-email HTML.
 *
 * Presentation only — the visible wording is byte-for-byte the source text;
 * just the whitespace/markup changes. Idempotency: a body that is already HTML
 * (starts with "<") is returned untouched, so this can never double-wrap.
 */
export function plainTextToHtmlEmail(body: string): string {
  if (!body) return body;

  // If the body is already HTML (e.g. a future provider hands HTML through),
  // don't touch it. We only format plain text.
  if (/^\s*</.test(body)) return body;

  const blocks = splitIntoBlocks(body);
  // Degenerate case: no real content — return as-is rather than emitting empty
  // markup.
  if (blocks.length === 0) return body;

  const html = blocks.map(renderBlock).join("\n");

  return `<div style="${BODY_STYLE}">\n${html}\n</div>`;
}
