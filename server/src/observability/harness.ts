/**
 * Phase 9 observability harness — validates that the observability API
 * faithfully reflects live engine state, and that transitions are traceable
 * end-to-end.
 *
 * This harness drives REAL transitions through the BullMQ queue (workers run
 * inline, same as the Phase-4 harness) and after each hop asserts the
 * observability repository — the exact code the HTTP routes call — reports the
 * change. It therefore validates the runtime AND the read model together.
 *
 * Scenarios (mirrors the Phase 9 validation matrix):
 *   A. AWAITING_REPLY → NEGOTIATING reflected in workflow counts
 *   B. NEGOTIATING → ACCEPTED reflected in workflow counts
 *   C. Instance inspector shows messages, events, current state
 *   D. Timeline reconstructs full creator history (chronological)
 *   E. Logs trace Queue Job → Worker → Transition → Event for one creator
 *   F. Live polling reflects changes (snapshot-before vs snapshot-after)
 *
 * Run with:
 *   npm run harness:phase9     (from server/)
 *
 * Requires Redis (BullMQ) + the Neon DB. If Redis is unavailable the harness
 * fails fast with a clear message.
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { Worker } from "bullmq";
import type { InstanceState } from "../db/schema.js";
import {
  listInstancesByVersion,
  updateInstanceState,
  findInstanceById,
} from "../db/index.js";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/drizzle.js";
import { events, messages } from "../db/schema.js";
import {
  enqueueNodeExecution,
  enqueueInboundEmail,
  getNodeExecutionQueue,
  getInboundEmailQueue,
} from "../workers/queues.js";
import { createNodeExecutionWorker } from "../workers/nodeExecutionWorker.js";
import { createInboundEmailWorker } from "../workers/inboundEmailWorker.js";
import { createDelayedSendWorker } from "../workers/delayedSendWorker.js";
import { closeLockClient } from "../scheduler/lock.js";
import {
  getWorkflowSummary,
  getInstanceDetail,
  getTimeline,
  getLogs,
} from "./repository.js";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

let passCount = 0;
function log(msg: string): void {
  console.log(`  ${msg}`);
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
}
function pass(msg: string): void {
  passCount++;
  console.log(`  ✓ ${msg}`);
}
function fail(msg: string): never {
  throw new Error(`FAIL: ${msg}`);
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Engine helpers (drive transitions through the queue)
// ---------------------------------------------------------------------------

async function resetInstance(instanceId: string): Promise<void> {
  // Clear prior history so this run's timeline/logs are clean and assertions
  // are deterministic.
  await db.delete(events).where(eq(events.instanceId, instanceId));
  await db.delete(messages).where(eq(messages.instanceId, instanceId));
  await updateInstanceState(instanceId, {
    currentState: "ENROLLED",
    currentNodeId: "node_import",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    completedAt: null,
  });
}

async function waitForState(
  instanceId: string,
  target: InstanceState,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inst = await findInstanceById(instanceId);
    if (inst?.currentState === target) return;
    await delay(150);
  }
  const inst = await findInstanceById(instanceId);
  fail(`timeout waiting for ${instanceId} → ${target} (current ${inst?.currentState})`);
}

/** Wait for one specific node-execution job to leave the queue (done/failed). */
async function waitForNodeJob(jobId: string, timeoutMs = 12_000): Promise<void> {
  const q = getNodeExecutionQueue();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await q.getJob(jobId);
    if (!job) return; // completed + removed
    const st = await job.getState();
    if (st === "completed" || st === "failed") return;
    await delay(150);
  }
}

/**
 * Advance from ENROLLED up to AWAITING_REPLY by pumping node-execution jobs.
 * Each iteration re-reads live state, enqueues exactly one job for it, and
 * blocks on that job's completion before the next — avoiding lock contention
 * and stale-expectedState skips.
 */
