import type { InstanceState, Prisma, EventType } from "@prisma/client";
import {
  findInstanceById,
  findCreatorById,
  findVersionById,
  updateInstanceState,
  updateInstanceStateConditional,
  appendEvent,
  createMessage,
} from "../db/index.js";
import { isTerminal, assertTransition } from "./stateMachine.js";
import type { IEmailProvider, IAgentProvider } from "./providers.js";
import type { ExecutionContext, NodeSnapshot, NodeResult } from "./types.js";
import { logTransition, type TransitionSource } from "../observability/logger.js";
import { notifyBrandOfEscalation } from "../notifications/escalation.js";
import {
  executeImportCreatorList,
  executeInitialOutreach,
  executeFollowUp,
  executeReplyDetection,
  executeNegotiation,
  executeEnd,
} from "./executors/index.js";

// ---------------------------------------------------------------------------
// StaleInstanceError — thrown when OCC detects a concurrent state change
// ---------------------------------------------------------------------------

export class StaleInstanceError extends Error {
  constructor(instanceId: string, observedState: string) {
    super(`Stale instance: ${instanceId} state changed away from ${observedState}`);
    this.name = "StaleInstanceError";
  }
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  constructor(
    private readonly email: IEmailProvider,
    private readonly agent: IAgentProvider,
  ) {}

  // -------------------------------------------------------------------------
  // loadContext
  // -------------------------------------------------------------------------

  async loadContext(instanceId: string): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    const creator = await findCreatorById(instance.creatorId);
    if (!creator) {
      throw new Error(`Creator not found: ${instance.creatorId}`);
    }

    const version = await findVersionById(instance.workflowVersionId);
    if (!version) {
      throw new Error(`WorkflowVersion not found: ${instance.workflowVersionId}`);
    }

    const nodeGraph = version.nodeGraph as unknown as NodeSnapshot[];

    // Resolve current node: use currentNodeId if set, else default to first node
    const nodeId = instance.currentNodeId;
    let node: NodeSnapshot | undefined;

    if (nodeId) {
      node = nodeGraph.find((n) => n.id === nodeId);
    }

    if (!node) {
      // Default to the first node (lowest order)
      const sorted = [...nodeGraph].sort((a, b) => a.order - b.order);
      node = sorted[0];
    }

    if (!node) {
      throw new Error(`No nodes found in nodeGraph for version ${version.id}`);
    }

