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
export type NegotiateOutcome = "accept" | "counter" | "reject" | "escalate";

export interface NegotiateResult {
  outcome: NegotiateOutcome;
  message: string;
}
