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
  executeRewardSetup,
  executeRewardReply,
  executePaymentInfo,
  executePaymentSubmission,
  executeEnd,
} from "./executors/index.js";
import { markPaymentReceived } from "../db/index.js";
import type { PayoutMethod } from "@prisma/client";

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

    // Reward Setup handoff: the negotiation ACCEPT clears currentNodeId (it sets
    // nextNodeId: null on the terminal-looking transition). When the instance is
    // in the Reward Setup lifecycle (ACCEPTED just succeeded, or REWARD_PENDING),
    // resolve to the REWARD_SETUP node so its executor runs rather than falling
    // back to the first node. This keeps the negotiation executor untouched.
    if (
      !node &&
      (instance.currentState === "ACCEPTED" || instance.currentState === "REWARD_PENDING")
    ) {
      node = nodeGraph.find((n) => n.type === "REWARD_SETUP");
    }

    // Payment Info handoff: mirrors the Reward Setup resolution above. In the
    // Payment Info lifecycle (REWARD_CONFIRMED just landed, or PAYMENT_PENDING)
    // the PAYMENT_INFO node is authoritative. REWARD_CONFIRMED can ONLY mean
    // "hand off to Payment Info" (the reward node never handles it), so resolve to
    // the PAYMENT_INFO node even when currentNodeId still points at the reward
    // node — not just when it failed to resolve. This keeps dispatch state-driven.
    if (
      instance.currentState === "REWARD_CONFIRMED" ||
      instance.currentState === "PAYMENT_PENDING"
    ) {
      const paymentNode = nodeGraph.find((n) => n.type === "PAYMENT_INFO");
      if (paymentNode && node?.type !== "PAYMENT_INFO") {
        node = paymentNode;
      }
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
  // handleRewardReply
  // -------------------------------------------------------------------------
  // An inbound reply arrived while the instance is in REWARD_PENDING (Reward
  // Setup waiting on the creator to confirm the agreement). This does NOT go
  // through the negotiation/first-reply classifier: it persists the inbound
  // message and steps the Reward Setup node, whose REWARD_PENDING dispatch runs
  // executeRewardReply (agreement → REWARD_CONFIRMED, else stay REWARD_PENDING).
  //
  // Kept separate from injectReply (which forces REPLY_RECEIVED, valid only from
  // the AWAITING_REPLY family) so the reward-confirmation reply stays inside the
  // Reward Setup node and the four locked nodes are untouched.

  async handleRewardReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    },
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "REWARD_PENDING") {
      throw new Error(
        `handleRewardReply expects REWARD_PENDING state, got ${instance.currentState}`,
      );
    }

    const now = new Date();
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Persist the inbound reply so executeRewardReply can read it (same contract
    // as injectReply → executeReplyDetection).
    await createMessage({
      instance: { connect: { id: instanceId } },
      direction: "INBOUND",
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      externalMessageId,
      receivedAt: now,
    });

    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId, rewardReply: true },
      occurredAt: now,
    });

    // Step the node — dispatch sees REWARD_PENDING and runs executeRewardReply,
    // reusing the standard OCC + event-writing path in stepInstance.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "inbound-email",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
    });
  }

  // -------------------------------------------------------------------------
  // handlePaymentSubmission
  // -------------------------------------------------------------------------
  // The creator submitted the hosted payout form while the instance is in
  // PAYMENT_PENDING. This persists the payout fields (markPaymentReceived) and
  // then steps the Payment Info node, whose PAYMENT_PENDING dispatch runs
  // executePaymentSubmission (→ PAYMENT_RECEIVED, exposing the output
  // connection). The engine then resumes into the next connected node — the node
  // is NOT executed by this handler.
  //
  // Kept separate from injectReply/handleRewardReply because a form submission is
  // not an inbound email: there is no Message row and the transition is driven by
  // stored payout data, not a classified reply.

  async handlePaymentSubmission(
    instanceId: string,
    submission: {
      method: PayoutMethod;
      accountIdentifier: string;
      country?: string | null;
      notes?: string | null;
    },
    opts: {
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    } = {},
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "PAYMENT_PENDING") {
      throw new Error(
        `handlePaymentSubmission expects PAYMENT_PENDING state, got ${instance.currentState}`,
      );
    }

    // Persist the payout fields BEFORE stepping, so executePaymentSubmission
    // reads a PAYMENT_RECEIVED row (same contract as inbound reply persistence).
    await markPaymentReceived(instanceId, {
      method: submission.method,
      accountIdentifier: submission.accountIdentifier,
      country: submission.country ?? null,
      notes: submission.notes ?? null,
    });

    // Step the node — dispatch sees PAYMENT_PENDING and runs
    // executePaymentSubmission, reusing the standard OCC + event-writing path.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "payment-form",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
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

      // Backward compatibility: a workflow published before Reward Setup has no
      // REWARD_SETUP node. For those, ACCEPTED is effectively terminal (there is
      // nowhere to advance to), so stop here rather than trying to step it.
      if (state === "ACCEPTED" && !hasRewardSetupNode(ctx.nodeGraph)) {
        return state;
      }

      // Backward compatibility: a workflow published before Payment Info has no
      // PAYMENT_INFO node. For those, REWARD_CONFIRMED is effectively terminal,
      // so stop here rather than trying to step it.
      if (state === "REWARD_CONFIRMED" && !hasPaymentInfoNode(ctx.nodeGraph)) {
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

      // Stop at REWARD_PENDING — Reward Setup waits for the creator's agreement
      // reply (delivered via handleRewardReply), same as AWAITING_REPLY.
      if (state === "REWARD_PENDING") {
        return state;
      }

      // Stop at PAYMENT_PENDING — Payment Info waits for the creator's payout
      // form submission (delivered via handlePaymentSubmission), same as above.
      if (state === "PAYMENT_PENDING") {
        return state;
      }

      ctx = await this.stepInstance(instanceId);
    }
  }

  // -------------------------------------------------------------------------
  // rewardSetupApplies — does this instance's workflow have a Reward Setup node?
  // -------------------------------------------------------------------------
  // Used by the node-execution worker to decide whether an ACCEPTED instance
  // should auto-chain into Reward Setup. Legacy workflows (no REWARD_SETUP node)
  // return false so ACCEPTED stays put — the pre-Reward-Setup terminal behavior.

  async rewardSetupApplies(instanceId: string): Promise<boolean> {
    const ctx = await this.loadContext(instanceId);
    return hasRewardSetupNode(ctx.nodeGraph);
  }

  // -------------------------------------------------------------------------
  // paymentInfoApplies — does this instance's workflow have a Payment Info node?
  // -------------------------------------------------------------------------
  // Used by the node-execution worker to decide whether a REWARD_CONFIRMED
  // instance should auto-chain into Payment Info. Legacy workflows (no
  // PAYMENT_INFO node) return false so REWARD_CONFIRMED stays terminal.

  async paymentInfoApplies(instanceId: string): Promise<boolean> {
    const ctx = await this.loadContext(instanceId);
    return hasPaymentInfoNode(ctx.nodeGraph);
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
      case "REWARD_SETUP":
        // The Reward Setup node has two phases keyed on state:
        //   ACCEPTED       → send the agreement-confirmation email, enter waiting
        //   REWARD_PENDING → an inbound reply arrived; decide confirm vs. keep waiting
        // The reply phase is normally driven via handleRewardReply (inbound
        // worker); dispatching on state keeps a direct stepInstance() correct too.
        if (ctx.instance.currentState === "REWARD_PENDING") {
          return executeRewardReply(ctx, this.email, this.agent);
        }
        return executeRewardSetup(ctx, this.email, this.agent);
      case "PAYMENT_INFO":
        // The Payment Info node has two phases keyed on state:
        //   REWARD_CONFIRMED → send the payout-form email, enter waiting
        //   PAYMENT_PENDING   → the creator submitted the form; finalize + advance
        // The submission phase is normally driven via handlePaymentSubmission (the
        // hosted payment route); dispatching on state keeps a direct
        // stepInstance() correct too.
        if (ctx.instance.currentState === "PAYMENT_PENDING") {
          return executePaymentSubmission(ctx, this.email, this.agent);
        }
        return executePaymentInfo(ctx, this.email, this.agent);
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

// True when the workflow graph contains a Reward Setup node. Legacy workflows
// (published before Reward Setup) have only an END node and return false.
function hasRewardSetupNode(nodeGraph: NodeSnapshot[]): boolean {
  return nodeGraph.some((n) => n.type === "REWARD_SETUP");
}

// True when the workflow graph contains a Payment Info node. Legacy workflows
// (published before Payment Info) lack it and return false, so REWARD_CONFIRMED
// stays terminal for them.
function hasPaymentInfoNode(nodeGraph: NodeSnapshot[]): boolean {
  return nodeGraph.some((n) => n.type === "PAYMENT_INFO");
}

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
