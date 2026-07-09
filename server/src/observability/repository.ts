// ---------------------------------------------------------------------------
// Observability repository (Phase 9, Part 8)
// ---------------------------------------------------------------------------
// Read-only queries + DTO mappers for the observability dashboard. This is the
// boundary that guarantees raw Prisma rows never reach the client.
//
// Phase 9 is read-only: nothing here mutates execution state. The only reads
// that touch the engine's tables are SELECTs.

import type {
  Creator,
  Event,
  ExecutionInstance,
  InstanceState,
  Message,
  Prisma,
} from "@prisma/client";
import { prisma } from "../db/client.js";
import {
  WORKFLOW_STATE_ORDER,
  TERMINAL_STATES,
  WAITING_STATES,
  type WorkflowSummaryDTO,
  type WorkflowNodeSummaryDTO,
  type InstanceListDTO,
  type InstanceListItemDTO,
  type InstanceDetailDTO,
  type MessageDTO,
  type EventDTO,
  type AgentDecisionDTO,
  type TimelineDTO,
  type TimelineEntryDTO,
  type LogsDTO,
  type LogEntryDTO,
} from "./dto.js";

// An instance in a waiting state is "stuck" if its dueAt passed more than this
// long ago — the scheduler should have advanced it by now.
const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

const isTerminalState = (s: InstanceState): boolean => TERMINAL_STATES.includes(s);
const isWaitingState = (s: InstanceState): boolean => WAITING_STATES.includes(s);

function asRecord(json: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return null;
}

function payloadString(p: Record<string, unknown> | null, key: string): string | null {
  const v = p?.[key];
  return typeof v === "string" ? v : null;
}

// EASY-S2: mask the guard-leak band value in an event payload before it is served
// by the timeline. New rows are already masked at write time (executors use
// maskGuardHits), but PRE-FIX rows carry the raw value (e.g. "ceiling:500"), and
// this is the read-path backstop that redacts them too — so the internal band
// value never leaves the DB raw for anyone hitting the observability API. Returns
// a shallow copy; the stored row is unchanged (append-only audit log).
function maskPayloadLeaks(p: Record<string, unknown>): Record<string, unknown> {
  const leaks = p["leaks"];
  if (!Array.isArray(leaks)) return p;
  const masked = leaks.map((l) =>
    // Shape is "kind:value"; keep the kind, redact everything after the first ":".
    typeof l === "string" ? l.replace(/^([^:]*:).*/, "$1<redacted>") : l,
  );
  return { ...p, leaks: masked };
}

function payloadNumber(p: Record<string, unknown> | null, key: string): number | null {
  const v = p?.[key];
  return typeof v === "number" ? v : null;
}

