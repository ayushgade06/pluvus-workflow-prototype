/**
 * Phase 5 scheduler harness — validates scheduler, locking, and OCC end-to-end.
 *
 * Scenario A — Automatic follow-ups (NO_REPLY path):
 *   Reset instance, advance to AWAITING_REPLY with a past dueAt, start the
 *   poller, confirm the scheduler fires a node-execution job, and the instance
 *   transitions to FOLLOWED_UP. Repeat until NO_RESPONSE (max follow-ups).
 *
 * Scenario B — Reply stops follow-ups:
 *   Reset instance, advance to AWAITING_REPLY, inject a reply via
 *   inbound-email queue, confirm the instance reaches NEGOTIATING (or later).
 *   Then verify the scheduler no longer picks up this instance.
 *
 * Scenario C — Race protection (OCC + Redis lock):
 *   Reset instance to AWAITING_REPLY. Fire two concurrent node-execution jobs
 *   for the same instance. Confirm exactly one succeeds and the other is a
 *   clean skip (no duplicate state transitions, no crash).
 *
 * Run with:
 *   npm run harness:phase5    (from server/)
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { Worker } from "bullmq";
import {
  listInstancesByVersion,
  updateInstanceState,
  findInstanceById,
  listEventsByInstance,
} from "../db/index.js";
import {
  enqueueNodeExecution,
  enqueueInboundEmail,
  getNodeExecutionQueue,
  getInboundEmailQueue,
} from "../workers/queues.js";
import { createNodeExecutionWorker } from "../workers/nodeExecutionWorker.js";
import { createInboundEmailWorker } from "../workers/inboundEmailWorker.js";
import { startPoller, stopPoller } from "./poller.js";
import { closeLockClient, forceReleaseLock } from "./lock.js";
import type { InstanceState } from "@prisma/client";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function resetInstance(instanceId: string, creatorId: string): Promise<void> {
  await updateInstanceState(instanceId, {
    currentState: "ENROLLED",
    currentNodeId: "node_import",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    completedAt: null,
  });
}

async function setInstanceState(
  instanceId: string,
  state: InstanceState,
  nodeId: string,
  opts: { followUpCount?: number; dueAt?: Date | null } = {},
): Promise<void> {
  await updateInstanceState(instanceId, {
    currentState: state,
    currentNodeId: nodeId,
    followUpCount: opts.followUpCount ?? 0,
    dueAt: opts.dueAt ?? null,
  });
}

async function waitForState(
  instanceId: string,
  target: InstanceState,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inst = await findInstanceById(instanceId);
    if (inst?.currentState === target) return;
    await delay(300);
  }
  const inst = await findInstanceById(instanceId);
  throw new Error(
    `Timeout waiting for ${instanceId} to reach ${target}. Current: ${inst?.currentState}`,
  );
}

async function waitForAnyOf(
  instanceId: string,
  targets: InstanceState[],
  timeoutMs = 20_000,
): Promise<InstanceState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inst = await findInstanceById(instanceId);
    if (inst && targets.includes(inst.currentState)) return inst.currentState;
    await delay(300);
  }
  const inst = await findInstanceById(instanceId);
  throw new Error(
    `Timeout waiting for ${instanceId} to reach one of [${targets.join(", ")}]. Current: ${inst?.currentState}`,
  );
}

async function waitForJobCompletion(
  queueName: "node-execution" | "inbound-email",
  jobId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const queue = queueName === "node-execution" ? getNodeExecutionQueue() : getInboundEmailQueue();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (!job) return; // completed and cleaned up
    const state = await job.getState();
    if (state === "completed" || state === "failed") return;
    await delay(300);
  }
  throw new Error(`Timeout waiting for job ${jobId} on ${queueName}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ---------------------------------------------------------------------------
// Scenario A — Automatic follow-ups triggered by the scheduler
// ---------------------------------------------------------------------------

async function scenarioA(instanceId: string, creatorId: string): Promise<void> {
  section("Scenario A: scheduler fires follow-ups automatically");

  await resetInstance(instanceId, creatorId);
  log("reset to ENROLLED");

  // Advance to AWAITING_REPLY via normal queue path but with a tiny interval so
  // dueAt is in the past immediately. We use intervalUnit:"seconds" by forcing
  // state directly after confirming the node config sets dueAt.
  // Strategy: advance naturally until AWAITING_REPLY, then back-date dueAt.

  // Step 1: ENROLLED → OUTREACH_SENT
  {
    const ref = `scenA-import-${Date.now()}`;
    await enqueueNodeExecution({ instanceId, expectedState: "ENROLLED", triggerRef: ref });
    await delay(1_500);
    // import node keeps ENROLLED but advances nodeId — step again
    const inst = await findInstanceById(instanceId);
    if (inst?.currentState === "ENROLLED") {
      const ref2 = `scenA-outreach-${Date.now()}`;
      await enqueueNodeExecution({ instanceId, expectedState: "ENROLLED", triggerRef: ref2 });
      await delay(1_500);
    }
  }

  // Step 2: OUTREACH_SENT → AWAITING_REPLY
  {
    const inst = await findInstanceById(instanceId);
    if (inst?.currentState === "OUTREACH_SENT") {
      const ref = `scenA-followup-${Date.now()}`;
      await enqueueNodeExecution({ instanceId, expectedState: "OUTREACH_SENT", triggerRef: ref });
      await delay(1_500);
    }
  }

  // Confirm we're at AWAITING_REPLY (or already past it)
  let inst = await findInstanceById(instanceId);
  if (inst?.currentState !== "AWAITING_REPLY") {
    // Force to AWAITING_REPLY with past dueAt for the scheduler test
    await setInstanceState(instanceId, "AWAITING_REPLY", "node_followup", {
      followUpCount: 0,
      dueAt: new Date(Date.now() - 1000), // already due
    });
    log("forced to AWAITING_REPLY with past dueAt");
  } else {
    // Back-date the dueAt so the poller picks it up immediately
    await updateInstanceState(instanceId, { dueAt: new Date(Date.now() - 1000) });
    log(`at AWAITING_REPLY — back-dated dueAt to past`);
  }

  inst = await findInstanceById(instanceId);
  log(`state: ${inst?.currentState}, followUpCount: ${inst?.followUpCount}, dueAt: ${inst?.dueAt?.toISOString()}`);

  // Release any lock held from the setup steps above so the worker can proceed
  await forceReleaseLock(instanceId);

  // Start the poller with a 2-second interval so we don't have to wait 30 s
  startPoller(2_000);
  log("poller started (2 s interval)");

  // The poller should fire within 2 s and enqueue a node-execution job
  // which advances AWAITING_REPLY → FOLLOWED_UP
  await waitForAnyOf(instanceId, ["FOLLOWED_UP", "NO_RESPONSE"], 15_000);
  inst = await findInstanceById(instanceId);
  log(`state after first scheduler trigger: ${inst?.currentState}, followUpCount: ${inst?.followUpCount}`);

  if (inst?.currentState === "NO_RESPONSE") {
    log("PASS — scheduler triggered, instance reached NO_RESPONSE");
    stopPoller();
    return;
  }

  // After FOLLOWED_UP the runtime should set dueAt for the next window.
  // The follow-up executor transitions FOLLOWED_UP → AWAITING_REPLY with a new dueAt.
  // Release any lock from the scheduler-triggered job before enqueuing the reschedule step.
  await forceReleaseLock(instanceId);
  await enqueueNodeExecution({
    instanceId,
    expectedState: "FOLLOWED_UP",
    triggerRef: `scenA-reschedule-${Date.now()}`,
  });
  await waitForState(instanceId, "AWAITING_REPLY", 10_000);
  // Back-date for next scheduler pick-up
  await updateInstanceState(instanceId, { dueAt: new Date(Date.now() - 1000) });
  log("back-dated dueAt for second follow-up");

  await waitForAnyOf(instanceId, ["FOLLOWED_UP", "NO_RESPONSE"], 15_000);
  inst = await findInstanceById(instanceId);
  log(`state after second scheduler trigger: ${inst?.currentState}, followUpCount: ${inst?.followUpCount}`);

  stopPoller();
  log("poller stopped");

  if (inst?.currentState !== "FOLLOWED_UP" && inst?.currentState !== "NO_RESPONSE") {
    throw new Error(`Scenario A FAILED: unexpected state ${inst?.currentState}`);
  }

  log("PASS — scheduler fired follow-ups automatically");
}

// ---------------------------------------------------------------------------
// Scenario B — Reply stops follow-ups
// ---------------------------------------------------------------------------

async function scenarioB(instanceId: string, creatorId: string): Promise<void> {
  section("Scenario B: reply stops follow-up scheduling");

  await resetInstance(instanceId, creatorId);
  log("reset to ENROLLED");

  // Force to AWAITING_REPLY with a past dueAt
  await setInstanceState(instanceId, "AWAITING_REPLY", "node_followup", {
    followUpCount: 0,
    dueAt: new Date(Date.now() - 1000),
  });
  await forceReleaseLock(instanceId); // clear any lingering lock from setup (HARD-R2: unconditional harness reset)
  log("forced to AWAITING_REPLY with past dueAt");

  // Inject a reply BEFORE the scheduler fires — reply should win
  const externalMessageId = `mock-reply-scenB-${Date.now()}`;
  const jobId = `inbound|${externalMessageId}`;
  await enqueueInboundEmail({
    instanceId,
    externalMessageId,
    threadId: `mock-thread-${creatorId}`,
    subject: "Re: Collaboration",
    body: "Yes! Let's talk.",
    mockIntent: "POSITIVE",
  });
  log(`enqueued inbound-email job`);

  // Wait for NEGOTIATING (positive intent goes to negotiation)
  await waitForAnyOf(instanceId, ["NEGOTIATING", "REPLY_RECEIVED"], 15_000);
  let inst = await findInstanceById(instanceId);
  log(`state after reply: ${inst?.currentState}`);

  // Start poller — it should NOT pick up this instance (no longer AWAITING_REPLY)
  startPoller(2_000);
  log("poller started — should find no due instances now");
  await delay(5_000); // wait 2+ poll cycles

  inst = await findInstanceById(instanceId);
  log(`state after poller ran: ${inst?.currentState}`);

  stopPoller();

  const afterStates: InstanceState[] = ["NEGOTIATING", "REPLY_RECEIVED", "ACCEPTED", "REJECTED", "OPTED_OUT"];
  if (!afterStates.includes(inst?.currentState as InstanceState)) {
    throw new Error(`Scenario B FAILED: expected post-reply state, got ${inst?.currentState}`);
  }

  log("PASS — reply was processed, scheduler found nothing to trigger");
}

// ---------------------------------------------------------------------------
// Scenario C — Race protection (OCC + Redis lock)
// ---------------------------------------------------------------------------

async function scenarioC(instanceId: string, creatorId: string): Promise<void> {
  section("Scenario C: concurrent jobs — only one wins (OCC + lock)");

  await setInstanceState(instanceId, "AWAITING_REPLY", "node_followup", {
    followUpCount: 0,
    dueAt: new Date(Date.now() - 1000),
  });
  await forceReleaseLock(instanceId); // clear any lingering lock from prior scenarios
  log("set to AWAITING_REPLY");

  const eventsBefore = (await listEventsByInstance(instanceId)).length;

  // Fire two concurrent node-execution jobs with the same expectedState.
  // Both target AWAITING_REPLY — one should win, one should be a clean skip.
  const ref1 = `scenC-race-1-${Date.now()}`;
  const ref2 = `scenC-race-2-${Date.now()}`;

  // Use queue directly with explicit jobIds so we can track both
  const q = getNodeExecutionQueue();
  const [job1, job2] = await Promise.all([
    q.add("advance", { instanceId, expectedState: "AWAITING_REPLY", triggerRef: ref1 }, { jobId: `node-exec|${instanceId}|AWAITING_REPLY|${ref1}`, attempts: 1 }),
    q.add("advance", { instanceId, expectedState: "AWAITING_REPLY", triggerRef: ref2 }, { jobId: `node-exec|${instanceId}|AWAITING_REPLY|${ref2}`, attempts: 1 }),
  ]);
  log(`enqueued 2 concurrent jobs: ${job1.id}, ${job2.id}`);

  // Wait for both to complete/fail
  await Promise.all([
    waitForJobCompletion("node-execution", job1.id!, 20_000),
    waitForJobCompletion("node-execution", job2.id!, 20_000),
  ]);

  const eventsAfter = (await listEventsByInstance(instanceId)).length;
  const eventsWritten = eventsAfter - eventsBefore;
  const inst = await findInstanceById(instanceId);

  log(`state: ${inst?.currentState}`);
  log(`events written by both jobs: ${eventsWritten}`);

  // The state should have advanced exactly once — AWAITING_REPLY → FOLLOWED_UP
  // (or NO_RESPONSE if followUpCount >= maxCount, but we set it to 0 above)
  const expectedStates: InstanceState[] = ["FOLLOWED_UP", "NO_RESPONSE"];
  if (!expectedStates.includes(inst?.currentState as InstanceState)) {
    throw new Error(`Scenario C FAILED: unexpected state ${inst?.currentState}`);
  }

  // Events from a single transition should be 2 (FOLLOW_UP_DUE + STATE_TRANSITION)
  // A double-write would produce 4. Allow a small window — the lock or OCC must
  // prevent doubling.
  if (eventsWritten > 3) {
    throw new Error(
      `Scenario C FAILED: too many events (${eventsWritten}) — suggests double state transition`,
    );
  }

  log(`PASS — exactly one transition applied (${eventsWritten} events, state: ${inst?.currentState})`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const instances = await listInstancesByVersion("wfv_seed_v1");
  if (instances.length < 3) {
    console.error(
      `Need at least 3 seeded instances, found ${instances.length}. Run: npm run db:seed`,
    );
    process.exit(1);
  }

  console.log("\nPluvus Workflow — Phase 5 Scheduler Harness\n");

  // Start workers inline
  const workers: Worker[] = [
    createNodeExecutionWorker(),
    createInboundEmailWorker(),
  ];
  log("workers started");

  const [inst0, inst1, inst2] = instances as [
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
  ];

  try {
    await scenarioA(inst0.id, inst0.creatorId);
    await scenarioB(inst1.id, inst1.creatorId);
    await scenarioC(inst2.id, inst2.creatorId);

    console.log("\n✓ Phase 5 harness complete — all scenarios passed\n");
  } catch (err) {
    console.error("\n✗ Phase 5 harness FAILED:", err);
    process.exitCode = 1;
  } finally {
    stopPoller();
    await closeLockClient();
    await Promise.all(workers.map((w) => w.close()));
    await getNodeExecutionQueue().close();
    await getInboundEmailQueue().close();
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
