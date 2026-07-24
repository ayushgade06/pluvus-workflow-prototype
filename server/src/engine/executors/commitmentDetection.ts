import type { ConversationObligation } from "../../db/schema.js";

// ---------------------------------------------------------------------------
// PLU-111 §4.8 — deriving Pluvus commitments from a SENT deferral
// ---------------------------------------------------------------------------
// The agent answers a question either directly OR with an honest DEFERRAL ("we'll
// confirm the usage rights on the next step"). A deferral is a valid answer to
// the creator, but it means Pluvus now OWES an action — a durable commitment.
//
// At flush time (when a reply actually sends), for each open question the send
// was meant to resolve, we scan the SENT body for a deferral marker NEAR that
// question's topic. If deferred → the question goes DEFERRED (stays open) and a
// PLUVUS_COMMITMENT is minted; else → ANSWERED.
//
// This mirrors the agent's OWN deferral vocabulary (negotiate.py _DEFERRAL_MARKERS
// / _draft_questions_to_verify) so v1 needs no new model call. It is deliberately
// conservative: a false-NEGATIVE (a deferral phrased outside this vocabulary) just
// degrades to today's behavior (nothing tracked) — never to a wrong state. A
// structured `pluvusCommitments` agent field is the robust follow-up (§4.8 / O4).

/** Specific deferral phrases (mirrors negotiate.py _DEFERRAL_MARKERS). Kept as
 *  phrases, not bare words, so innocuous copy ("working together") never matches. */
export const DEFERRAL_MARKERS: readonly string[] = [
  "confirm the",
  "confirm together",
  "confirm that",
  "confirm the exact",
  "finalize together",
  "finalise together",
  "on the next step",
  "next step",
  "as we finalize",
  "as we finalise",
  "we'll share",
  "will share",
  "provide the details",
  "get back to you",
  "let you know",
  "follow up with",
  "to be confirmed",
  "confirmed together",
];

const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "our", "with", "that", "this", "have",
  "what", "when", "where", "which", "will", "would", "could", "should", "can",
  "are", "was", "how", "why", "who", "does", "did", "about", "from", "into",
  "any", "all", "not", "but", "get", "got",
]);

/** Distinctive content words (>=3 chars, non-stopword) from a piece of text. */
function contentWords(text: string): Set<string> {
  const toks = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return new Set(toks.filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

/** Does the body contain any deferral marker? */
function hasDeferralMarker(bodyLower: string): boolean {
  return DEFERRAL_MARKERS.some((m) => bodyLower.includes(m));
}

/** Topic keywords per obligation category, so a deferral "near the topic" can be
 *  detected even when the exact question wording isn't echoed. */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  usage_rights: ["usage", "rights", "license", "licensing", "exclusivity", "whitelist"],
  shipping: ["ship", "shipping", "address", "delivery", "tracking"],
  timeline: ["timeline", "deadline", "schedule", "turnaround"],
  payment: ["payment", "payout", "invoice", "paypal", "paid"],
  deliverables: ["deliverable", "deliverables", "reel", "reels", "story", "stories", "post", "posts"],
};

/**
 * Decide whether a SENT body DEFERRED a given question obligation (§4.8).
 *
 * Conservative: requires BOTH a deferral marker present in the body AND the
 * deferral being about THIS question's topic — signalled by the body sharing a
 * distinctive content word with the question, or mentioning a keyword for the
 * question's category. Without the topic link, a deferral marker elsewhere in the
 * email (about a different question) must NOT mark this one deferred.
 */
export function isQuestionDeferredBySentBody(
  obligation: ConversationObligation,
  body: string,
): boolean {
  const bodyLower = body.toLowerCase();
  if (!hasDeferralMarker(bodyLower)) return false;

  // Topic overlap: any distinctive question content word appears in the body …
  const qWords = contentWords(obligation.originalText);
  for (const w of qWords) {
    if (bodyLower.includes(w)) return true;
  }
  // … or a keyword for the question's category appears in the body.
  const catKeywords = obligation.category ? CATEGORY_KEYWORDS[obligation.category] : undefined;
  if (catKeywords) {
    for (const k of catKeywords) {
      if (bodyLower.includes(k)) return true;
    }
  }
  return false;
}
