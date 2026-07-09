import type { ClassificationProvider } from "./ClassificationProvider.js";
import type { ClassificationRequest, ClassificationResponse, ReplyIntentValue } from "./types.js";
import { compiledGates } from "./classifierSpec.js";

// ---------------------------------------------------------------------------
// Keyword + gate mock classifier (H2 / MED-A2 — parity with the Python gates)
// ---------------------------------------------------------------------------
// Returns deterministic results without calling any LLM. Used when
// AGENT_PROVIDER=mock (the default under NODE_ENV=test) or when no agent service
// is available.
//
// H2: this mock previously diverged from the production Python classifier
// (agent/app/injection.py + agent/app/routes/classify.py) on SAFETY- and
// COMPLIANCE-critical logic (missing rate/injection gates, a mismatched OPT_OUT
// list, reversed precedence).
//
// MED-A2: the deterministic gate patterns + order are no longer hand-maintained
// here. They are loaded from shared/classifier-spec.json — the SINGLE SOURCE OF
// TRUTH both this mock and the Python gates derive from — so the two can no
// longer drift silently. A parity test on each side runs the spec's `fixture`.
// Only the keyword LLM stand-in lists below (the mock's approximation of the LLM
// call, which has no Python-gate counterpart) stay local.
//
// Production order (classify.py): sanitize → OPT_OUT (forced) → injection
// (→ UNKNOWN) → rate (→ POSITIVE) → question (→ QUESTION) → keyword LLM stand-in
// → low-confidence (→ UNKNOWN). Confidence is 1.0 for the deterministic gates
// (they are code decisions, not model guesses), 0.95/0.85 for keyword matches,
// and 0.50 for UNKNOWN (below the low-confidence threshold → MANUAL_REVIEW).

// Deterministic gates compiled from the shared spec (MED-A2). optOut/injection/
// rejection/rate/question mirror agent/app/injection.py by construction.
const GATES = compiledGates();
const OPT_OUT_PATTERNS = GATES.optOut;
const INJECTION_PATTERNS = GATES.injection;
const REJECTION_PATTERNS = GATES.rejection;
const RATE_STATEMENT_PATTERNS = GATES.rate;
const QUESTION_GATE_PATTERNS = GATES.question;

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
