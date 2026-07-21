// ---------------------------------------------------------------------------
// Deterministic content-URL extraction
// ---------------------------------------------------------------------------
// Pulls http(s) URLs out of a creator's plain-text reply so the content-links
// handler can capture the links they posted. This is a CODE-LEVEL extractor — no
// model inference — so the same reply always yields the same links.
//
// Contract:
//   * only absolute http:// / https:// URLs are captured (a bare "instagram.com/p/x"
//     without a scheme is intentionally NOT matched — we want links the creator
//     deliberately pasted, and requiring a scheme keeps false positives low);
//   * common trailing punctuation ( ) . , ! ? ; : > " ' ] } and wrapping angle
//     brackets are trimmed so "see https://x.com/p/1." yields the bare URL;
//   * duplicates are removed, preserving first-seen order, so a link that also
//     appears in a quoted history line (if any survives de-quoting) is captured once.
//
// The caller is expected to have already stripped quoted thread history
// (extractReplyText) so previously-sent links are not re-captured.

// Match an http(s) URL. Kept deliberately simple: a scheme, "://", then a run of
// non-whitespace, non-angle-bracket characters. Per-match trimming below removes
// trailing punctuation the greedy run would otherwise swallow.
const URL_RE = /\bhttps?:\/\/[^\s<>]+/gi;

// Characters that commonly trail a URL in prose but are not part of it. Stripped
// from the END of each match. A closing ")" is only stripped when the URL has no
// matching "(" (so "…/wiki/Foo_(bar)" keeps its parenthesis).
const TRAILING_PUNCT = new Set([".", ",", "!", "?", ";", ":", '"', "'", ">", "]", "}", "`"]);

function trimTrailing(raw: string): string {
  let url = raw;
  // Strip a leading angle bracket if the run began with one (rare after the \b,
  // but cheap to guard).
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if (TRAILING_PUNCT.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")") {
      // Only trim an unbalanced ")": keep it when the URL contains a matching "(".
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return url;
}

/**
 * Extract absolute http(s) content URLs from plain reply text.
 * Returns de-duplicated URLs in first-seen order (empty array when none).
 */
export function extractContentUrls(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = trimTrailing(match[0]);
    // A scheme-only fragment ("https://") is not a real link.
    if (url.length <= "https://".length) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}
