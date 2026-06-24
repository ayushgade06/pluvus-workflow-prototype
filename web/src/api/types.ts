// ---------------------------------------------------------------------------
// API DTO mirror (Phase 9)
// ---------------------------------------------------------------------------
// Hand-mirrored from server/src/observability/dto.ts. The server is the source
// of truth for these shapes; this file is the frontend's view of the contract.

export type InstanceState =
  | "ENROLLED"
  | "OUTREACH_SENT"
  | "AWAITING_REPLY"
  | "FOLLOWED_UP"
  | "REPLY_RECEIVED"
  | "NEGOTIATING"
  | "ACCEPTED"
  | "REJECTED"
  | "OPTED_OUT"
  | "NO_RESPONSE"
  | "MANUAL_REVIEW";

export type MessageDirection = "OUTBOUND" | "INBOUND";
export type ReplyIntent = "POSITIVE" | "NEGATIVE" | "QUESTION" | "OPT_OUT" | "UNKNOWN";

// ---- workflow summary ----

export interface WorkflowNodeSummary {
  state: InstanceState;
  count: number;
  terminal: boolean;
  active: number;
  waiting: number;
  stuck: number;
  avgTimeInStateSeconds: number | null;
}

export interface WorkflowSummary {
  workflow: { id: string; name: string; version: number; versionId: string } | null;
  totalInstances: number;
  nodes: WorkflowNodeSummary[];
  generatedAt: string;
}

// ---- instance list ----

export interface InstanceListItem {
  instanceId: string;
  creatorId: string;
  creatorName: string;
  creatorEmail: string;
  creatorHandle: string | null;
  platform: string | null;
  state: InstanceState;
  currentNodeId: string | null;
  negotiationRound: number;
  followUpCount: number;
  dueAt: string | null;
  enrolledAt: string;
  updatedAt: string;
  waitingForSeconds: number;
  stuck: boolean;
  lastEventAt: string | null;
  lastEventType: string | null;
}

export interface InstanceList {
  items: InstanceListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ---- instance detail ----

export interface MessageDTO {
  id: string;
  direction: MessageDirection;
  subject: string | null;
  body: string;
  threadId: string | null;
  replyIntent: ReplyIntent | null;
  classifyConfidence: number | null;
  negotiationRound: number | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface EventDTO {
  id: string;
  type: string;
  nodeId: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
  source: string | null;
}

export interface AgentDecisionDTO {
  kind: "classification" | "negotiation";
  occurredAt: string;
  decision: string | null;
  confidence: number | null;
  round: number | null;
  reasoning: string | null;
  messageId: string | null;
}

export interface InstanceDetail {
  instance: {
    instanceId: string;
    workflowVersionId: string;
    workflowVersion: number | null;
    workflowName: string | null;
    state: InstanceState;
    currentNodeId: string | null;
    negotiationRound: number;
    followUpCount: number;
    dueAt: string | null;
    enrolledAt: string;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastTransitionSource: string | null;
  };
  creator: {
    id: string;
    name: string;
    email: string;
    handle: string | null;
    niche: string | null;
    platform: string | null;
  };
  messages: MessageDTO[];
  events: EventDTO[];
  agentDecisions: AgentDecisionDTO[];
}

// ---- timeline ----

export interface TimelineEntry {
  id: string;
  type: string;
  occurredAt: string;
  nodeId: string | null;
  source: string | null;
  summary: string;
  fromState: string | null;
  toState: string | null;
  payload: Record<string, unknown> | null;
}

export interface Timeline {
  instanceId: string;
  entries: TimelineEntry[];
}

// ---- logs ----

export interface LogEntry {
  occurredAt: string;
  fromState: string | null;
  toState: string | null;
  source: string | null;
  worker: string | null;
  queueJobId: string | null;
  nodeId: string | null;
  eventType: string;
}

export interface Logs {
  instanceId: string;
  trace: LogEntry[];
}

// ---- meta ----

export interface ObservabilityMeta {
  states: InstanceState[];
  terminalStates: InstanceState[];
  waitingStates: InstanceState[];
}
