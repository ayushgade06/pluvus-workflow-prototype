// ---------------------------------------------------------------------------
// Negotiation adapter — shared types
// ---------------------------------------------------------------------------

export type NegotiationAction = "ACCEPT" | "COUNTER" | "REJECT" | "ESCALATE" | "PRESENT_OFFER";

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
    brandDescription?: string;
    /** Brand-supplied scope the AI may state as fact (e.g. "3 IG Reels"). */
    deliverables?: string;
    /** Brand-supplied go-live timeline; the AI states it only when present. */
    timeline?: string;
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
  purpose:
    | "initial_outreach"
    | "follow_up"
    | "counter_offer"
    | "acceptance"
    | "onboarding"
    // Reward Setup: the "Campaign Agreement Confirmation" email that summarizes
    // the finalized fee/commission/deliverables and asks the creator to reply
    // "I Agree" to confirm the partnership.
    | "reward_confirmation";
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
  /** Short, number-free description of the deal structure (e.g. hybrid =
   *  fixed fee + commission) so outreach explains the real offer. */
  dealDescription?: string | undefined;
  /** What the brand does / sells — lets the LLM answer creator questions like
   *  "what does your brand do?" without hallucinating. */
  brandDescription?: string | undefined;
  /** Brand-supplied deliverables (e.g. "3 IG Reels + 1 YouTube integration")
   *  so outreach/counter copy states real scope instead of "to be finalized". */
  deliverables?: string | undefined;
  /** Brand-supplied go-live timeline; stated only when present, never invented. */
  timeline?: string | undefined;
}

export interface DraftResponse {
  subject: string;
  body: string;
}
