import type {
  ExecutionInstance,
  Creator,
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

// EmailDraft — returned by MockEmailProvider.draft()
export interface EmailDraft {
  subject: string;
  body: string;
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
