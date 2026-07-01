import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { QUEUE_NODE_EXECUTION, enqueueNodeExecution } from "./queues.js";
import type { NodeExecutionJobData } from "./jobs.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { findInstanceById } from "../db/index.js";
import { isTerminal } from "../engine/stateMachine.js";
import { acquireLock, releaseLock } from "../scheduler/lock.js";

// ---------------------------------------------------------------------------
// NodeExecution worker
// ---------------------------------------------------------------------------
// Advances one ExecutionInstance by one step through its current node.
//
// Idempotency guarantee:
//   The job carries `expectedState`. On entry the worker re-reads the live
//   instance state. If it no longer matches `expectedState`, the instance has
//   already been advanced (previous delivery or concurrent inbound-email job)
//   and the worker exits without touching state.
//
// Instance-level serialization:
//   A deterministic jobId (instanceId + expectedState + triggerRef) ensures at
//   most one job per logical trigger is ever in the queue. Combined with the
//   idempotency check above, two workers can never double-advance an instance.

// ---------------------------------------------------------------------------
// Runtime (shared across all jobs in this worker process)
// ---------------------------------------------------------------------------
// Email provider is chosen by EMAIL_PROVIDER (mock | nylas) via the factory
// (Phase 6). Agent provider stays mocked until Phase 7.

const runtime = new WorkflowRuntime(emailProvider(), agentProvider());

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

