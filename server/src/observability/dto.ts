// ---------------------------------------------------------------------------
// Observability DTOs (Phase 9, Part 8)
// ---------------------------------------------------------------------------
// These are the *only* shapes the observability API returns. Raw Prisma objects
// are never serialized to the client — every endpoint maps through a mapper in
// repository.ts. Keeping the contract here means the frontend has a single,
// stable type surface to import-mirror.

import type {
  InstanceState,
  EventType,
  MessageDirection,
  ReplyIntent,
} from "@prisma/client";

// ---------------------------------------------------------------------------
// Canonical workflow state order (matches stateMachine.ts transition table)
// ---------------------------------------------------------------------------
// The canvas lays nodes out in this order. ENROLLED → ... → terminal states.
// Kept here (not in the frontend) so the backend is the single source of truth
// for "what states exist and how they're ordered".

export const WORKFLOW_STATE_ORDER: InstanceState[] = [
  "ENROLLED",
  "OUTREACH_SENT",
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REWARD_PENDING",
  "REWARD_CONFIRMED",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

export const TERMINAL_STATES: InstanceState[] = [
  // ACCEPTED and REWARD_CONFIRMED are no longer terminal (they auto-advance into
  // Reward Setup and Payment Info); PAYMENT_RECEIVED is the new success terminal.
  "PAYMENT_RECEIVED",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

// States the scheduler can act on — used to flag "stuck" instances whose dueAt
// has long passed (waiting buckets). REWARD_PENDING and PAYMENT_PENDING wait on a
// creator action (reply / form submission) so they surface as waiting buckets.
export const WAITING_STATES: InstanceState[] = [
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REWARD_PENDING",
  "PAYMENT_PENDING",
];

// ---------------------------------------------------------------------------
// Workflow summary (GET /observability/workflow)
// ---------------------------------------------------------------------------

export interface WorkflowNodeSummaryDTO {
  state: InstanceState;
  /** Total instances currently in this state. */
  count: number;
  /** Whether this is a terminal state. */
  terminal: boolean;
  /** Instances in this state that are still "moving" (non-terminal). */
  active: number;
  /** Instances in a waiting state (AWAITING_REPLY / FOLLOWED_UP). */
  waiting: number;
  /** Instances flagged stuck: in a waiting state with dueAt long past. */
  stuck: number;
  /** Average time spent in this state, in seconds (null if not computable). */
  avgTimeInStateSeconds: number | null;
}

export interface WorkflowSummaryDTO {
  workflow: {
    id: string;
    name: string;
    version: number;
    versionId: string;
  } | null;
  totalInstances: number;
  nodes: WorkflowNodeSummaryDTO[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Instance list (GET /observability/instances)
// ---------------------------------------------------------------------------

export interface InstanceListItemDTO {
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
  /** Seconds since the instance last changed (proxy for time-in-state). */
  waitingForSeconds: number;
  /** True when in a waiting state and dueAt is well past. */
  stuck: boolean;
  lastEventAt: string | null;
  lastEventType: EventType | null;
}

export interface InstanceListDTO {
  items: InstanceListItemDTO[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Instance detail (GET /observability/instances/:id)
// ---------------------------------------------------------------------------

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
  type: EventType;
  nodeId: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
  /** Extracted from payload when present — who triggered this. */
  source: string | null;
}

export interface AgentDecisionDTO {
  /** "classification" | "negotiation" */
  kind: "classification" | "negotiation";
  occurredAt: string;
  /** Classification: intent. Negotiation: outcome. */
  decision: string | null;
  confidence: number | null;
  round: number | null;
  reasoning: string | null;
  messageId: string | null;
}

export interface InstanceDetailDTO {
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

// ---------------------------------------------------------------------------
// Timeline (GET /observability/timeline/:id)
// ---------------------------------------------------------------------------

export interface TimelineEntryDTO {
  id: string;
  type: EventType;
  occurredAt: string;
  nodeId: string | null;
  source: string | null;
  /** Human-readable one-line summary of the event. */
  summary: string;
  /** For STATE_TRANSITION events. */
  fromState: string | null;
  toState: string | null;
  payload: Record<string, unknown> | null;
}

export interface TimelineDTO {
  instanceId: string;
  entries: TimelineEntryDTO[];
}

// ---------------------------------------------------------------------------
// Logs / trace (GET /observability/logs/:id)
// ---------------------------------------------------------------------------

export interface LogEntryDTO {
  occurredAt: string;
  fromState: string | null;
  toState: string | null;
  source: string | null;
  worker: string | null;
  queueJobId: string | null;
  nodeId: string | null;
  eventType: EventType;
}

export interface LogsDTO {
  instanceId: string;
  /** Reconstructed transition trace, chronological. */
  trace: LogEntryDTO[];
}
