import type { NegotiationProvider } from "./NegotiationProvider.js";
import type {
  NegotiationRequest,
  NegotiationResponse,
  NegotiationAction,
  DraftRequest,
  DraftResponse,
} from "./types.js";
import { MockNegotiationProvider } from "./MockNegotiationProvider.js";

// ---------------------------------------------------------------------------
// LangGraph negotiation provider
// ---------------------------------------------------------------------------
// Calls POST /negotiate and POST /draft on the agent service. Falls back to
// MockNegotiationProvider automatically when the service is unreachable.
//
//   AGENT_SERVICE_URL — base URL of the agent service (default http://localhost:8000)

const VALID_ACTIONS = new Set<NegotiationAction>(["ACCEPT", "COUNTER", "REJECT", "ESCALATE"]);

function isValidAction(v: unknown): v is NegotiationAction {
  return typeof v === "string" && VALID_ACTIONS.has(v as NegotiationAction);
}

export class LangGraphNegotiationProvider implements NegotiationProvider {
  private readonly baseUrl: string;
  private readonly fallback: NegotiationProvider;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000").replace(
      /\/$/,
      "",
    );
    this.fallback = new MockNegotiationProvider();
  }

  async negotiate(req: NegotiationRequest): Promise<NegotiationResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/negotiate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.warn(
          `[LangGraphNegotiationProvider] agent service returned ${res.status} — falling back to mock`,
        );
        return this.fallback.negotiate(req);
      }

      const data = (await res.json()) as Record<string, unknown>;
      if (!isValidAction(data["action"])) {
        console.warn(
          `[LangGraphNegotiationProvider] malformed negotiate response — falling back to mock`,
        );
        return this.fallback.negotiate(req);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[LangGraphNegotiationProvider] negotiate unavailable (${msg}) — falling back to mock`,
      );
      return this.fallback.negotiate(req);
    }
  }

  async draft(req: DraftRequest): Promise<DraftResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.warn(
          `[LangGraphNegotiationProvider] agent service /draft returned ${res.status} — falling back to mock`,
        );
        return this.fallback.draft(req);
      }

      const data = (await res.json()) as Record<string, unknown>;
      if (typeof data["subject"] !== "string" || typeof data["body"] !== "string") {
        console.warn(
          `[LangGraphNegotiationProvider] malformed draft response — falling back to mock`,
        );
        return this.fallback.draft(req);
      }

      return { subject: data["subject"], body: data["body"] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[LangGraphNegotiationProvider] draft unavailable (${msg}) — falling back to mock`,
      );
      return this.fallback.draft(req);
    }
  }
}
