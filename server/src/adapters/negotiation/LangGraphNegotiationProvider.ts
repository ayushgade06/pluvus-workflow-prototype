import type { NegotiationProvider } from "./NegotiationProvider.js";
import type {
  NegotiationRequest,
  NegotiationResponse,
  NegotiationAction,
  DraftRequest,
  DraftResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// LangGraph negotiation provider
// ---------------------------------------------------------------------------
// Calls POST /negotiate and POST /draft on the Python agent service.
// Throws on any failure — no silent mock fallback in prod.
//
//   AGENT_SERVICE_URL — base URL of the agent service (default: http://localhost:8000)

const VALID_ACTIONS = new Set<NegotiationAction>(["ACCEPT", "COUNTER", "REJECT", "ESCALATE"]);

function isValidAction(v: unknown): v is NegotiationAction {
  return typeof v === "string" && VALID_ACTIONS.has(v as NegotiationAction);
}

export class LangGraphNegotiationProvider implements NegotiationProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000").replace(
      /\/$/,
      "",
    );
  }

  async negotiate(req: NegotiationRequest): Promise<NegotiationResponse> {
    const res = await fetch(`${this.baseUrl}/negotiate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[LangGraphNegotiationProvider] /negotiate returned ${res.status}: ${body}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (!isValidAction(data["action"])) {
      throw new Error(
        `[LangGraphNegotiationProvider] malformed negotiate response: ${JSON.stringify(data)}`,
      );
    }

    const response: NegotiationResponse = { action: data["action"] };
    if (data["proposedTerms"] && typeof data["proposedTerms"] === "object") {
      response.proposedTerms = data["proposedTerms"] as NonNullable<NegotiationResponse["proposedTerms"]>;
    }
    if (typeof data["responseDraft"] === "string") {
      response.responseDraft = data["responseDraft"];
    }
    if (typeof data["reasoning"] === "string") {
      response.reasoning = data["reasoning"];
    }
    return response;
  }

  async draft(req: DraftRequest): Promise<DraftResponse> {
    const res = await fetch(`${this.baseUrl}/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `[LangGraphNegotiationProvider] /draft returned ${res.status}: ${body}`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data["subject"] !== "string" || typeof data["body"] !== "string") {
      throw new Error(
        `[LangGraphNegotiationProvider] malformed draft response: ${JSON.stringify(data)}`,
      );
    }

    return { subject: data["subject"], body: data["body"] };
  }
}
