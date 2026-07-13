import type { ClassificationProvider } from "./ClassificationProvider.js";
import type { ClassificationRequest, ClassificationResponse, ReplyIntentValue } from "./types.js";
import { agentBaseUrl, agentPostJson, classifyTimeoutMs } from "../agentServiceClient.js";

// ---------------------------------------------------------------------------
// LangGraph classification provider
// ---------------------------------------------------------------------------
// Calls POST /classify on the Python agent service (FastAPI + LangGraph).
// Throws on any failure — no silent mock fallback in prod.
//
// Base URL, auth header (FIX-12), and timeout are handled by agentPostJson.

// Must stay in sync with ReplyIntentValue (types.ts) / the Prisma ReplyIntent
// enum / the agent's classify intents. A missing member here rejects an
// otherwise-valid agent response as "malformed" and degrades it to UNKNOWN →
// MANUAL_REVIEW. That is exactly what silently swallowed Phase D's DEFERRED:
// the agent returned DEFERRED@0.95 but this allowlist (which predated Phase D)
// didn't list it, so every "I'll think about it" reply was mis-routed to a human.
const VALID_INTENTS = new Set<ReplyIntentValue>([
  "POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN", "DEFERRED",
]);

function isValidIntent(value: unknown): value is ReplyIntentValue {
  return typeof value === "string" && VALID_INTENTS.has(value as ReplyIntentValue);
}

export class LangGraphClassificationProvider implements ClassificationProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = agentBaseUrl(baseUrl);
  }

  async classify(req: ClassificationRequest): Promise<ClassificationResponse> {
    // Classify uses the shorter fail-fast timeout (it's a single short
    // generation on the interactive reply path), not the long draft budget.
    const data = await agentPostJson(
      this.baseUrl,
      "/classify",
      { message: req.message },
      { timeoutMs: classifyTimeoutMs() },
    );

    const intent = data["intent"];
    const confidence = data["confidence"];

    if (!isValidIntent(intent) || typeof confidence !== "number") {
      throw new Error(
        `[LangGraphClassificationProvider] malformed agent response: ${JSON.stringify(data)}`,
      );
    }

    const response: ClassificationResponse = { intent, confidence };
    if (typeof data["reasoning"] === "string") {
      response.reasoning = data["reasoning"];
    }
    // Phase E (#5): carry the always-escalate topic reason across the seam. This
    // adapter reconstructs the response field-by-field, so an uncopied field is
    // silently dropped before the executor ever sees it.
    if (typeof data["escalationReason"] === "string" && data["escalationReason"]) {
      response.escalationReason = data["escalationReason"];
    }
    return response;
  }
}
