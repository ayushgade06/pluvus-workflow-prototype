import type { InstanceState, Prisma, EventType } from "@prisma/client";
import {
  findInstanceById,
  findCreatorById,
  findVersionById,
  findWorkflowById,
  updateInstanceState,
  updateInstanceStateConditional,
  appendEvent,
  createMessage,
  findMessageByExternalId,
} from "../db/index.js";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { findCampaignById } from "../db/campaigns.js";
import { isTerminal, assertTransition } from "./stateMachine.js";
import { BRAND_DECISION_LINK_SENDER } from "./brandDecisionParse.js";
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
  executePaymentReply,
  executeContentBrief,
  executeContentBriefSubmission,
  executeBrandDecision,
  executeEnd,
} from "./executors/index.js";
import { markPaymentReceived, expirePendingBrandDecision } from "../db/index.js";
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

// Thrown when a brand-decision magic link is resolved but the instance is no
// longer AWAITING_BRAND_DECISION (already decided, or clicked/prefetched twice).
// The route renders this as an idempotent "already decided" page rather than an
// error — a repeated click is expected, not a failure.
export class WrongBrandDecisionStateError extends Error {
  constructor(
    readonly instanceId: string,
    readonly observedState: string,
  ) {
    super(
      `Brand decision for ${instanceId} is no longer open (state ${observedState})`,
    );
    this.name = "WrongBrandDecisionStateError";
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

    // Post-accept handoff: the negotiation ACCEPT clears currentNodeId (it sets
    // nextNodeId: null on the terminal-looking transition). When the instance is
    // ACCEPTED (or in the legacy REWARD_PENDING lifecycle), resolve to the node
    // that owns the post-acceptance email so its executor runs rather than falling
    // back to the first node. In the merged flow that is the CONTENT_BRIEF node;
    // legacy graphs still resolve to REWARD_SETUP. This keeps the negotiation
    // executor untouched.
    if (
      !node &&
      (instance.currentState === "ACCEPTED" || instance.currentState === "REWARD_PENDING")
    ) {
      node = nodeGraph.find((n) => n.type === "REWARD_SETUP");
      if (!node && instance.currentState === "ACCEPTED") {
        node = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
      }
    }

    // Payout-collection handoff: mirrors the resolution above. The PAYMENT_PENDING
    // waiting state is owned by whichever node collects payout — the CONTENT_BRIEF
    // node in the merged flow, or the legacy PAYMENT_INFO node. Resolve to
    // PAYMENT_INFO when that node exists (legacy graphs), otherwise to CONTENT_BRIEF
    // (merged graphs). REWARD_CONFIRMED is legacy-only and can ONLY mean "hand off
    // to Payment Info". Resolve even when currentNodeId still points at the prior
    // node — not just when it failed to resolve — so dispatch stays state-driven.
    if (
      instance.currentState === "REWARD_CONFIRMED" ||
      instance.currentState === "PAYMENT_PENDING"
    ) {
      const paymentNode = nodeGraph.find((n) => n.type === "PAYMENT_INFO");
      if (paymentNode) {
        if (node?.type !== "PAYMENT_INFO") node = paymentNode;
      } else if (instance.currentState === "PAYMENT_PENDING") {
        const contentBriefNode = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
        if (contentBriefNode && node?.type !== "CONTENT_BRIEF") node = contentBriefNode;
      }
    }

    // Content Brief handoff: mirrors the Payment Info resolution above. Once the
    // payout form is submitted the instance is PAYMENT_RECEIVED with its output
    // pointing at the Content Brief node; PAYMENT_RECEIVED can ONLY mean "hand off
    // to Content Brief" (the payment node never handles it), so resolve to the
    // CONTENT_BRIEF node even if currentNodeId still points at the payment node.
    if (instance.currentState === "PAYMENT_RECEIVED") {
      const contentBriefNode = nodeGraph.find((n) => n.type === "CONTENT_BRIEF");
      if (contentBriefNode && node?.type !== "CONTENT_BRIEF") {
        node = contentBriefNode;
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

    // H5: load the parent campaign (if any) so executors can fall back to its
    // brand context when a node's config wasn't stamped with it. version →
    // workflow → campaign. Best-effort: a missing/unlinked campaign is normal
    // (seeded/legacy workflows have campaignId=null) and must not break
    // execution, so any lookup failure degrades to "no campaign fallback".
    let campaign = null;
    try {
      const workflow = await findWorkflowById(version.workflowId);
      if (workflow?.campaignId) {
        campaign = await findCampaignById(workflow.campaignId);
      }
    } catch {
      campaign = null;
    }

    return { instance, node, nodeGraph, creator, campaign };
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
      // Disambiguates the Payment Info waiting phase: a hosted-form submission
      // (default) finalizes the payout and advances; an inbound email "reply"
      // triggers the "rate is fixed" auto-reply and stays in PAYMENT_PENDING.
      // Ignored by every other node type.
      phase?: "submission" | "reply";
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
    const result = await this.dispatch(ctx, opts?.phase);

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
  // persistInboundMessageOnce
  // -------------------------------------------------------------------------
  // CRITICAL-6: create the INBOUND Message row idempotently. If a prior attempt
  // already persisted this externalMessageId (then crashed before fully
  // processing), the retry must NOT hit the unique constraint — it skips the
  // insert and re-runs the rest of the handler. Returns the externalMessageId so
  // callers can mark it processed on success. A row with no externalMessageId
  // (mock-generated) is always fresh, so it is created unconditionally.

  private async persistInboundMessageOnce(
    instanceId: string,
    externalMessageId: string,
    data: Omit<PrismaTypes.MessageCreateInput, "instance" | "direction" | "externalMessageId">,
  ): Promise<void> {
    const existing = await findMessageByExternalId(externalMessageId);
    if (existing) return; // already persisted by a prior (crashed) attempt
    await createMessage({
      instance: { connect: { id: instanceId } },
      direction: "INBOUND",
      externalMessageId,
      ...data,
    });
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

    // CRITICAL-6 (b): assert the accepting transition BEFORE persisting the
    // Message row. The old order (persist → assertTransition) meant a reply
    // arriving in a state with no REPLY_RECEIVED edge left an orphan Message row
    // and then threw — and because the worker's idempotency check keys on the
    // persisted row, every retry no-op'd and the reply was lost forever. With the
    // accepting edges added in stateMachine (OUTREACH_SENT / NEGOTIATING) this is
    // now also defense-in-depth: an unexpected state fails fast with no orphan row
    // (so a retry, or a state-machine fix, can still process the reply).
    assertTransition(instance.currentState, "REPLY_RECEIVED");

    // Resolve the REPLY_DETECTION node from the actual workflow version so
    // loadContext can dispatch correctly regardless of what the node is named.
    const version = await findVersionById(instance.workflowVersionId);
    const nodeGraph = (version?.nodeGraph ?? []) as unknown as NodeSnapshot[];
    const replyNode = nodeGraph.find((n) => n.type === "REPLY_DETECTION");

    // Create inbound message record (after the transition is known to be legal),
    // idempotently so a retry after a mid-handler crash re-processes rather than
    // hitting the unique constraint (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      receivedAt: now,
    });

    // Transition to REPLY_RECEIVED — OCC: only succeeds if state hasn't changed
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
    // as injectReply → executeReplyDetection). Idempotent on externalMessageId so
    // a retry after a mid-handler crash re-processes rather than double-inserting
    // (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
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
  // handlePaymentReply
  // -------------------------------------------------------------------------
  // An inbound EMAIL reply arrived while the instance is in PAYMENT_PENDING
  // (Payment Info waiting on the creator's payout FORM submission). The expected
  // action here is the hosted form, not an email — so an email is usually a
  // question or a re-negotiation attempt. The deal is already closed at a fixed
  // fee, so this does NOT negotiate: it persists the inbound message and steps the
  // Payment Info node in the "reply" phase, which sends the "rate is fixed"
  // auto-reply (redirecting the creator to the payout form) and stays in
  // PAYMENT_PENDING.
  //
  // Kept separate from handlePaymentSubmission (a form submission, no Message row)
  // and from injectReply (which forces REPLY_RECEIVED, invalid from PAYMENT_PENDING).

  async handlePaymentReply(
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
    if (instance.currentState !== "PAYMENT_PENDING") {
      throw new Error(
        `handlePaymentReply expects PAYMENT_PENDING state, got ${instance.currentState}`,
      );
    }

    const now = new Date();
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Persist the inbound reply so executePaymentReply can read it (same contract
    // as handleRewardReply → executeRewardReply). Idempotent on externalMessageId
    // (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      receivedAt: now,
    });

    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId, paymentReply: true },
      occurredAt: now,
    });

    // Step the node in the "reply" phase — dispatch runs executePaymentReply
    // (sends the "rate is fixed" auto-reply, stays PAYMENT_PENDING), reusing the
    // standard OCC + event-writing path in stepInstance.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "inbound-email",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
      phase: "reply",
    });
  }

  // -------------------------------------------------------------------------
  // handleBrandDecisionReply
  // -------------------------------------------------------------------------
  // An inbound reply arrived while the instance is AWAITING_BRAND_DECISION (a
  // business escalation parked waiting on the brand). This does NOT go through
  // the negotiation/first-reply classifier: it persists the inbound message and
  // steps the instance, whose AWAITING_BRAND_DECISION dispatch runs
  // executeBrandDecision (parse pipeline → resolution map). Modeled on
  // handleRewardReply — kept separate from injectReply (which forces
  // REPLY_RECEIVED, invalid from AWAITING_BRAND_DECISION).
  //
  // The reply here is the BRAND's, not the creator's; both arrive on the same
  // inbound-email path and are disambiguated by the instance state.

  async handleBrandDecisionReply(
    instanceId: string,
    opts: {
      subject: string;
      body: string;
      threadId?: string;
      externalMessageId?: string;
      /** The From: address of the reply (CRITICAL-1). Persisted on the Message row
       *  so executeBrandDecision can verify the reply came from the brand. */
      senderEmail?: string;
      source?: TransitionSource;
      worker?: string | undefined;
      queueJobId?: string | undefined;
    },
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "AWAITING_BRAND_DECISION") {
      throw new Error(
        `handleBrandDecisionReply expects AWAITING_BRAND_DECISION state, got ${instance.currentState}`,
      );
    }

    const now = new Date();
    const externalMessageId =
      opts.externalMessageId ?? `mock-inbound-${instanceId}-${Date.now()}`;

    // Persist the inbound reply so executeBrandDecision can read it (same
    // contract as handleRewardReply → executeRewardReply). The sender address is
    // persisted for the identity check (CRITICAL-1). Idempotent on
    // externalMessageId (CRITICAL-6).
    await this.persistInboundMessageOnce(instanceId, externalMessageId, {
      subject: opts.subject,
      body: opts.body,
      threadId: opts.threadId ?? `mock-thread-${instance.creatorId}`,
      ...(opts.senderEmail !== undefined ? { senderEmail: opts.senderEmail } : {}),
      receivedAt: now,
    });

    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { subject: opts.subject, externalMessageId, brandDecisionReply: true },
      occurredAt: now,
    });

    // Step the instance — dispatch sees AWAITING_BRAND_DECISION and runs
    // executeBrandDecision, reusing the standard OCC + event-writing path.
    return this.stepInstance(instanceId, {
      source: opts.source ?? "inbound-email",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
    });
  }

  // -------------------------------------------------------------------------
  // resolveBrandDecisionLink
  // -------------------------------------------------------------------------
  // A brand clicked a one-click magic-link action (approve / reject / counter /
  // handoff) on the escalation email. Rather than duplicate the resolution map,
  // we synthesize a CANONICAL inbound reply whose body is the exact token the
  // deterministic scanner recognizes (APPROVE / REJECT / COUNTER <n> / HANDOFF)
  // and route it through the very same executeBrandDecision pipeline. A click
  // therefore resolves with ZERO parsing risk — the token scan matches
  // immediately, no AI hop — while sharing one code path with the email-reply
  // channel (§2.5).
  //
  // Idempotency: a link that is clicked twice (or prefetched by an email client)
  // finds the instance no longer AWAITING_BRAND_DECISION on the second hit and
  // throws WrongBrandDecisionStateError, which the route renders as an
  // "already decided" page. The OCC in stepInstance is the concurrency backstop.

  async resolveBrandDecisionLink(
    instanceId: string,
    action: "approve" | "reject" | "counter" | "handoff",
    amount: number | undefined,
    opts: {
      worker?: string | undefined;
      queueJobId?: string | undefined;
    } = {},
  ): Promise<ExecutionContext> {
    const instance = await findInstanceById(instanceId);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceId}`);
    }
    if (instance.currentState !== "AWAITING_BRAND_DECISION") {
      throw new WrongBrandDecisionStateError(instanceId, instance.currentState);
    }

    // Canonical, guaranteed-parseable body for the deterministic scanner.
    const canonical =
      action === "counter"
        ? `COUNTER ${amount ?? ""}`.trim()
        : action.toUpperCase();

    const now = new Date();
    const externalMessageId = `brand-link-${instanceId}-${action}-${Date.now()}`;

    await createMessage({
      instance: { connect: { id: instanceId } },
      direction: "INBOUND",
      subject: "Brand decision (one-click)",
      body: canonical,
      threadId: `mock-thread-${instance.creatorId}`,
      externalMessageId,
      // CRITICAL-1: tag the synthetic magic-link reply with the trusted sentinel.
      // The route already verified the unguessable token against the DB before
      // reaching here (findBrandDecisionByToken), so the token IS the capability —
      // executeBrandDecision's identity gate trusts this channel without a
      // From-address match.
      senderEmail: BRAND_DECISION_LINK_SENDER,
      receivedAt: now,
    });

    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "INBOUND_REPLY_RECEIVED",
      nodeId: instance.currentNodeId ?? null,
      payload: { externalMessageId, brandDecisionReply: true, viaMagicLink: true, action },
      occurredAt: now,
    });

    // Step the instance — dispatch runs executeBrandDecision on the synthetic
    // canonical reply, reusing the standard OCC + event-writing path.
    return this.stepInstance(instanceId, {
      source: "brand-decision-link",
      worker: opts.worker,
      queueJobId: opts.queueJobId,
    });
  }

  // -------------------------------------------------------------------------
  // expireBrandDecision
  // -------------------------------------------------------------------------
  // The 72h silence timeout fired: a BrandDecision is still PENDING past its
  // expiresAt (spec §2.6 / decision 3). Move the instance
  // AWAITING_BRAND_DECISION → MANUAL_REVIEW, mark the row EXPIRED, and ping the
  // operator so a silent brand never strands a creator forever.
  //
  // This is NOT a node execution — there's no decision to run — so it does its
  // own OCC transition + audit bookkeeping (mirroring stepInstance's MANUAL_REVIEW
  // path) rather than going through dispatch. Idempotent under concurrent sweeps:
  // the OCC update returns null if another sweep (or a late brand reply) already
  // moved the instance, in which case we no-op.
  //
  // Returns true when this call performed the expiry, false on a no-op (already
  // moved, or the row is no longer PENDING).

  async expireBrandDecision(
    instanceId: string,
    decisionId: string,
  ): Promise<boolean> {
    const instance = await findInstanceById(instanceId);
    if (!instance) return false;

    const now = new Date();

    // EASY-W2: if the run already left AWAITING_BRAND_DECISION (a late reply, a
    // prior sweep, or a PARTIAL failure where a previous expiry committed the
    // transition but never closed the row), the instance is done but the row may
    // still be PENDING — which the 72h sweep would re-select forever. Reconcile
    // the orphan row to EXPIRED (idempotent; a no-op if already resolved) so the
    // sweep converges, then no-op the transition (nothing left to move).
    if (instance.currentState !== "AWAITING_BRAND_DECISION") {
      await expirePendingBrandDecision(decisionId, now);
      return false;
    }

    // OCC transition AWAITING_BRAND_DECISION → MANUAL_REVIEW.
    assertTransition(instance.currentState, "MANUAL_REVIEW");
    const updated = await updateInstanceStateConditional(
      instanceId,
      "AWAITING_BRAND_DECISION",
      {
        currentState: "MANUAL_REVIEW",
        currentNodeId: instance.currentNodeId,
        completedAt: now,
      },
    );
    if (!updated) {
      // Another sweep or a late reply won the OCC race and advanced it. Still
      // reconcile the row so it doesn't linger PENDING for the next sweep.
      await expirePendingBrandDecision(decisionId, now);
      return false;
    }

    // Mark the decision row EXPIRED. Uses the status=PENDING-guarded update
    // (idempotent) so a retry/overlap can't clobber a row a concurrent resolution
    // just wrote. Best-effort — the transition already stands — but a failure here
    // is now SELF-HEALING: the row stays PENDING and the very next sweep hits the
    // orphan-reconcile branch above and closes it (rather than re-processing
    // forever, which was the EASY-W2 bug).
    try {
      await expirePendingBrandDecision(decisionId, now);
    } catch (err) {
      console.error(
        `[brand-decision] failed to mark decision ${decisionId} EXPIRED (transition already applied; next sweep will reconcile): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Audit: the domain event + the state transition, attributed to the scheduler.
    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "MANUAL_REVIEW_FLAGGED",
      nodeId: instance.currentNodeId ?? null,
      payload: { reason: "brand_decision_timeout", brandDecisionId: decisionId, expired: true },
      occurredAt: now,
    });
    await appendEvent({
      instance: { connect: { id: instanceId } },
      type: "STATE_TRANSITION",
      nodeId: instance.currentNodeId ?? null,
      payload: {
        from: "AWAITING_BRAND_DECISION",
        to: "MANUAL_REVIEW",
        source: "scheduler",
      },
      occurredAt: now,
    });
    logTransition({
      instanceId,
      creatorId: instance.creatorId,
      fromState: "AWAITING_BRAND_DECISION",
      toState: "MANUAL_REVIEW",
      source: "scheduler",
      nodeId: instance.currentNodeId ?? null,
      meta: { reason: "brand_decision_timeout", brandDecisionId: decisionId },
    });

    // Operator ping — reuses the idempotent brand/operator notifier (keyed on
    // instanceId + reason, so a re-sweep can't double-email). Best-effort: never
    // throws, so it can't undo the transition above.
    await notifyBrandOfEscalation(this.email, instanceId, "brand_decision_timeout");

    return true;
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
      /** Extra payout/fulfillment data preserved verbatim on PaymentInfo.extra
       *  (e.g. the shipping address when the campaign ships a physical product). */
      extra?: Prisma.InputJsonValue;
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
      ...(submission.extra !== undefined ? { extra: submission.extra } : {}),
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

      // Backward compatibility: a workflow published before both Reward Setup and
      // Content Brief has neither node. For those, ACCEPTED is effectively terminal
      // (there is nowhere to advance to), so stop here rather than trying to step
      // it. When a CONTENT_BRIEF node IS present (merged flow), ACCEPTED is NOT a
      // stop state — the loop steps into the merged email send, which lands on
      // PAYMENT_PENDING (a stop state below).
      if (
        state === "ACCEPTED" &&
        !hasRewardSetupNode(ctx.nodeGraph) &&
        !hasContentBriefNode(ctx.nodeGraph)
      ) {
        return state;
      }

      // Backward compatibility: a workflow published before Payment Info has no
      // PAYMENT_INFO node. For those, REWARD_CONFIRMED is effectively terminal,
      // so stop here rather than trying to step it.
      if (state === "REWARD_CONFIRMED" && !hasPaymentInfoNode(ctx.nodeGraph)) {
        return state;
      }

      // Backward compatibility: a workflow published before Content Brief has no
      // CONTENT_BRIEF node. For those, PAYMENT_RECEIVED is effectively terminal,
      // so stop here rather than trying to step it. When a CONTENT_BRIEF node IS
      // present, PAYMENT_RECEIVED is NOT a stop state — Content Brief has no
      // waiting phase, so the loop steps straight through to CONTENT_BRIEF_SENT.
      if (state === "PAYMENT_RECEIVED" && !hasContentBriefNode(ctx.nodeGraph)) {
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

      // Stop at PAYMENT_PENDING — the payout-collection node (Content Brief in the
      // merged flow, or legacy Payment Info) waits for the creator's payout form
      // submission (delivered via handlePaymentSubmission), same as above.
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
  // contentBriefApplies — does this instance's workflow have a Content Brief node?
  // -------------------------------------------------------------------------
  // Used by the node-execution worker to decide whether a PAYMENT_RECEIVED
  // instance should auto-chain into Content Brief. Legacy workflows (no
  // CONTENT_BRIEF node) return false so PAYMENT_RECEIVED stays terminal.

  async contentBriefApplies(instanceId: string): Promise<boolean> {
    const ctx = await this.loadContext(instanceId);
    return hasContentBriefNode(ctx.nodeGraph);
  }

  // -------------------------------------------------------------------------
  // Private: dispatch to executor
  // -------------------------------------------------------------------------

  private async dispatch(
    ctx: ExecutionContext,
    phase: "submission" | "reply" = "submission",
  ) {
    const { node } = ctx;

    // Brand-decision reply phase is dispatched on STATE, not node.type: a
    // business escalation parks the run in AWAITING_BRAND_DECISION from many
    // different nodes (reply detection, negotiation, …), so there is no single
    // BRAND_DECISION node to switch on. When a reply arrives while parked, run
    // the generic brand-decision reply handler regardless of which node the
    // instance last sat on. (The OUTBOUND side is not dispatched here — the
    // escalating executor calls openBrandDecision directly.)
    if (ctx.instance.currentState === "AWAITING_BRAND_DECISION") {
      return executeBrandDecision(ctx, this.email, this.agent);
    }

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
        // The Payment Info node has three phases:
        //   REWARD_CONFIRMED            → send the payout-form email, enter waiting
        //   PAYMENT_PENDING + submission → the creator submitted the form; finalize + advance
        //   PAYMENT_PENDING + reply      → an inbound EMAIL arrived (often a
        //                                  re-negotiation attempt); send the "rate
        //                                  is fixed" auto-reply and stay waiting.
        // The submission phase is driven via handlePaymentSubmission (the hosted
        // payment route); the reply phase via handlePaymentReply (inbound worker).
        // The phase defaults to "submission" so a direct stepInstance() is
        // unchanged from before.
        if (ctx.instance.currentState === "PAYMENT_PENDING") {
          return phase === "reply"
            ? executePaymentReply(ctx, this.email, this.agent)
            : executePaymentSubmission(ctx, this.email, this.agent);
        }
        return executePaymentInfo(ctx, this.email, this.agent);
      case "CONTENT_BRIEF":
        // Content Brief is the merged post-negotiation node. Phases keyed on state:
        //   ACCEPTED                     → send the merged email (finalized offer +
        //                                  payout link + brief PDF), enter waiting
        //   PAYMENT_PENDING + submission → the creator submitted the payout form;
        //                                  finalize to the CONTENT_BRIEF_SENT terminal
        //   PAYMENT_PENDING + reply      → an inbound EMAIL arrived (often a
        //                                  re-negotiation attempt); send the "rate
        //                                  is fixed" auto-reply and stay waiting
        //   PAYMENT_RECEIVED             → legacy path: Payment Info already
        //                                  collected payout; send the brief-only
        //                                  email and complete.
        // The submission phase is driven via handlePaymentSubmission (the hosted
        // payment route); the reply phase via handlePaymentReply (inbound worker).
        if (ctx.instance.currentState === "PAYMENT_PENDING") {
          return phase === "reply"
            ? executePaymentReply(ctx, this.email, this.agent)
            : executeContentBriefSubmission(ctx, this.email, this.agent);
        }
        return executeContentBrief(ctx, this.email, this.agent);
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

// True when the workflow graph contains a Content Brief node. Legacy workflows
// (published before Content Brief) lack it and return false, so PAYMENT_RECEIVED
// stays terminal for them.
function hasContentBriefNode(nodeGraph: NodeSnapshot[]): boolean {
  return nodeGraph.some((n) => n.type === "CONTENT_BRIEF");
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
//   reply detection (low confidence) → MANUAL_REVIEW_FLAGGED, no payload.reason → "low_confidence_reply"
//   negotiation escalations          → NEGOTIATION_TURN with payload.reason
//                                       (max_rounds_reached, output_guard_blocked,
//                                        escalated, max_rounds_reached_on_counter)
//   brand-decision handoff/re-ask    → MANUAL_REVIEW_FLAGGED WITH an explicit
//                                       payload.reason (brand_decision_*, handoff)
// An explicit payload.reason ALWAYS wins so a handoff/re-ask isn't mislabeled as
// low_confidence_reply. Only a MANUAL_REVIEW_FLAGGED with no reason (the original
// reply-detection case) keeps the low_confidence_reply default; otherwise fall
// back to "escalated".
// ---------------------------------------------------------------------------

function escalationReason(result: NodeResult): string {
  const payloadReason = result.eventPayload?.["reason"];
  if (typeof payloadReason === "string" && payloadReason) {
    return payloadReason;
  }
  if (result.eventType === "MANUAL_REVIEW_FLAGGED") {
    return "low_confidence_reply";
  }
  return "escalated";
}