    return { instance, node, nodeGraph, creator };
  }

  // -------------------------------------------------------------------------
  // stepInstance
  // -------------------------------------------------------------------------

  async stepInstance(
    instanceId: string,
    opts?: {
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    },
  ): Promise<ExecutionContext> {
    const ctx = await this.loadContext(instanceId);
    const { instance, node, creator } = ctx;

    if (isTerminal(instance.currentState)) {
      throw new Error(
        `Instance ${instanceId} is in terminal state ${instance.currentState} — cannot step further`,
      );
    }

    // Dispatch to the correct executor
    const result = await this.dispatch(ctx);

    // Validate the proposed transition
    assertTransition(instance.currentState, result.nextState);

    // Build the update patch
    const patch: Parameters<typeof updateInstanceState>[1] = {
      currentState: result.nextState,
      currentNodeId: result.nextNodeId,
    };
    if (result.followUpCount !== undefined) {
      patch.followUpCount = result.followUpCount;
    }
    if (result.negotiationRound !== undefined) {
      patch.negotiationRound = result.negotiationRound;
    }
    if (Object.prototype.hasOwnProperty.call(result, "dueAt")) {
      patch.dueAt = result.dueAt ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(result, "completedAt")) {
      patch.completedAt = result.completedAt ?? null;
    }

    // Persist state change — OCC: only succeeds if currentState hasn't changed
    const updated = await updateInstanceStateConditional(
      instanceId,
      instance.currentState,
      patch,
    );
    if (!updated) {
      // Another worker already advanced this instance — treat as a no-op.
      throw new StaleInstanceError(instanceId, instance.currentState);
    }

    const now = new Date();

    // Attribute the transition. Explicit caller source wins; otherwise infer
    // the responsible agent from the domain event type so the timeline/logs can
    // answer "who triggered this" even when the worker doesn't pass a source.
    const source: TransitionSource =
      opts?.source ?? inferSourceFromEvent(result.eventType);

    // Write domain event (OUTREACH_DRAFTED, FOLLOW_UP_DUE, etc.)
    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: result.eventType,
      nodeId: node.id,
      payload: (result.eventPayload ?? {}) as Prisma.InputJsonValue,
      occurredAt: now,
    });

    // Write STATE_TRANSITION event (only if state actually changed)
    if (instance.currentState !== result.nextState) {
      await appendEvent({
        instance: { connect: { id: instanceId } },
        type: "STATE_TRANSITION",
        nodeId: node.id,
        // `source`, `worker`, `queueJobId` are persisted so end-to-end
        // traceability (Phase 9 Part 10) does not depend on stdout.
        payload: {
          from: instance.currentState,
          to: result.nextState,
          source,
          ...(opts?.worker ? { worker: opts.worker } : {}),
          ...(opts?.queueJobId ? { queueJobId: opts.queueJobId } : {}),
        } as Prisma.InputJsonValue,
        occurredAt: now,
      });

      logTransition({
        instanceId,
        creatorId: creator.id,
        fromState: instance.currentState,
        toState: result.nextState,
        source,
        worker: opts?.worker,
        queueJobId: opts?.queueJobId,
        nodeId: node.id,
      });
    }

    // ── Manual-queue escalation notification ─────────────────────────────────
    // A fresh transition INTO MANUAL_REVIEW means the creator just landed in the
    // manual queue. Email the brand so a human can take over. Best-effort: the
    // state is already persisted above, and notifyBrandOfEscalation never throws,
    // so a notification failure cannot roll back or block the workflow step.
    if (result.nextState === "MANUAL_REVIEW" && instance.currentState !== "MANUAL_REVIEW") {
      await notifyBrandOfEscalation(this.email, instanceId, escalationReason(result));
    }

    // Return updated context
    return this.loadContext(instanceId);
  }

  // -------------------------------------------------------------------------
  // injectReply
  // -------------------------------------------------------------------------

  async injectReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
    },
  ): Promise<void> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    const now = new Date();
    // Use caller-provided id when available so the inbound-email worker's
    // idempotency check (findMessageByExternalId) can find the row it created.
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Create inbound message record
    await createMessage({
      instance: { connect: { id: instanceId } },
      direction: "INBOUND",
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      externalMessageId,
      receivedAt: now,
    });

    // Resolve the REPLY_DETECTION node from the actual workflow version so
    // loadContext can dispatch correctly regardless of what the node is named.
    const version = await findVersionById(instance.workflowVersionId);
    const nodeGraph = (version?.nodeGraph ?? []) as unknown as NodeSnapshot[];
    const replyNode = nodeGraph.find((n) => n.type === "REPLY_DETECTION");

    // Transition to REPLY_RECEIVED — OCC: only succeeds if state hasn't changed
    assertTransition(instance.currentState, "REPLY_RECEIVED");
    const updatedForReply = await updateInstanceStateConditional(instanceId, instance.currentState, {
      currentState: "REPLY_RECEIVED",
      currentNodeId: replyNode?.id ?? "node-reply-detection",
    });
    if (!updatedForReply) {
      throw new StaleInstanceError(instanceId, instance.currentState);
    }

    // Write inbound reply event
    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId },
      occurredAt: now,
    });

    // Write state transition event — attributed to the inbound email itself.
    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "STATE_TRANSITION",
      nodeId: instance.currentNodeId ?? null,
      payload: { from: instance.currentState, to: "REPLY_RECEIVED", source: "inbound-email" },
      occurredAt: now,
    });

    logTransition({
      instanceId,
      creatorId: instance.creatorId,
      fromState: instance.currentState,
      toState: "REPLY_RECEIVED",
      source: "inbound-email",
      nodeId: instance.currentNodeId ?? null,
      meta: { externalMessageId },
    });
  }

  // -------------------------------------------------------------------------
  // runUntilWaiting
  // -------------------------------------------------------------------------

  async runUntilWaiting(instanceId: string): Promise<InstanceState> {
    let ctx = await this.loadContext(instanceId);

    while (true) {
      const state = ctx.instance.currentState;

      // Stop at terminal states
      if (isTerminal(state)) {
        return state;
      }

      // Stop at AWAITING_REPLY — harness injects a reply or triggers follow-ups manually
      if (state === "AWAITING_REPLY") {
        return state;
      }

      // Stop at NEGOTIATING — harness drives negotiation turns manually
      if (state === "NEGOTIATING") {
        return state;
      }

      ctx = await this.stepInstance(instanceId);
    }
  }

  // -------------------------------------------------------------------------
  // Private: dispatch to executor
  // -------------------------------------------------------------------------

  private async dispatch(ctx: ExecutionContext) {
    const { node } = ctx;

    switch (node.type) {
      case "IMPORT_CREATOR_LIST":
        return executeImportCreatorList(ctx, this.email, this.agent);
      case "INITIAL_OUTREACH":
        return executeInitialOutreach(ctx, this.email, this.agent);
      case "FOLLOW_UP":
        return executeFollowUp(ctx, this.email, this.agent);
      case "REPLY_DETECTION":
        return executeReplyDetection(ctx, this.email, this.agent);
      case "NEGOTIATION":
        return executeNegotiation(ctx, this.email, this.agent);
      case "END":
        return executeEnd(ctx, this.email, this.agent);
      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// inferSourceFromEvent — attribute a transition to the responsible agent based
// on the domain event the executor emitted. Used when the caller (worker)
// doesn't pass an explicit source. The node-execution worker passes its own
// source for plain advances; classification/negotiation transitions are
// attributed here because the agent — not the worker — owns the decision.
// ---------------------------------------------------------------------------

function inferSourceFromEvent(eventType: EventType): TransitionSource {
  switch (eventType) {
    case "REPLY_CLASSIFIED":
    case "MANUAL_REVIEW_FLAGGED":
      return "classification-agent";
    case "NEGOTIATION_TURN":
      return "negotiation-agent";
    default:
      return "node-execution-worker";
  }
}

// ---------------------------------------------------------------------------
// escalationReason — derive a stable reason code for a MANUAL_REVIEW transition
// from the executor's NodeResult, used in the brand notification + audit row.
//
//   reply detection (low confidence) → MANUAL_REVIEW_FLAGGED → "low_confidence_reply"
//   negotiation escalations          → NEGOTIATION_TURN with payload.reason
//                                       (max_rounds_reached, output_guard_blocked,
//                                        escalated, max_rounds_reached_on_counter)
// Falls back to "escalated" when no specific reason is present on the payload.
// ---------------------------------------------------------------------------

function escalationReason(result: NodeResult): string {
  if (result.eventType === "MANUAL_REVIEW_FLAGGED") {
    return "low_confidence_reply";
  }
  const payloadReason = result.eventPayload?.["reason"];
  if (typeof payloadReason === "string" && payloadReason) {
    return payloadReason;
  }
  return "escalated";
}
