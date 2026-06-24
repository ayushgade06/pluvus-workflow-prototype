import type { ClassificationProvider } from "./ClassificationProvider.js";
import type { ClassificationRequest, ClassificationResponse, ReplyIntentValue } from "./types.js";
import { MockClassificationProvider } from "./MockClassificationProvider.js";

// ---------------------------------------------------------------------------
// LangGraph classification provider
// ---------------------------------------------------------------------------
// Calls POST /classify on the agent service (FastAPI + LangGraph). If the
// agent service is unreachable, falls back to MockClassificationProvider so
// the system can run without a live LLM.
//
//   AGENT_SERVICE_URL  — base URL of the agent service (default: http://localhost:8000)

const VALID_INTENTS = new Set<ReplyIntentValue>([
  "POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN",
]);

function isValidIntent(value: unknown): value is ReplyIntentValue {
  return typeof value === "string" && VALID_INTENTS.has(value as ReplyIntentValue);
}

export class LangGraphClassificationProvider implements ClassificationProvider {
  private readonly baseUrl: string;
  private readonly fallback: ClassificationProvider;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000").replace(
      /\/$/,
      "",
    );
    this.fallback = new MockClassificationProvider();
  }

  async classify(req: ClassificationRequest): Promise<ClassificationResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/classify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: req.message }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        console.warn(
          `[LangGraphClassificationProvider] agent service returned ${res.status} — falling back to mock`,
        );
        return this.fallback.classify(req);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const intent = data["intent"];
      const confidence = data["confidence"];

      if (!isValidIntent(intent) || typeof confidence !== "number") {
        console.warn(
          `[LangGraphClassificationProvider] malformed agent response — falling back to mock`,
        );
        return this.fallback.classify(req);
      }

      const response: ClassificationResponse = { intent, confidence };
      if (typeof data["reasoning"] === "string") {
        response.reasoning = data["reasoning"];
      }
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[LangGraphClassificationProvider] agent service unavailable (${msg}) — falling back to mock`,
      );
      return this.fallback.classify(req);
    }
  }
}
