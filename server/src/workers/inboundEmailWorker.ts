import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { QUEUE_INBOUND_EMAIL, enqueueNodeExecution } from "./queues.js";
import type { InboundEmailJobData } from "./jobs.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { findInstanceById, findMessageByExternalId, markMessageProcessed } from "../db/index.js";
import { isTerminal } from "../engine/stateMachine.js";
import type { ReplyIntent } from "@prisma/client";
import { acquireLock, releaseLock } from "../scheduler/lock.js";

// ---------------------------------------------------------------------------
// InboundEmail worker
// ---------------------------------------------------------------------------
// Processes an inbound email reply:
//   1. Idempotency — skip if the externalMessageId was already processed.
//   2. Lock — per-instance Redis lock (optimization; OCC is the guarantee).
//   3. injectReply — persists the INBOUND Message row + transitions to REPLY_RECEIVED.
//   4. stepInstance — runs executeReplyDetection, which calls the classification
//      provider (mock keyword-based or real LangGraph) and routes to
//      NEGOTIATING / REJECTED / OPTED_OUT / MANUAL_REVIEW.
//
// Phase 7: mockIntent (from harness / manual queue injections) still bypasses
// the classification provider so existing harnesses are unaffected. When
// mockIntent is absent (real Nylas webhook path), the agentProvider routes
// through the ClassificationProvider abstraction.

const VALID_INTENTS: ReplyIntent[] = ["POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT", "UNKNOWN"];

