// ---------------------------------------------------------------------------
// Negotiation adapter — shared types
// ---------------------------------------------------------------------------

export type NegotiationAction = "ACCEPT" | "COUNTER" | "REJECT" | "ESCALATE";

export interface NegotiationTerm {
  rate?: number;
  deliverables?: string[];
  timeline?: string;
  [key: string]: unknown;
}

export interface NegotiationRequest {
  creatorReply: string;
  currentOffer: NegotiationTerm;
  round: number;
  maxRounds: number;
  negotiationHistory: NegotiationHistoryEntry[];
  campaignConstraints: {
    termFloor: NegotiationTerm;
    termCeiling: NegotiationTerm;
    tone?: string;
    senderName?: string;
  };
}

export interface NegotiationHistoryEntry {
  round: number;
  action: NegotiationAction;
  terms?: NegotiationTerm;
  message?: string;
}

export interface NegotiationResponse {
  action: NegotiationAction;
  proposedTerms?: NegotiationTerm;
  responseDraft?: string;
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// Draft types
// ---------------------------------------------------------------------------

export interface DraftRequest {
  purpose: "initial_outreach" | "follow_up" | "counter_offer" | "acceptance" | "onboarding";
  creatorName: string;
  creatorPlatform?: string | undefined;
  creatorNiche?: string | undefined;
  senderName?: string | undefined;
  round?: number | undefined;
  proposedTerms?: NegotiationTerm | undefined;
  campaignContext?: Record<string, unknown> | undefined;
  /** The creator's most recent message — lets the copy continue the
   *  conversation instead of reading like a cold first contact. */
  creatorReply?: string | undefined;
  /** The rate the creator asked for this turn, if any — lets a counter
   *  acknowledge it explicitly ("we considered your request of $480 …"). */
  creatorRequestedRate?: number | undefined;
}

export interface DraftResponse {
  subject: string;
  body: string;
}
