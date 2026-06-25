import type { NegotiationProvider } from "./NegotiationProvider.js";
import type {
  NegotiationRequest,
  NegotiationResponse,
  NegotiationAction,
  DraftRequest,
  DraftResponse,
} from "./types.js";
import { agentBaseUrl, agentPostJson } from "../agentServiceClient.js";

// ---------------------------------------------------------------------------
// LangGraph negotiation provider
// ---------------------------------------------------------------------------
// Calls POST /negotiate and POST /draft on the Python agent service.
// Throws on any failure — no silent mock fallback in prod.
//
// Base URL, auth header (FIX-12), and timeout are handled by agentPostJson.

const VALID_ACTIONS = new Set<NegotiationAction>(["ACCEPT", "COUNTER", "REJECT", "ESCALATE"]);

function isValidAction(v: unknown): v is NegotiationAction {
  return typeof v === "string" && VALID_ACTIONS.has(v as NegotiationAction);
}

export class LangGraphNegotiationProvider implements NegotiationProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = agentBaseUrl(baseUrl);
  }

  async negotiate(req: NegotiationRequest): Promise<NegotiationResponse> {
    const data = await agentPostJson(this.baseUrl, "/negotiate", req);

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
    const data = await agentPostJson(this.baseUrl, "/draft", req);

    if (typeof data["subject"] !== "string" || typeof data["body"] !== "string") {
      throw new Error(
        `[LangGraphNegotiationProvider] malformed draft response: ${JSON.stringify(data)}`,
      );
    }

    return { subject: data["subject"], body: data["body"] };
  }
}
