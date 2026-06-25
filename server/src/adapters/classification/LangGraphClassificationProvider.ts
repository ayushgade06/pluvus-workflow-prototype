import type { ClassificationProvider } from "./ClassificationProvider.js";
import type { ClassificationRequest, ClassificationResponse, ReplyIntentValue } from "./types.js";
import { agentBaseUrl, agentPostJson } from "../agentServiceClient.js";

// ---------------------------------------------------------------------------
// LangGraph classification provider
// ---------------------------------------------------------------------------
// Calls POST /classify on the Python agent service (FastAPI + LangGraph).
// Throws on any failure — no silent mock fallback in prod.
//
// Base URL, auth header (FIX-12), and timeout are handled by agentPostJson.

const VALID_INTENTS = new Set<ReplyIntentValue>([
  "POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN",
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
    const data = await agentPostJson(this.baseUrl, "/classify", { message: req.message });

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
    return response;
  }
}