async function handleNodeExecution(
  job: Job<NodeExecutionJobData>,
): Promise<void> {
  const { instanceId, expectedState, triggerRef } = job.data;

  // ── Idempotency check ───────────────────────────────────────────────────
  const instance = await findInstanceById(instanceId);
  if (!instance) {
    console.warn(`[node-execution] instance not found: ${instanceId} (job ${job.id})`);
    return;
  }

  if (instance.currentState !== expectedState) {
    console.log(
      `[node-execution] skip — instance ${instanceId} is ${instance.currentState}, expected ${expectedState} (job ${job.id}, ref ${triggerRef})`,
    );
    return;
  }

  if (isTerminal(instance.currentState)) {
    console.log(
      `[node-execution] skip — instance ${instanceId} is terminal (${instance.currentState}) (job ${job.id})`,
    );
    return;
  }

  // ── Acquire instance lock ────────────────────────────────────────────────
  const locked = await acquireLock(instanceId);
  if (!locked) {
    console.log(`[node-execution] lock busy — skip ${instanceId} (job ${job.id})`);
    return;
  }

  // ── Execute ─────────────────────────────────────────────────────────────
  console.log(
    `[node-execution] advancing ${instanceId} from ${expectedState} (job ${job.id})`,
  );

  try {
    await runtime.stepInstance(instanceId, {
      source: "node-execution-worker",
      worker: "node-execution",
      queueJobId: job.id,
    });
  } catch (err) {
    if (err instanceof StaleInstanceError) {
      console.log(`[node-execution] OCC conflict — ${err.message} (job ${job.id})`);
      return; // another worker already advanced this instance — clean skip
    }
    throw err;
  } finally {
    await releaseLock(instanceId);
  }

  const updated = await findInstanceById(instanceId);
  const newState = updated?.currentState ?? "unknown";
  console.log(
    `[node-execution] done — ${instanceId}: ${expectedState} → ${newState} (job ${job.id})`,
  );

  // Auto-chain states that require an immediate next step without waiting for
  // an external trigger (scheduler tick or inbound webhook):
  //
  //   OUTREACH_SENT  — follow-up node must run to set dueAt → AWAITING_REPLY
  //   FOLLOWED_UP    — follow-up node reschedules → AWAITING_REPLY
  //   NEGOTIATING    — negotiation executor sends counter/accept immediately
  //   ACCEPTED       — negotiation succeeded; Reward Setup runs immediately to
  //                    send the agreement-confirmation email → REWARD_PENDING
  //   REWARD_CONFIRMED — agreement confirmed; Payment Info runs immediately to
  //                    send the payout-form email → PAYMENT_PENDING
  //   PAYMENT_RECEIVED — payout collected; Content Brief runs immediately to send
  //                    the campaign-brief email → CONTENT_BRIEF_SENT (terminal)
  //
  // AWAITING_REPLY, REWARD_PENDING and PAYMENT_PENDING are intentionally excluded:
  // they wait for a real reply / form submission (or a scheduled follow-up),
  // which arrive via their own queue paths.
  if (newState === "OUTREACH_SENT" || newState === "FOLLOWED_UP") {
    await enqueueNodeExecution({
      instanceId,
      expectedState: newState,
      triggerRef: `auto-followup-${instanceId}-${newState}`,
    });
    console.log(
      `[node-execution] auto-enqueued follow-up step for ${instanceId} (${newState})`,
    );
  } else if (newState === "ACCEPTED") {
    // Only auto-chain into Reward Setup when the workflow actually has a
    // REWARD_SETUP node. Legacy workflows (END-terminated) leave ACCEPTED as the
    // final state — the pre-Reward-Setup behavior.
    if (await runtime.rewardSetupApplies(instanceId)) {
      await enqueueNodeExecution({
        instanceId,
        expectedState: "ACCEPTED",
        triggerRef: `auto-reward-setup-${instanceId}`,
      });
      console.log(
        `[node-execution] auto-enqueued reward-setup step for ${instanceId} (ACCEPTED)`,
      );
    } else {
      console.log(
        `[node-execution] ${instanceId} ACCEPTED with no Reward Setup node — leaving as final state`,
      );
    }
  } else if (newState === "REWARD_CONFIRMED") {
    // Only auto-chain into Payment Info when the workflow actually has a
    // PAYMENT_INFO node. Legacy workflows (Reward-Setup-terminated) leave
    // REWARD_CONFIRMED as the final state — the pre-Payment-Info behavior.
    if (await runtime.paymentInfoApplies(instanceId)) {
      await enqueueNodeExecution({
        instanceId,
        expectedState: "REWARD_CONFIRMED",
        triggerRef: `auto-payment-info-${instanceId}`,
      });
      console.log(
        `[node-execution] auto-enqueued payment-info step for ${instanceId} (REWARD_CONFIRMED)`,
      );
    } else {
      console.log(
        `[node-execution] ${instanceId} REWARD_CONFIRMED with no Payment Info node — leaving as final state`,
      );
    }
  } else if (newState === "PAYMENT_RECEIVED") {
    // Only auto-chain into Content Brief when the workflow actually has a
    // CONTENT_BRIEF node. Legacy workflows (Payment-Info-terminated) leave
    // PAYMENT_RECEIVED as the final state — the pre-Content-Brief behavior. (The
    // real payout-form path enqueues this from the payment route; this branch
    // covers a PAYMENT_RECEIVED produced via a direct node-execution step.)
    if (await runtime.contentBriefApplies(instanceId)) {
      await enqueueNodeExecution({
        instanceId,
        expectedState: "PAYMENT_RECEIVED",
        triggerRef: `auto-content-brief-${instanceId}`,
      });
      console.log(
        `[node-execution] auto-enqueued content-brief step for ${instanceId} (PAYMENT_RECEIVED)`,
      );
    } else {
      console.log(
        `[node-execution] ${instanceId} PAYMENT_RECEIVED with no Content Brief node — leaving as final state`,
      );
    }
  } else if (newState === "NEGOTIATING") {
    const instance = await findInstanceById(instanceId);
    const round = instance?.negotiationRound ?? 0;
    await enqueueNodeExecution({
      instanceId,
      expectedState: "NEGOTIATING",
      triggerRef: `auto-negotiate-${instanceId}-r${round}`,
    });
    console.log(
      `[node-execution] auto-enqueued negotiation step for ${instanceId} (round ${round})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

const WORKER_CONCURRENCY = 5;

export function createNodeExecutionWorker(): Worker<NodeExecutionJobData> {
  const worker = new Worker<NodeExecutionJobData>(
    QUEUE_NODE_EXECUTION,
    handleNodeExecution,
    {
      connection: redisConnection(),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(
      `[node-execution] job ${job?.id ?? "?"} failed (attempt ${job?.attemptsMade ?? "?"}/${job?.opts?.attempts ?? "?"}):`,
      err.message,
    );
  });

  worker.on("error", (err) => {
    console.error("[node-execution] worker error:", err.message);
  });

  return worker;
}
