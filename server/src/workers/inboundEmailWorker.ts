import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { QUEUE_INBOUND_EMAIL } from "./queues.js";
import type { InboundEmailJobData } from "./jobs.js";
import { WorkflowRuntime, StaleInstanceError } from "../engine/runtime.js";
import { emailProvider, agentProvider } from "../engine/providerFactory.js";
import { findInstanceById, findMessageByExternalId } from "../db/index.js";
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
  const { instanceId, externalMessageId, threadId, subject, body, mockIntent } =
    job.data;

  // ── Idempotency check ───────────────────────────────────────────────────
  const existing = await findMessageByExternalId(externalMessageId);
  if (existing) {
    console.log(
      `[inbound-email] skip — message ${externalMessageId} already processed (job ${job.id})`,
    );
    return;
  }

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
  const locked = await acquireLock(instanceId);
  if (!locked) {
    console.log(`[inbound-email] lock busy — skip ${instanceId} (job ${job.id})`);
    return;
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

  try {
    try {
      await runtime.injectReply(instanceId, { subject, body, threadId, externalMessageId });
    } catch (err) {
      if (err instanceof StaleInstanceError) {
        console.log(`[inbound-email] OCC conflict on injectReply — ${err.message} (job ${job.id})`);
        return;
      }
      throw err;
    }

    // stepInstance runs executeReplyDetection → classifies → transitions.
    try {
      await runtime.stepInstance(instanceId);
    } catch (err) {
      if (err instanceof StaleInstanceError) {
        console.log(`[inbound-email] OCC conflict on stepInstance — ${err.message} (job ${job.id})`);
        return;
      }
      throw err;
    }
  } finally {
    await releaseLock(instanceId);
  }

  const updated = await findInstanceById(instanceId);
  console.log(
    `[inbound-email] done — ${instanceId}: REPLY_RECEIVED → ${updated?.currentState ?? "unknown"} (job ${job.id})`,
  );
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
