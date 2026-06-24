import type { ClassificationProvider } from "./ClassificationProvider.js";
import type { ClassificationRequest, ClassificationResponse, ReplyIntentValue } from "./types.js";

// ---------------------------------------------------------------------------
// Keyword-based mock classifier
// ---------------------------------------------------------------------------
// Returns deterministic results without calling any LLM. Used when
// AGENT_PROVIDER != "langgraph" or when no API key is present.
// Confidence is always 0.95 for positive keyword matches, 0.50 for UNKNOWN
// (below the 0.70 threshold so UNKNOWN always routes safely to MANUAL_REVIEW).

const POSITIVE_KEYWORDS = [
  "yes", "interested", "love to", "sounds great", "definitely", "absolutely",
  "would love", "happy to", "excited", "let's do it", "let's talk", "sure",
];

const NEGATIVE_KEYWORDS = [
  "not interested", "no thanks", "no thank you", "decline", "pass",
  "don't want", "not at this time", "not right now",
];

const OPT_OUT_KEYWORDS = [
  "unsubscribe", "remove me", "opt out", "opt-out", "stop emailing",
  "take me off", "do not contact", "please remove",
];

const QUESTION_KEYWORDS = [
  "?", "what is", "what are", "how much", "how does", "tell me more",
  "can you", "could you", "would you", "commission", "rate", "details",
  "what does", "who is", "when", "where",
];

function matchesAny(lower: string, keywords: string[]): boolean {
  return keywords.some((kw) => lower.includes(kw));
}

export class MockClassificationProvider implements ClassificationProvider {
  async classify(req: ClassificationRequest): Promise<ClassificationResponse> {
    const lower = req.message.toLowerCase();

    if (matchesAny(lower, OPT_OUT_KEYWORDS)) {
      return { intent: "OPT_OUT", confidence: 0.95, reasoning: "opt-out keyword match" };
    }
    if (matchesAny(lower, NEGATIVE_KEYWORDS)) {
      return { intent: "NEGATIVE", confidence: 0.95, reasoning: "negative keyword match" };
    }
    if (matchesAny(lower, POSITIVE_KEYWORDS)) {
      return { intent: "POSITIVE", confidence: 0.95, reasoning: "positive keyword match" };
    }
    if (matchesAny(lower, QUESTION_KEYWORDS)) {
      return { intent: "QUESTION", confidence: 0.85, reasoning: "question keyword match" };
    }

    return { intent: "UNKNOWN", confidence: 0.50, reasoning: "no keyword match" };
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
