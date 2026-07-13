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
    // M5: `tone` removed — it was never populated (buildNegotiationRequest never
    // set it) and never read (the Python prompt hardcodes tone). Dead field.
    senderName?: string;
    brandDescription?: string;
    /** Brand-supplied scope the AI may state as fact (e.g. "3 IG Reels"). */
    deliverables?: string;
    /** Brand-supplied go-live timeline; the AI states it only when present. */
    timeline?: string;
    /**
     * Brand-set commission % (hybrid deals). NON-negotiable: only the fixed fee
     * moves. Threaded so the LLM can state it as fixed when a creator tries to
     * change it, and so the output guard can block a draft that alters it.
     */
    commissionRate?: number;
    /** Brand-supplied product/sample perk (e.g. "a free pair of shoes"). Also
     *  NON-negotiable — the LLM states it as a standard part of the offer. */
    rewardDescription?: string;
    /**
     * M1: where in the [floor, ceiling] band the recommended opening offer sits,
     * as a fraction 0..1. Default 0.5 (midpoint). Lets a campaign open lower or
     * higher without a code change.
     */
    recommendedOfferPosition?: number;
    /**
     * Phase C (#12): merchant tolerance ABOVE the ceiling, as a percent. Default
     * 0 (zero tolerance — escalate the moment an ask exceeds the ceiling). When
     * > 0, an ask up to ceiling*(1 + tolerance/100) is countered AT the ceiling
     * (never above); anything higher escalates. V1 applies only to the fixed fee.
     */
    overCeilingTolerance?: number;
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
  /**
   * Comprehension carried across the /negotiate → /draft seam so the SENT email
   * answers every question and acknowledges pushed fixed terms, instead of
   * /draft re-parsing the raw reply. See
   * .claude/spec/draft-comprehension-threading.md §5.4.
   * Every distinct question/request the creator raised this turn.
   */
  creatorQuestions?: string[];
  /** Which FIXED terms the creator pushed to change, from the closed vocabulary
   *  commission|perk|deliverables|timeline. */
  pushedFixedTerms?: string[];
  /** MED-N3: the creator's own stated fee this turn, extracted by the model and
   *  substring-validated agent-side (digits must appear in the reply; ranges
   *  rejected). Feeds the engine's money path; absent when none was named. */
  creatorRequestedRate?: number;
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
  /** Free-text product/sample reward blurb (e.g. "a free pair of our running
   *  shoes"). Mentioned in the copy only when present. */
  rewardDescription?: string | undefined;
  /** Creator's questions, extracted upstream by /negotiate so /draft answers an
   *  explicit checklist instead of re-parsing the raw reply (spec §5.5). */
  creatorQuestions?: string[] | undefined;
  /** Fixed terms the creator pushed on (commission|perk|deliverables|timeline),
   *  so the copy ACKNOWLEDGES the ask rather than silently restating the value. */
  pushedFixedTerms?: string[] | undefined;
  /** HARD-N2: the conversation so far (both sides), so the copywriter can see the
   *  prior emails and not contradict them or repeat wording. Chronological. */
  history?: DraftHistoryEntry[] | undefined;
  /** HARD-N2 answered-questions ledger: questions the creator raised in EARLIER
   *  rounds that our prior emails never answered, re-surfaced so they aren't
   *  silently dropped. Distinct from creatorQuestions (this turn's asks). */
  openQuestions?: string[] | undefined;
}

/** HARD-N2: one turn of the threaded /draft conversation. `role` is "us" for a
 *  turn we sent, "creator" for the creator's own inbound message. */
export interface DraftHistoryEntry {
  role: "us" | "creator";
  round?: number | undefined;
  action?: NegotiationAction | undefined;
  rate?: number | undefined;
  message?: string | undefined;
}

export interface DraftResponse {
  subject: string;
  body: string;
}