async function advanceToAwaitingReply(instanceId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const inst = await findInstanceById(instanceId);
    if (!inst) fail(`instance vanished: ${instanceId}`);
    if (inst.currentState === "AWAITING_REPLY") return;
    if (inst.currentState !== "ENROLLED" && inst.currentState !== "OUTREACH_SENT") {
      return; // unexpected state — let the caller assert
    }
    const ref = `p9-adv-${i}-${instanceId}`;
    const jobId = `node-exec|${instanceId}|${inst.currentState}|${ref}`;
    await enqueueNodeExecution({ instanceId, expectedState: inst.currentState, triggerRef: ref });
    await waitForNodeJob(jobId);
    await delay(250); // settle after lock release
  }
}

async function injectReply(
  instanceId: string,
  mockIntent: string,
  body: string,
): Promise<void> {
  const inst = await findInstanceById(instanceId);
  if (!inst) fail(`instance not found: ${instanceId}`);
  const externalMessageId = `p9-inbound-${instanceId}-${Date.now()}`;
  await enqueueInboundEmail({
    instanceId,
    externalMessageId,
    threadId: `p9-thread-${inst.creatorId}`,
    subject: "Re: Collaboration opportunity",
    body,
    mockIntent,
  });
}

// Count instances in a state via the SAME repository the HTTP route uses.
async function summaryCount(state: InstanceState): Promise<number> {
  const sum = await getWorkflowSummary();
  return sum.nodes.find((n) => n.state === state)?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

async function run(instanceId: string): Promise<void> {
  // -------------------------------------------------------------------------
  section("Setup — reset instance and drive to AWAITING_REPLY");
  await resetInstance(instanceId);
  log("reset to ENROLLED (history cleared)");
  await advanceToAwaitingReply(instanceId);
  await waitForState(instanceId, "AWAITING_REPLY");
  pass("instance reached AWAITING_REPLY via the queue");

  // -------------------------------------------------------------------------
  section("Scenario A — AWAITING_REPLY → NEGOTIATING reflected in counts");
  const negBefore = await summaryCount("NEGOTIATING");
  const awaitBefore = await summaryCount("AWAITING_REPLY");
  log(`counts before: AWAITING_REPLY=${awaitBefore}, NEGOTIATING=${negBefore}`);

  await injectReply(instanceId, "POSITIVE", "Yes! I'd love to collaborate. What are the terms?");
  await waitForState(instanceId, "NEGOTIATING");

  const negAfter = await summaryCount("NEGOTIATING");
  const awaitAfter = await summaryCount("AWAITING_REPLY");
  log(`counts after:  AWAITING_REPLY=${awaitAfter}, NEGOTIATING=${negAfter}`);
  if (negAfter !== negBefore + 1) fail(`NEGOTIATING count did not increase (${negBefore} → ${negAfter})`);
  if (awaitAfter !== awaitBefore - 1) fail(`AWAITING_REPLY count did not decrease (${awaitBefore} → ${awaitAfter})`);
  pass("workflow counts updated automatically: AWAITING_REPLY −1, NEGOTIATING +1");

  // -------------------------------------------------------------------------
  section("Scenario C — instance inspector shows messages, events, state");
  const detail = await getInstanceDetail(instanceId);
  if (!detail) fail("getInstanceDetail returned null");
  if (detail.instance.state !== "NEGOTIATING") fail(`detail state wrong: ${detail.instance.state}`);
  if (detail.messages.length === 0) fail("detail has no messages");
  if (detail.events.length === 0) fail("detail has no events");
  if (detail.agentDecisions.length === 0) fail("detail has no agent decisions");
  const inbound = detail.messages.find((m) => m.direction === "INBOUND");
  if (!inbound) fail("no inbound message in detail");
  if (inbound.replyIntent !== "POSITIVE") fail(`inbound intent wrong: ${inbound.replyIntent}`);
  log(`detail: state=${detail.instance.state}, msgs=${detail.messages.length}, events=${detail.events.length}, decisions=${detail.agentDecisions.length}`);
  log(`classification decision: ${detail.agentDecisions[0]?.decision} @ ${detail.agentDecisions[0]?.confidence}`);
  pass("instance detail exposes state, messages, events, and AI decisions");

  // -------------------------------------------------------------------------
  section("Scenario D — timeline reconstructs full history (chronological)");
  const timeline = await getTimeline(instanceId);
  if (!timeline) fail("getTimeline returned null");
  if (timeline.entries.length < 4) fail(`timeline too short: ${timeline.entries.length}`);
  // Assert chronological ordering.
  for (let i = 1; i < timeline.entries.length; i++) {
    const prev = Date.parse(timeline.entries[i - 1]!.occurredAt);
    const cur = Date.parse(timeline.entries[i]!.occurredAt);
    if (cur < prev) fail(`timeline out of order at index ${i}`);
  }
  // Assert it contains the key lifecycle beats.
  const summaries = timeline.entries.map((e) => e.summary);
  const hasReply = timeline.entries.some((e) => e.type === "INBOUND_REPLY_RECEIVED");
  const hasClassify = timeline.entries.some((e) => e.type === "REPLY_CLASSIFIED");
  const hasNegToTransition = timeline.entries.some(
    (e) => e.type === "STATE_TRANSITION" && e.toState === "NEGOTIATING",
  );
  if (!hasReply) fail("timeline missing INBOUND_REPLY_RECEIVED");
  if (!hasClassify) fail("timeline missing REPLY_CLASSIFIED");
  if (!hasNegToTransition) fail("timeline missing transition into NEGOTIATING");
  log(`timeline (${timeline.entries.length} entries): ${summaries.slice(0, 6).join(" → ")} …`);
  pass("timeline is chronological and reconstructs the full lifecycle");

  // -------------------------------------------------------------------------
  section("Scenario E — logs trace Queue Job → Worker → Transition → Event");
  const logs = await getLogs(instanceId);
  if (!logs) fail("getLogs returned null");
  if (logs.trace.length === 0) fail("logs trace empty");
  // Find the classification-driven transition into NEGOTIATING and assert it
  // carries source + worker + queueJobId (full attribution).
  const negHop = logs.trace.find((t) => t.toState === "NEGOTIATING");
  if (!negHop) fail("no transition into NEGOTIATING in trace");
  log(`NEGOTIATING hop: source=${negHop.source}, worker=${negHop.worker}, job=${negHop.queueJobId}`);
  if (negHop.source !== "classification-agent")
    fail(`expected source classification-agent, got ${negHop.source}`);
  if (!negHop.worker) fail("NEGOTIATING hop has no worker attribution");
  if (!negHop.queueJobId) fail("NEGOTIATING hop has no queueJobId attribution");
  // The inbound transition should be attributed to the inbound email.
  const replyHop = logs.trace.find((t) => t.toState === "REPLY_RECEIVED");
  if (!replyHop || replyHop.source !== "inbound-email")
    fail(`REPLY_RECEIVED hop not attributed to inbound-email (got ${replyHop?.source})`);
  pass("every transition carries source attribution; AI hop has worker + queue job id");

  // -------------------------------------------------------------------------
  section("Scenario F — live polling reflects changes without a refresh");
  // Two successive reads of the read model with a transition in between must
  // differ — this is exactly what the frontend's polling observes.
  const snap1 = await getInstanceDetail(instanceId);
  const updatedAt1 = snap1!.instance.updatedAt;
  const events1 = snap1!.events.length;

  // Drive NEGOTIATING → ACCEPTED for Scenario B + F in one move.
  section("Scenario B — NEGOTIATING → ACCEPTED reflected in counts");
  const accBefore = await summaryCount("ACCEPTED");
  const negBefore2 = await summaryCount("NEGOTIATING");
  log(`counts before: NEGOTIATING=${negBefore2}, ACCEPTED=${accBefore}`);

  // A second positive/acceptance reply drives the negotiation to accept.
  await injectReply(instanceId, "POSITIVE", "That works for me — let's do it!");
  // The mock negotiation provider may counter; pump negotiation node jobs until
  // we reach a terminal or run out of attempts.
  let reachedAccepted = false;
  for (let i = 0; i < 6; i++) {
    const inst = await findInstanceById(instanceId);
    if (inst?.currentState === "ACCEPTED") {
      reachedAccepted = true;
      break;
    }
    if (inst && (inst.currentState === "REJECTED" || inst.currentState === "MANUAL_REVIEW")) {
      log(`negotiation ended at ${inst.currentState} instead of ACCEPTED (mock outcome) — counts still validated`);
      break;
    }
    if (inst?.currentState === "NEGOTIATING") {
      const ref = `p9-neg-${i}-${instanceId}`;
      await enqueueNodeExecution({ instanceId, expectedState: "NEGOTIATING", triggerRef: ref });
      await waitForNodeJob(`node-exec|${instanceId}|NEGOTIATING|${ref}`);
    }
    await delay(400);
  }

  const finalInst = await findInstanceById(instanceId);
  const accAfter = await summaryCount("ACCEPTED");
  const negAfter2 = await summaryCount("NEGOTIATING");
  log(`final state: ${finalInst?.currentState}; counts after: NEGOTIATING=${negAfter2}, ACCEPTED=${accAfter}`);

  if (reachedAccepted) {
    if (accAfter !== accBefore + 1) fail(`ACCEPTED count did not increase (${accBefore} → ${accAfter})`);
    pass("workflow counts updated automatically: NEGOTIATING −1, ACCEPTED +1");
  } else {
    // Negotiation reached a different terminal; assert NEGOTIATING decreased.
    if (negAfter2 >= negBefore2) fail(`NEGOTIATING count did not decrease (${negBefore2} → ${negAfter2})`);
    pass("workflow counts updated automatically: instance left NEGOTIATING for a terminal state");
  }

  // Scenario F assertion: read model changed between snapshots.
  const snap2 = await getInstanceDetail(instanceId);
  const updatedAt2 = snap2!.instance.updatedAt;
  const events2 = snap2!.events.length;
  log(`snapshot delta: updatedAt ${updatedAt1 === updatedAt2 ? "unchanged" : "changed"}, events ${events1} → ${events2}`);
  if (events2 <= events1 && updatedAt1 === updatedAt2)
    fail("read model did not change between successive polls");
  pass("successive reads of the read model reflect the new state (live polling works)");
}

// ---------------------------------------------------------------------------
// Static API-shape validation (independent of the live run above)
// ---------------------------------------------------------------------------

async function validateApiShapes(): Promise<void> {
  section("API contract — DTOs, no raw Prisma leakage");
  const sum = await getWorkflowSummary();
  if (!Array.isArray(sum.nodes) || sum.nodes.length !== 11)
    fail(`workflow summary should have 11 state nodes, got ${sum.nodes?.length}`);
  if (typeof sum.totalInstances !== "number") fail("totalInstances missing");
  // Every node has the derived metrics.
  for (const n of sum.nodes) {
    if (typeof n.count !== "number" || typeof n.terminal !== "boolean")
      fail(`node ${n.state} missing derived fields`);
  }
  pass("GET /observability/workflow returns 11 nodes with counts + derived metrics");

  // Detail of any instance must be a DTO (string timestamps, not Date objects).
  const any = (await listInstancesByVersion("wfv_seed_v1"))[0];
  if (any) {
    const d = await getInstanceDetail(any.id);
    if (d && typeof d.instance.enrolledAt !== "string")
      fail("instance.enrolledAt should be an ISO string in the DTO");
    pass("instance detail DTO serializes timestamps as ISO strings (no raw Prisma Date)");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\nPluvus Workflow — Phase 9 Observability Harness\n");

  const instances = await listInstancesByVersion("wfv_seed_v1");
  if (instances.length < 1) {
    console.error("No seeded instances. Run: npm run db:seed && npm run db:seed:demo");
    process.exit(1);
  }
  // Use the LAST instance to avoid clobbering the demo creators near the front.
  const target = instances[instances.length - 1]!;
  log(`using instance ${target.id} (creator ${target.creatorId})`);

  const workers: Worker[] = [
    createNodeExecutionWorker(),
    createInboundEmailWorker(),
    createDelayedSendWorker(),
  ];
  log("workers started (inline)");

  try {
    await validateApiShapes();
    await run(target.id);
    console.log(`\n✓ Phase 9 harness complete — ${passCount} checks passed\n`);
  } catch (err) {
    console.error(`\n✗ Phase 9 harness FAILED after ${passCount} checks:`, err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await getNodeExecutionQueue().close();
    await getInboundEmailQueue().close();
    await closeLockClient();
    await pool.end();
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