function isStuck(inst: Pick<ExecutionInstance, "currentState" | "dueAt">, now: number): boolean {
  if (!isWaitingState(inst.currentState)) return false;
  if (!inst.dueAt) return false;
  return now - inst.dueAt.getTime() > STUCK_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// Workflow summary
// ---------------------------------------------------------------------------

/**
 * Per-state counts + derived metrics for the canvas.
 *
 * avgTimeInState is computed from the most recent STATE_TRANSITION event whose
 * `to` equals the instance's current state: now - thatEvent.occurredAt,
 * averaged across instances in the state. Instances with no such event (e.g.
 * still ENROLLED, never transitioned) fall back to now - enrolledAt.
 */
export async function getWorkflowSummary(): Promise<WorkflowSummaryDTO> {
  const now = Date.now();

  // Newest published version is the "active" workflow we visualize.
  const version = await prisma.workflowVersion.findFirst({
    orderBy: [{ version: "desc" }],
    include: { workflow: true },
  });

  const instances = await prisma.executionInstance.findMany({
    select: {
      id: true,
      currentState: true,
      dueAt: true,
      enrolledAt: true,
      updatedAt: true,
    },
  });

  // Most recent "entered this state" timestamp per instance, from transition
  // events. One query, grouped in memory.
  const transitionEvents = await prisma.event.findMany({
    where: { type: "STATE_TRANSITION" },
    select: { instanceId: true, payload: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });

  // instanceId -> { state -> latest occurredAt entering that state }
  const enteredAt = new Map<string, number>();
  for (const ev of transitionEvents) {
    const p = asRecord(ev.payload);
    const to = payloadString(p, "to");
    if (!to) continue;
    // Latest wins because events are ordered ascending.
    enteredAt.set(`${ev.instanceId}:${to}`, ev.occurredAt.getTime());
  }

  // Aggregate per-state.
  const acc = new Map<
    InstanceState,
    { count: number; active: number; waiting: number; stuck: number; durSum: number; durN: number }
  >();
  for (const state of WORKFLOW_STATE_ORDER) {
    acc.set(state, { count: 0, active: 0, waiting: 0, stuck: 0, durSum: 0, durN: 0 });
  }

  for (const inst of instances) {
    const bucket = acc.get(inst.currentState);
    if (!bucket) continue; // unknown state — defensive
    bucket.count += 1;
    if (!isTerminalState(inst.currentState)) bucket.active += 1;
    if (isWaitingState(inst.currentState)) bucket.waiting += 1;
    if (isStuck(inst, now)) bucket.stuck += 1;

    const entered =
      enteredAt.get(`${inst.id}:${inst.currentState}`) ?? inst.enrolledAt.getTime();
    bucket.durSum += now - entered;
    bucket.durN += 1;
  }

  const nodes: WorkflowNodeSummaryDTO[] = WORKFLOW_STATE_ORDER.map((state) => {
    const b = acc.get(state)!;
    return {
      state,
      count: b.count,
      terminal: isTerminalState(state),
      active: b.active,
      waiting: b.waiting,
      stuck: b.stuck,
      avgTimeInStateSeconds: b.durN > 0 ? Math.round(b.durSum / b.durN / 1000) : null,
    };
  });

  return {
    workflow: version
      ? {
          id: version.workflow.id,
          name: version.workflow.name,
          version: version.version,
          versionId: version.id,
        }
      : null,
    totalInstances: instances.length,
    nodes,
    generatedAt: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Instance list (filter / search / paginate)
// ---------------------------------------------------------------------------

export interface InstanceListParams {
  state?: InstanceState;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listInstances(params: InstanceListParams): Promise<InstanceListDTO> {
  const now = Date.now();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, Math.min(params.pageSize ?? 50, 200));

  const where: Prisma.ExecutionInstanceWhereInput = {};
  if (params.state) where.currentState = params.state;
  if (params.search && params.search.trim()) {
    const q = params.search.trim();
    where.creator = {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { handle: { contains: q, mode: "insensitive" } },
      ],
    };
  }

  const [total, rows] = await Promise.all([
    prisma.executionInstance.count({ where }),
    prisma.executionInstance.findMany({
      where,
      include: {
        creator: true,
        events: { orderBy: { occurredAt: "desc" }, take: 1 },
      },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const items: InstanceListItemDTO[] = rows.map((r) => {
    const lastEvent = r.events[0] ?? null;
    return {
      instanceId: r.id,
      creatorId: r.creatorId,
      creatorName: r.creator.name,
      creatorEmail: r.creator.email,
      creatorHandle: r.creator.handle,
      platform: r.creator.platform,
      state: r.currentState,
      currentNodeId: r.currentNodeId,
      negotiationRound: r.negotiationRound,
      followUpCount: r.followUpCount,
      dueAt: r.dueAt ? r.dueAt.toISOString() : null,
      enrolledAt: r.enrolledAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      waitingForSeconds: Math.round((now - r.updatedAt.getTime()) / 1000),
      stuck: isStuck(r, now),
      lastEventAt: lastEvent ? lastEvent.occurredAt.toISOString() : null,
      lastEventType: lastEvent ? lastEvent.type : null,
    };
  });

  return { items, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// Instance detail
// ---------------------------------------------------------------------------

function mapMessage(m: Message, round: number | null): MessageDTO {
  return {
    id: m.id,
    direction: m.direction,
    subject: m.subject,
    body: m.body,
    threadId: m.threadId,
    replyIntent: m.replyIntent,
    classifyConfidence: m.classifyConfidence,
    negotiationRound: round,
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    receivedAt: m.receivedAt ? m.receivedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

function mapEvent(e: Event): EventDTO {
  const payload = asRecord(e.payload);
  return {
    id: e.id,
    type: e.type,
    nodeId: e.nodeId,
    payload,
    occurredAt: e.occurredAt.toISOString(),
    source: payloadString(payload, "source"),
  };
}

/** Extract agent (AI) decisions from the event log for the inspector. */
function extractAgentDecisions(events: Event[]): AgentDecisionDTO[] {
  const out: AgentDecisionDTO[] = [];
  for (const e of events) {
    const p = asRecord(e.payload);
    if (e.type === "REPLY_CLASSIFIED" || e.type === "MANUAL_REVIEW_FLAGGED") {
      out.push({
        kind: "classification",
        occurredAt: e.occurredAt.toISOString(),
        decision: payloadString(p, "intent"),
        confidence: payloadNumber(p, "confidence"),
        round: null,
        reasoning: payloadString(p, "reason"),
        messageId: payloadString(p, "messageId"),
      });
    } else if (e.type === "NEGOTIATION_TURN") {
      out.push({
        kind: "negotiation",
        occurredAt: e.occurredAt.toISOString(),
        decision: payloadString(p, "outcome"),
        confidence: null,
        round: payloadNumber(p, "round"),
        reasoning: payloadString(p, "reason") ?? payloadString(p, "message"),
        messageId: null,
      });
    }
  }
  return out;
}

export async function getInstanceDetail(id: string): Promise<InstanceDetailDTO | null> {
  const inst = await prisma.executionInstance.findUnique({
    where: { id },
    include: {
      creator: true,
      workflowVersion: { include: { workflow: true } },
      messages: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { occurredAt: "asc" } },
    },
  });
  if (!inst) return null;

  // Attribute each outbound message to a negotiation round, when discoverable
  // from the surrounding NEGOTIATION_TURN events sharing the same body.
  const roundByBody = new Map<string, number>();
  for (const e of inst.events) {
    if (e.type === "NEGOTIATION_TURN") {
      const p = asRecord(e.payload);
      const msg = payloadString(p, "message");
      const round = payloadNumber(p, "round");
      if (msg && round !== null) roundByBody.set(msg, round);
    }
  }

  const lastTransition = [...inst.events]
    .reverse()
    .find((e) => e.type === "STATE_TRANSITION");
  const lastTransitionSource = payloadString(asRecord(lastTransition?.payload ?? null), "source");

  return {
    instance: {
      instanceId: inst.id,
      workflowVersionId: inst.workflowVersionId,
      workflowVersion: inst.workflowVersion?.version ?? null,
      workflowName: inst.workflowVersion?.workflow?.name ?? null,
      state: inst.currentState,
      currentNodeId: inst.currentNodeId,
      negotiationRound: inst.negotiationRound,
      followUpCount: inst.followUpCount,
      dueAt: inst.dueAt ? inst.dueAt.toISOString() : null,
      enrolledAt: inst.enrolledAt.toISOString(),
      completedAt: inst.completedAt ? inst.completedAt.toISOString() : null,
      createdAt: inst.createdAt.toISOString(),
      updatedAt: inst.updatedAt.toISOString(),
      lastTransitionSource,
    },
    creator: {
      id: inst.creator.id,
      name: inst.creator.name,
      email: inst.creator.email,
      handle: inst.creator.handle,
      niche: inst.creator.niche,
      platform: inst.creator.platform,
    },
    messages: inst.messages.map((m) => mapMessage(m, m.body ? roundByBody.get(m.body) ?? null : null)),
    events: inst.events.map(mapEvent),
    agentDecisions: extractAgentDecisions(inst.events),
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function summarizeEvent(e: Event): string {
  const p = asRecord(e.payload);
  switch (e.type) {
    case "STATE_TRANSITION":
      return `${payloadString(p, "from") ?? "?"} → ${payloadString(p, "to") ?? "?"}`;
    case "OUTREACH_DRAFTED":
      return "Outreach email drafted";
    case "NODE_ENTERED":
      return `Entered node ${e.nodeId ?? "?"}`;
    case "NODE_COMPLETED":
      return `Completed node ${e.nodeId ?? "?"}`;
    case "FOLLOW_UP_SCHEDULED":
      return "Follow-up scheduled";
    case "FOLLOW_UP_CANCELLED":
      return "Follow-up cancelled";
    case "FOLLOW_UP_DUE":
      return "Follow-up due";
    case "INBOUND_REPLY_RECEIVED":
      return `Inbound reply received${payloadString(p, "subject") ? `: ${payloadString(p, "subject")}` : ""}`;
    case "REPLY_CLASSIFIED": {
      const intent = payloadString(p, "intent");
      const conf = payloadNumber(p, "confidence");
      return `Reply classified as ${intent ?? "?"}${conf !== null ? ` (${conf.toFixed(2)})` : ""}`;
    }
    case "NEGOTIATION_TURN": {
      const outcome = payloadString(p, "outcome");
      const round = payloadNumber(p, "round");
      return `Negotiation ${outcome ?? "turn"}${round !== null ? ` (round ${round})` : ""}`;
    }
    case "MANUAL_REVIEW_FLAGGED":
      return "Flagged for manual review";
    default:
      return e.type;
  }
}

export async function getTimeline(id: string): Promise<TimelineDTO | null> {
  const inst = await prisma.executionInstance.findUnique({ where: { id }, select: { id: true } });
  if (!inst) return null;

  const events = await prisma.event.findMany({
    where: { instanceId: id },
    orderBy: { occurredAt: "asc" },
  });

  const entries: TimelineEntryDTO[] = events.map((e) => {
    const p = asRecord(e.payload);
    return {
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      nodeId: e.nodeId,
      source: payloadString(p, "source"),
      summary: summarizeEvent(e),
      fromState: e.type === "STATE_TRANSITION" ? payloadString(p, "from") : null,
      toState: e.type === "STATE_TRANSITION" ? payloadString(p, "to") : null,
      // EASY-S2: redact any raw guard-leak band value from a legacy payload before
      // serving it (new rows are already masked at write time).
      payload: p ? maskPayloadLeaks(p) : p,
    };
  });

  return { instanceId: id, entries };
}

// ---------------------------------------------------------------------------
// Logs / trace
// ---------------------------------------------------------------------------

/**
 * Reconstructs the transition trace for one instance from the STATE_TRANSITION
 * events, surfacing the persisted source / worker / queueJobId. This is the
 * end-to-end traceability surface (Part 10): for each hop, who triggered it.
 */
export async function getLogs(id: string): Promise<LogsDTO | null> {
  const inst = await prisma.executionInstance.findUnique({ where: { id }, select: { id: true } });
  if (!inst) return null;

  const events = await prisma.event.findMany({
    where: { instanceId: id, type: "STATE_TRANSITION" },
    orderBy: { occurredAt: "asc" },
  });

  const trace: LogEntryDTO[] = events.map((e) => {
    const p = asRecord(e.payload);
    return {
      occurredAt: e.occurredAt.toISOString(),
      fromState: payloadString(p, "from"),
      toState: payloadString(p, "to"),
      source: payloadString(p, "source"),
      worker: payloadString(p, "worker"),
      queueJobId: payloadString(p, "queueJobId"),
      nodeId: e.nodeId,
      eventType: e.type,
    };
  });

  return { instanceId: id, trace };
}
