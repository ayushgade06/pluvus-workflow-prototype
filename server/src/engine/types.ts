import type {
  ExecutionInstance,
  Creator,
  Campaign,
  InstanceState,
  EventType,
  ReplyIntent,
} from "@prisma/client";

// NodeSnapshot — matches what is stored in WorkflowVersion.nodeGraph
export interface NodeSnapshot {
  id: string;
  type: string;
  order: number;
  config: Record<string, unknown>;
}

// ExecutionContext — everything a node executor needs
export interface ExecutionContext {
  instance: ExecutionInstance;
  node: NodeSnapshot;
  nodeGraph: NodeSnapshot[];
  creator: Creator;
  // H5: the parent campaign, when the workflow is linked to one. Used as a
  // FALLBACK source of brand context (brandDescription/deliverables/timeline/
  // rewardDescription/senderName) for the LLM when a node's config wasn't stamped
  // with them (e.g. imported/legacy workflows). Null for seeded/legacy workflows
  // that predate campaigns (campaignId is null) — those rely on node config.
  campaign?: Campaign | null;
}

// NodeResult — what a node executor returns
export interface NodeResult {
  nextState: InstanceState;
  nextNodeId: string | null;
  followUpCount?: number;
  negotiationRound?: number;
  dueAt?: Date | null;
  completedAt?: Date | null;
  eventType: EventType;
  eventPayload?: Record<string, unknown>;
}

// EmailAttachment — an out-of-body file to send alongside an email (Phase 16).
// Bytes are carried as a Buffer; the provider is responsible for encoding them
// for the wire (Nylas expects base64). Only the Content Brief node sets this
// today; every other draft omits it, so the send path is unchanged for them.
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

// EmailDraft — returned by MockEmailProvider.draft()
export interface EmailDraft {
  subject: string;
  body: string;
  /** Optional file attachments. Absent for all nodes except Content Brief. */
  attachments?: EmailAttachment[];
}

// ClassifyResult — returned by MockAgentProvider.classify()
export interface ClassifyResult {
  intent: ReplyIntent;
  confidence: number;
}

// NegotiateResult — returned by MockAgentProvider.negotiate()
//   present_offer: the creator asked about terms (no number proposed); present
//   the fee+commission but do NOT consume a negotiation round (informational).
export type NegotiateOutcome = "accept" | "counter" | "reject" | "escalate" | "present_offer";

export interface NegotiateResult {
  outcome: NegotiateOutcome;
  message: string;
  /**
   * The rate the agent proposed/agreed on this turn, if any. Surfaced so the
   * executor can persist it in the NEGOTIATION_TURN event and thread it back as
   * `currentOffer` on the next turn (FIX-2). Undefined for reject/escalate or
   * when the provider returned no numeric term.
   */
  proposedRate?: number;
  /**
   * Comprehension threaded from /negotiate across the seam (spec §6.1): the
   * executor destructures these and spreads them into the /draft `extra` so the
   * SENT email answers every question and acknowledges pushed fixed terms.
   * Undefined when the provider emitted none (e.g. rules mode).
   *   creatorQuestions — every question/request the creator raised this turn.
   *   pushedFixedTerms — fixed terms (commission|perk|deliverables|timeline) the
   *     creator tried to change.
   */
  creatorQuestions?: string[];
  pushedFixedTerms?: string[];
  /**
   * MED-N3: the creator's OWN stated ask this turn, as comprehended by the
   * /negotiate model and validated in the agent (digits must appear verbatim in
   * the reply; ranges rejected). This is the number the MONEY path may record
   * (context.creatorRate on a brand decision → the deal rate on APPROVE) — the
   * executor must not substitute a regex read for it. Undefined when the
   * creator named no single figure.
   */
  creatorRequestedRate?: number;
}

// PriorNegotiationContext — assembled by the executor (the state authority) and
// threaded into agent.negotiate() so the stateless agent can reason about the
// conversation so far (FIX-1 history threading, FIX-2 current-offer tracking).
//   - history:      prior turns in chronological order
//   - currentOffer: the rate actually last proposed by us, if known
export interface PriorNegotiationContext {
  history: NegotiationHistoryEntryLite[];
  currentOffer?: number | undefined;
}

// A trimmed history entry the executor can build purely from persisted events.
export interface NegotiationHistoryEntryLite {
  round: number;
  action: "ACCEPT" | "COUNTER" | "REJECT" | "ESCALATE" | "PRESENT_OFFER";
  rate?: number | undefined;
  message?: string | undefined;
}