function resolveIntent(raw?: string): ReplyIntent | undefined {
  if (raw && (VALID_INTENTS as string[]).includes(raw)) {
    return raw as ReplyIntent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

async function handleInboundEmail(
  job: Job<InboundEmailJobData>,
): Promise<void> {
  const { instanceId, externalMessageId, threadId, subject, body, mockIntent, senderEmail } =
    job.data;

  // ── Idempotency check ───────────────────────────────────────────────────
  // CRITICAL-6 (b): skip ONLY when the reply was fully PROCESSED (processedAt
  // set), not merely persisted. The old check short-circuited on row existence,
  // so if a prior attempt persisted the Message row and then crashed before
  // advancing the instance (or hit a post-persist error), every retry no-op'd and
  // the reply was permanently stranded. A persisted-but-unprocessed row now falls
  // through to be re-processed (the persist step itself is idempotent on the
  // unique externalMessageId — see below).
  const existing = await findMessageByExternalId(externalMessageId);
  if (existing?.processedAt) {
    console.log(
      `[inbound-email] skip — message ${externalMessageId} already processed (job ${job.id})`,
    );
    return;
  }
  // NB: a persisted-but-unprocessed row (existing != null, processedAt == null)
  // falls through — the persist step below is idempotent on externalMessageId
  // (persistInboundMessageOnce), so re-processing after a crash never double-inserts.

  const instance = await findInstanceById(instanceId);
  if (!instance) {
    console.warn(`[inbound-email] instance not found: ${instanceId} (job ${job.id})`);
    return;
  }

  if (isTerminal(instance.currentState)) {
    console.log(
      `[inbound-email] skip — instance ${instanceId} already terminal (${instance.currentState}) (job ${job.id})`,
    );
    return;
  }

  // ── Acquire instance lock ────────────────────────────────────────────────
  // CRITICAL-6 (a): a busy lock must THROW, not return success. The old code
  // logged "skip" and returned — which COMPLETES the BullMQ job, so the inbound
  // reply was never persisted and never retried: silently and permanently lost.
  // Throwing lets BullMQ retry with backoff once the other worker releases the
  // lock. HARD-R2's fencing token means the retry can't collide with the holder.
  const lockToken = await acquireLock(instanceId);
  if (!lockToken) {
    throw new Error(
      `[inbound-email] lock busy for ${instanceId} (job ${job.id}) — throwing to force BullMQ retry (reply must not be dropped)`,
    );
  }

  // Phase 7: resolveIntent returns undefined when mockIntent is absent (real
  // webhook path). agentProvider with no replyIntent routes through the
  // ClassificationProvider (mock keyword-based or real LangGraph).
  const intent = resolveIntent(mockIntent);
  console.log(
    `[inbound-email] processing reply for ${instanceId} (state: ${instance.currentState}, classification: ${intent ?? "real"}) (job ${job.id})`,
  );

  const runtime = new WorkflowRuntime(
    emailProvider(),
    agentProvider(intent !== undefined ? { replyIntent: intent } : {}),
  );

  // CRITICAL-6: only mark the reply PROCESSED when a branch completes without an
  // unhandled throw. On success (or an OCC conflict, which means the reply is
  // being/was handled by the winning worker) we set `processed = true` and stamp
  // processedAt in the finally. If a branch throws unexpectedly, processed stays
  // false, processedAt is left NULL, and BullMQ retries re-process the persisted
  // row rather than the idempotency check skipping it (the old lost-reply bug).
  let processed = false;

  try {
    // ── Reward Setup reply branch ──────────────────────────────────────────
    // A reply that arrives while the instance is in REWARD_PENDING is the
    // creator confirming (or not) the finalized agreement — NOT a first reply
    // and NOT a negotiation turn. Route it to the Reward Setup reply handler,
    // which persists the message, classifies agreement, and advances to
    // REWARD_CONFIRMED (or keeps waiting). This bypasses injectReply's forced
    // REPLY_RECEIVED transition, which is invalid from REWARD_PENDING.
    if (instance.currentState === "REWARD_PENDING") {
      try {
        await runtime.handleRewardReply(instanceId, {
          subject,
          body,
          threadId,
          externalMessageId,
          worker: "inbound-email",
          queueJobId: job.id,
        });
      } catch (err) {
        if (err instanceof StaleInstanceError) {
          console.log(
            `[inbound-email] OCC conflict on handleRewardReply — ${err.message} (job ${job.id})`,
          );
          processed = true; // handled by the winning worker — don't retry-loop
          return;
        }
        throw err;
      }
      processed = true;

      // The agreement reply may have advanced the instance to REWARD_CONFIRMED.
      // That transition happens here (inbound worker), not via a node-execution
      // job, so the node-execution worker's auto-chain never sees it. Enqueue the
      // Payment Info step from here so a confirmed agreement flows straight into
      // the payout-form email (guarded for legacy graphs without a PAYMENT_INFO
      // node, which leave REWARD_CONFIRMED terminal).
      const afterReward = await findInstanceById(instanceId);
      if (
        afterReward?.currentState === "REWARD_CONFIRMED" &&
        (await runtime.paymentInfoApplies(instanceId))
      ) {
        await enqueueNodeExecution({
          instanceId,
          expectedState: "REWARD_CONFIRMED",
          triggerRef: `auto-payment-info-${instanceId}`,
        });
        console.log(
          `[inbound-email] auto-enqueued payment-info step for ${instanceId} (REWARD_CONFIRMED)`,
        );
      }
      return;
    }

    // ── Brand-decision reply branch ────────────────────────────────────────
    // A reply that arrives while the instance is AWAITING_BRAND_DECISION is the
    // BRAND answering a business escalation (approve / reject / counter / handoff)
    // — NOT the creator, and NOT a negotiation turn. Route it to the brand-
    // decision reply handler, which persists the message and steps the generic
    // brand-decision loop (parse pipeline → resolution map). This bypasses
    // injectReply's forced REPLY_RECEIVED transition, which is invalid here.
    if (instance.currentState === "AWAITING_BRAND_DECISION") {
      try {
        await runtime.handleBrandDecisionReply(instanceId, {
          subject,
          body,
          threadId,
          externalMessageId,
          // CRITICAL-1: the From: address is threaded to the brand-decision handler
          // so it can verify the reply came from the brand, not the creator.
          ...(senderEmail !== undefined ? { senderEmail } : {}),
          worker: "inbound-email",
          queueJobId: job.id,
        });
      } catch (err) {
        if (err instanceof StaleInstanceError) {
          console.log(
            `[inbound-email] OCC conflict on handleBrandDecisionReply — ${err.message} (job ${job.id})`,
          );
          processed = true; // handled by the winning worker — don't retry-loop
          return;
        }
        throw err;
      }
      processed = true;

      // The brand reply may have advanced the instance to a state that needs a
      // node-execution job to continue — this happens here (inbound worker), not
      // via a node-execution job, so the node-execution worker's auto-chain never
      // sees it. Enqueue the next step so the run resumes:
      //   ACCEPTED / REWARD_CONFIRMED / PAYMENT_RECEIVED → L4 config-fix wrote the
      //     brand name back and transitioned to the blocked node's run-from state;
      //     re-enqueue so the SAME node re-runs, now with a resolvable name.
      //   NEGOTIATING → forward-compat for a future final-offer resolution (no
      //     brand-decision outcome lands here in this pass).
      const afterBrand = await findInstanceById(instanceId);
      const resumeState = afterBrand?.currentState;
      const RESUME_STATES = ["NEGOTIATING", "ACCEPTED", "REWARD_CONFIRMED", "PAYMENT_RECEIVED"] as const;
      if (resumeState && (RESUME_STATES as readonly string[]).includes(resumeState)) {
        await enqueueNodeExecution({
          instanceId,
          expectedState: resumeState,
          triggerRef: `auto-resume-${instanceId}-brand-msg-${externalMessageId}`,
        });
        console.log(
          `[inbound-email] auto-enqueued resume step for ${instanceId} (brand decision → ${resumeState}, reply ${externalMessageId})`,
        );
      }
      return;
    }

    // ── Payment Info reply branch ──────────────────────────────────────────
    // A reply that arrives while the instance is in PAYMENT_PENDING is an email
    // sent while we're waiting on the creator's hosted payout FORM — usually a
    // question or a re-negotiation attempt, NOT the form. Route it to the payment
    // reply handler, which sends the "rate is fixed" auto-reply (redirecting to
    // the form) and keeps the instance in PAYMENT_PENDING. This bypasses
    // injectReply's forced REPLY_RECEIVED transition, which is invalid here.
    if (instance.currentState === "PAYMENT_PENDING") {
      try {
        await runtime.handlePaymentReply(instanceId, {
          subject,
          body,
          threadId,
          externalMessageId,
          worker: "inbound-email",
          queueJobId: job.id,
        });
      } catch (err) {
        if (err instanceof StaleInstanceError) {
          console.log(
            `[inbound-email] OCC conflict on handlePaymentReply — ${err.message} (job ${job.id})`,
          );
          processed = true; // handled by the winning worker — don't retry-loop
          return;
        }
        throw err;
      }
      processed = true;
      return;
    }

    try {
      await runtime.injectReply(instanceId, { subject, body, threadId, externalMessageId });
    } catch (err) {
      if (err instanceof StaleInstanceError) {
        console.log(`[inbound-email] OCC conflict on injectReply — ${err.message} (job ${job.id})`);
        processed = true; // handled by the winning worker — don't retry-loop
        return;
      }
      throw err;
    }

    // stepInstance runs executeReplyDetection → classifies → transitions.
    // Source is left to be inferred from the emitted event (REPLY_CLASSIFIED →
    // classification-agent) so the timeline attributes the decision to the
    // agent, not the worker; worker/job are still recorded for traceability.
    try {
      await runtime.stepInstance(instanceId, {
        worker: "inbound-email",
        queueJobId: job.id,
      });
    } catch (err) {
      if (err instanceof StaleInstanceError) {
        console.log(`[inbound-email] OCC conflict on stepInstance — ${err.message} (job ${job.id})`);
        processed = true; // handled by the winning worker — don't retry-loop
        return;
      }
      throw err;
    }
    processed = true;
  } finally {
    // CRITICAL-6: stamp processedAt only on a clean completion (or OCC conflict).
    // Released the lock first so the mark can't extend lock-hold time. If a branch
    // threw, `processed` is false and the reply stays re-processable on retry.
    await releaseLock(instanceId, lockToken);
    if (processed) {
      await markMessageProcessed(externalMessageId);
    }
  }

  const updated = await findInstanceById(instanceId);
  const newState = updated?.currentState ?? "unknown";
  console.log(
    `[inbound-email] done — ${instanceId}: REPLY_RECEIVED → ${newState} (job ${job.id})`,
  );

  // Reply detection classified the reply and landed on NEGOTIATING.
  // Enqueue a node-execution job to run the negotiation executor immediately
  // so the agent sends a response without waiting for a manual trigger.
  //
  // The triggerRef (→ BullMQ jobId) MUST be unique per reply, not per round.
  // A PRESENT_OFFER turn (answering a "what's the rate?" question) deliberately
  // does NOT increment negotiationRound, so two distinct replies can both occur
  // at the same round. Keying the job on the round alone would collide with the
  // earlier (completed) round-N job and BullMQ would silently drop the add —
  // stranding the instance at NEGOTIATING. Keying on the inbound message id (one
  // per reply) makes every reply enqueue its own negotiation step.
  if (newState === "NEGOTIATING") {
    await enqueueNodeExecution({
      instanceId,
      expectedState: "NEGOTIATING",
      triggerRef: `auto-negotiate-${instanceId}-msg-${externalMessageId}`,
    });
    console.log(
      `[inbound-email] auto-enqueued negotiation step for ${instanceId} (reply ${externalMessageId})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

const WORKER_CONCURRENCY = 5;

export function createInboundEmailWorker(): Worker<InboundEmailJobData> {
  const worker = new Worker<InboundEmailJobData>(
    QUEUE_INBOUND_EMAIL,
    handleInboundEmail,
    {
      connection: redisConnection(),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[inbound-email] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}/${job?.opts?.attempts ?? "?"}):`,
      err.message,
    );
  });

  worker.on("error", (err) => {
    console.error("[inbound-email] worker error:", err.message);
  });

  return worker;
}
