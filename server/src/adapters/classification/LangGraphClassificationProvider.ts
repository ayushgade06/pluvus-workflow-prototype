import type { ClassificationProvider } from "./ClassificationProvider.js";
import type { ClassificationRequest, ClassificationResponse, ReplyIntentValue } from "./types.js";

// ---------------------------------------------------------------------------
// LangGraph classification provider
// ---------------------------------------------------------------------------
// Calls POST /classify on the Python agent service (FastAPI + LangGraph).
// Throws on any failure — no silent mock fallback in prod.
//
//   AGENT_SERVICE_URL — base URL of the agent service (default: http://localhost:8000)

const VALID_INTENTS = new Set<ReplyIntentValue>([
  "POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN",
]);

function isValidIntent(value: unknown): value is ReplyIntentValue {
  return typeof value === "string" && VALID_INTENTS.has(value as ReplyIntentValue);
}

export class LangGraphClassificationProvider implements ClassificationProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000").replace(
      /\/$/,
      "",
    );
  }

  async classify(req: ClassificationRequest): Promise<ClassificationResponse> {
    const res = await fetch(`${this.baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: req.message }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[LangGraphClassificationProvider] agent service returned ${res.status}: ${body}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
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
