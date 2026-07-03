import type { ClassificationProvider } from "./ClassificationProvider.js";
import type { ClassificationRequest, ClassificationResponse, ReplyIntentValue } from "./types.js";

// ---------------------------------------------------------------------------
// Keyword + gate mock classifier (H2 — parity with the Python production gates)
// ---------------------------------------------------------------------------
// Returns deterministic results without calling any LLM. Used when
// AGENT_PROVIDER=mock (the default under NODE_ENV=test) or when no agent service
// is available.
//
// H2: this mock previously diverged from the production Python classifier
// (agent/app/injection.py + agent/app/routes/classify.py) on SAFETY- and
// COMPLIANCE-critical logic:
//   * no rate-statement gate — "I charge $480" fell to UNKNOWN/MANUAL_REVIEW,
//     the exact bug the Python `mentions_rate → POSITIVE` gate exists to prevent;
//   * no injection gate — an injection string could auto-advance state;
//   * an OPT_OUT keyword list that didn't match Python's (a missed opt-out is a
//     CAN-SPAM/GDPR risk);
//   * reversed precedence (NEGATIVE before QUESTION).
// It now mirrors the Python gate ORDER and the same regex patterns, so mock-mode
// dev/CI validates the behavior production actually runs.
//
// Production order (classify.py): sanitize → OPT_OUT (forced) → injection
// (→ UNKNOWN) → rate (→ POSITIVE) → question (→ QUESTION) → keyword LLM stand-in
// → low-confidence (→ UNKNOWN). Confidence is 1.0 for the deterministic gates
// (they are code decisions, not model guesses), 0.95/0.85 for keyword matches,
// and 0.50 for UNKNOWN (below the low-confidence threshold → MANUAL_REVIEW).

// --- OPT_OUT (mirrors _OPT_OUT_PATTERNS in agent/app/injection.py) ------------
const OPT_OUT_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\bremove me\b/i,
  /\bplease remove\b/i,
  /\btake me off\b/i,
  /\bstop emailing\b/i,
  /\bstop (?:sending|contacting|messaging)\b/i,
  /\bdo not (?:contact|email|message)\b/i,
  /\bdon'?t (?:contact|email|message) me\b/i,
  /\bno longer (?:wish|want) to (?:receive|be contacted)\b/i,
];

// --- Injection (mirrors _INJECTION_PATTERNS in agent/app/injection.py) --------
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions?|prompts?|messages?)\b/i,
  /\bdisregard (?:all |any |the )?(?:previous|prior|above|earlier)\b/i,
  /\bforget (?:everything|all|your|the) (?:above|previous|prior|instructions?)\b/i,
  /\byou are now\b/i,
  /\byou must now\b/i,
  /\bnew instructions?\b/i,
  /\bsystem prompt\b/i,
  /\brespond (?:with|only with) (?:intent|the intent|confidence)\b/i,
  /\bset (?:your )?confidence (?:to|=)\b/i,
  /\bact as\b.*\b(?:assistant|model|ai)\b/i,
  /\boverride\b.*\b(?:rules?|instructions?|settings?)\b/i,
  /\breveal\b.*\b(?:floor|ceiling|budget|maximum|minimum|system prompt)\b/i,
  /\bwhat(?:'s| is) your (?:system prompt|instructions?|maximum|budget|ceiling)\b/i,
];

// --- Rejection cues: suppress the rate/question gates (mirrors _REJECTION_PATTERNS) -
const REJECTION_PATTERNS: RegExp[] = [
  /\bno\s+thanks?\b/i,
  /\bnot\s+interested\b/i,
  /\bnot\s+(?:a\s+)?(?:good|right)\s+fit\b/i,
  /\bi'?ll?\s+pass\b/i,
  /\bi\s+(?:can'?t|cannot|won'?t)\b/i,
  /\bdecline\b/i,
  /\btoo\s+low\b/i,
  /\bway\s+(?:more|too)\b/i,
];

// --- Rate statement (mirrors _AMOUNT + _RATE_STATEMENT_PATTERNS) --------------
const AMOUNT = String.raw`(?:\$\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:dollars?|usd|bucks))`;
const RATE_STATEMENT_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\bi\s+charge\b.*?${AMOUNT}`, "is"),
  new RegExp(String.raw`\bmy\s+(?:rate|fee|price|quote)\s+(?:is|would be|=)\b.*?${AMOUNT}`, "is"),
  new RegExp(String.raw`\b(?:i'?d|i\s+would)\s+do\s+it\s+for\b.*?${AMOUNT}`, "is"),
  new RegExp(String.raw`\b(?:rate|fee|price)\s*[:=]\s*${AMOUNT}`, "is"),
  new RegExp(String.raw`\bfor\s+${AMOUNT}\b.*\b(?:i'?m\s+in|works?|deal|sounds?\s+good)\b`, "is"),
  new RegExp(String.raw`^\W*${AMOUNT}\W*$`, "is"),
];

