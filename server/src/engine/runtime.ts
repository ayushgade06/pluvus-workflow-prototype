import type { InstanceState, Prisma } from "@prisma/client";
import {
  findInstanceById,
  findCreatorById,
  findVersionById,
  updateInstanceState,
  appendEvent,
  createMessage,
} from "../db/index.js";
import { isTerminal, assertTransition } from "./stateMachine.js";
import type { IEmailProvider, IAgentProvider } from "./providers.js";
import type { ExecutionContext, NodeSnapshot } from "./types.js";
import {
  executeImportCreatorList,
  executeInitialOutreach,
  executeFollowUp,
  executeReplyDetection,
  executeNegotiation,
  executeEnd,
} from "./executors/index.js";

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

  async stepInstance(instanceId: string): Promise<ExecutionContext> {
    const ctx = await this.loadContext(instanceId);
    const { instance, node } = ctx;

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

    // Persist state change
    await updateInstanceState(instanceId, patch);

    const now = new Date();

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
        payload: { from: instance.currentState, to: result.nextState } as Prisma.InputJsonValue,
        occurredAt: now,
      });
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
    },
  ): Promise<void> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }

    const now = new Date();
    const externalMessageId = `mock-inbound-${instanceId}-${Date.now()}`;

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

    // Transition to REPLY_RECEIVED
    assertTransition(instance.currentState, "REPLY_RECEIVED");
    await updateInstanceState(instanceId, {
      currentState: "REPLY_RECEIVED",
      // Keep currentNodeId pointing to reply_detection node
      currentNodeId: "node_reply_detection",
    });

    // Write inbound reply event
    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId },
      occurredAt: now,
    });

    // Write state transition event
    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "STATE_TRANSITION",
      nodeId: instance.currentNodeId ?? null,
      payload: { from: instance.currentState, to: "REPLY_RECEIVED" },
      occurredAt: now,
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
