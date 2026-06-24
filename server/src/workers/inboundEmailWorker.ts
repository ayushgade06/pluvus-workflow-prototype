import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { QUEUE_INBOUND_EMAIL } from "./queues.js";
import type { InboundEmailJobData } from "./jobs.js";
import { WorkflowRuntime } from "../engine/runtime.js";
import { MockEmailProvider, MockAgentProvider } from "../engine/providers.js";
import { findInstanceById, findMessageByExternalId } from "../db/index.js";
import { isTerminal } from "../engine/stateMachine.js";
import type { ReplyIntent } from "@prisma/client";

// ---------------------------------------------------------------------------
// InboundEmail worker
// ---------------------------------------------------------------------------
// Processes a mocked inbound email reply and advances the instance to
// REPLY_RECEIVED, then immediately steps through Reply Detection so the
// instance lands in NEGOTIATING / REJECTED / OPTED_OUT.
//
// Idempotency guarantee:
//   The job carries `externalMessageId`. Before creating a Message row the
//   worker checks whether one already exists with that id. If it does, the
//   job was already processed and exits early — no double transition.
//
// Instance-level serialization:
//   jobId = `inbound:<externalMessageId>` — BullMQ ensures only one job with
//   this id can be active or waiting at a time.

const VALID_INTENTS: ReplyIntent[] = ["POSITIVE", "NEGATIVE", "QUESTION", "OPT_OUT"];

function resolveIntent(raw?: string): ReplyIntent {
  if (raw && (VALID_INTENTS as string[]).includes(raw)) {
    return raw as ReplyIntent;
  }
  return "POSITIVE";
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

  // ── Transition to REPLY_RECEIVED ─────────────────────────────────────
  console.log(
    `[inbound-email] processing reply for ${instanceId} (state: ${instance.currentState}, intent: ${mockIntent ?? "POSITIVE"}) (job ${job.id})`,
  );

  const intent = resolveIntent(mockIntent);
  const runtime = new WorkflowRuntime(
    new MockEmailProvider(),
    new MockAgentProvider({ replyIntent: intent }),
  );

  // injectReply persists the Message row using the job's externalMessageId as
  // the anchor. The idempotency check above (findMessageByExternalId) can then
  // find this row on any retry, making the guard effective.
  await runtime.injectReply(instanceId, { subject, body, threadId, externalMessageId });

  // ── Step through Reply Detection ──────────────────────────────────────
  // One stepInstance() call runs executeReplyDetection, which classifies
  // the intent (via MockAgentProvider) and transitions to
  // NEGOTIATING / REJECTED / OPTED_OUT.
  await runtime.stepInstance(instanceId);

  const updated = await findInstanceById(instanceId);
  console.log(
    `[inbound-email] done — ${instanceId}: REPLY_RECEIVED → ${updated?.currentState ?? "unknown"} (job ${job.id})`,
  );
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

// Concurrency 1: inbound-email jobs mutate instance state. A single worker
// process at concurrency 1 provides safe serialization without a distributed
// lock in Phase 4. Phase 5+ can raise this with instance-level Redis locks.
const WORKER_CONCURRENCY = 1;

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