// --- Question (mirrors _QUESTION_PATTERNS) -----------------------------------
const QUESTION_GATE_PATTERNS: RegExp[] = [
  /\bwhat(?:'s| is)\b.*\b(?:product|brand|budget|fee|rate|base|commission|deal|structure|company|offer)\b/is,
  /\bwhat\s+(?:do|does|are)\b.*\byou\b/is,
  /\bcan\s+you\s+(?:tell|share|send)\b/is,
  /\bhow\s+(?:much|does|do|would)\b.*\b(?:pay|fee|rate|budget|commission|work)\b/is,
  /\bwho\s+(?:is|are)\b.*\b(?:brand|company|you)\b/is,
  /\bmore\s+(?:info|information|details?)\b/is,
  /\btell\s+me\s+more\b/is,
  /\bquick\s+question/is,
  /\b(?:before\s+i)\b.*\b(?:say|commit|agree|decide)\b/is,
];

// --- Keyword LLM stand-in (only reached when no gate fires) -------------------
const POSITIVE_KEYWORDS = [
  "yes", "interested", "love to", "sounds great", "definitely", "absolutely",
  "would love", "happy to", "excited", "let's do it", "let's talk", "sure",
];
const NEGATIVE_KEYWORDS = [
  "not interested", "no thanks", "no thank you", "decline", "pass",
  "don't want", "not at this time", "not right now",
];
const QUESTION_KEYWORDS = [
  "?", "what is", "what are", "how much", "how does", "tell me more",
  "can you", "could you", "would you", "commission", "rate", "details",
  "what does", "who is", "when", "where",
];

function anyMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}
function keywordMatch(lower: string, keywords: string[]): boolean {
  return keywords.some((kw) => lower.includes(kw));
}

/** Mirror of agent/app/injection.py sanitize_creator_text (bounded subset).
 *  Normalize + strip control chars so the gates see the same text as Python. */
export function sanitizeCreatorText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const controlChars = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
  return text
    .normalize("NFKC")
    .replace(controlChars, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 4000)
    .trim();
}

// Reject language present → do NOT force POSITIVE/QUESTION; let keyword logic run.
function hasRejection(text: string): boolean {
  return anyMatch(text, REJECTION_PATTERNS);
}
function looksLikeOptOut(text: string): boolean {
  return anyMatch(text, OPT_OUT_PATTERNS);
}
function looksLikeInjection(text: string): boolean {
  return anyMatch(text, INJECTION_PATTERNS);
}
function mentionsRate(text: string): boolean {
  if (hasRejection(text)) return false;
  return anyMatch(text, RATE_STATEMENT_PATTERNS);
}
function looksLikeQuestion(text: string): boolean {
  if (hasRejection(text)) return false;
  return anyMatch(text, QUESTION_GATE_PATTERNS);
}

export class MockClassificationProvider implements ClassificationProvider {
  async classify(req: ClassificationRequest): Promise<ClassificationResponse> {
    const clean = sanitizeCreatorText(req.message);
    const lower = clean.toLowerCase();

    // 1 — OPT_OUT (compliance-critical; forced, cannot be model-suppressed).
    if (looksLikeOptOut(clean)) {
      return { intent: "OPT_OUT", confidence: 1.0, reasoning: "deterministic opt-out keyword match" };
    }
    // 2 — injection/jailbreak → do not trust auto-advance; route to MANUAL_REVIEW.
    if (looksLikeInjection(clean)) {
      return { intent: "UNKNOWN", confidence: 0.0, reasoning: "possible prompt-injection detected" };
    }
    // 3 — rate statement → POSITIVE (engaged; reaches negotiation).
    if (mentionsRate(clean)) {
      return { intent: "POSITIVE", confidence: 1.0, reasoning: "deterministic rate-statement match" };
    }
    // 4 — product/deal question → QUESTION (engaged; reaches negotiation).
    if (looksLikeQuestion(clean)) {
      return { intent: "QUESTION", confidence: 1.0, reasoning: "deterministic question-phrase match" };
    }

    // 5 — keyword stand-in for the LLM. NEGATIVE before POSITIVE ("not
    // interested" contains "interested"); QUESTION last (matches Python's
    // keyword fallthrough), so an explicit refusal wins over a trailing "?".
    if (keywordMatch(lower, NEGATIVE_KEYWORDS)) {
      return { intent: "NEGATIVE", confidence: 0.95, reasoning: "negative keyword match" };
    }
    if (keywordMatch(lower, POSITIVE_KEYWORDS)) {
      return { intent: "POSITIVE", confidence: 0.95, reasoning: "positive keyword match" };
    }
    if (keywordMatch(lower, QUESTION_KEYWORDS)) {
      return { intent: "QUESTION", confidence: 0.85, reasoning: "question keyword match" };
    }

    return { intent: "UNKNOWN", confidence: 0.5, reasoning: "no keyword match" };
  }
}

// ---------------------------------------------------------------------------
// Fixed-intent mock — for harness scenarios that need a specific outcome
// ---------------------------------------------------------------------------

export class FixedClassificationProvider implements ClassificationProvider {
  constructor(
    private readonly intent: ReplyIntentValue,
    private readonly confidence: number = 0.95,
  ) {}

  async classify(_req: ClassificationRequest): Promise<ClassificationResponse> {
    return { intent: this.intent, confidence: this.confidence };
  }
}
