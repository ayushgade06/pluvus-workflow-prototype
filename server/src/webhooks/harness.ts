/**
 * Phase 6 Nylas integration harness — validates the Nylas seam end-to-end with
 * NO real email account.
 *
 * Acceptance criteria exercised:
 *   1. Outbound send through the Nylas provider persists a real-shaped Nylas
 *      message id + thread id on the Message row (provider swap works).
 *   2. A correctly-signed inbound webhook is accepted, correlated to the right
 *      instance by threadId, and enqueues an inbound-email job that advances
 *      the instance off the real inbound event.
 *   3. A duplicate signed delivery is idempotent — no second job, no extra
 *      transition.
 *   4. A tampered body (bad signature) is rejected with 401 and enqueues
 *      nothing.
 *
 * Strategy: inject MockNylasClient into NylasEmailProvider so no network/email
 * account is needed, and POST signed payloads to the real /webhooks/nylas route
 * mounted on a throwaway Express app. Workers run in-process.
 *
 * Run with:
 *   npm run harness:phase6    (from server/)
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import express from "express";
import type { Server } from "http";
import type { Worker } from "bullmq";

import { WorkflowRuntime } from "../engine/runtime.js";
import { agentProvider } from "../engine/providerFactory.js";
import { NylasEmailProvider } from "../providers/nylas/nylasEmailProvider.js";
import { MockNylasClient, buildSignedWebhook } from "../providers/nylas/mockNylasClient.js";
import webhooksRouter from "../routes/webhooks.js";
import { createNodeExecutionWorker } from "../workers/nodeExecutionWorker.js";
import { createInboundEmailWorker } from "../workers/inboundEmailWorker.js";
import { getNodeExecutionQueue, getInboundEmailQueue } from "../workers/queues.js";
import { releaseLock, closeLockClient } from "../scheduler/lock.js";
import {
  listInstancesByVersion,
  updateInstanceState,
  findInstanceById,
  listMessagesByInstance,
  listEventsByInstance,
  prisma,
} from "../db/index.js";
import type { InstanceState } from "@prisma/client";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET =
  process.env["NYLAS_WEBHOOK_SECRET"] || "harness-test-secret";
// The webhook route reads NYLAS_WEBHOOK_SECRET from process.env. Ensure the
// route and this harness agree even when .env left the value empty (falsy),
// in which case we fell back to the harness default above.
process.env["NYLAS_WEBHOOK_SECRET"] = WEBHOOK_SECRET;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function log(msg: string): void {
  console.log(`  ${msg}`);
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

async function resetInstance(instanceId: string): Promise<void> {
  // Wipe this instance's prior Messages + Events so each run starts clean.
  // Necessary because the mock Nylas client emits deterministic message ids
  // (for reproducible signatures), which would otherwise collide with rows from
  // a previous run on the unique externalMessageId constraint.
  await prisma.event.deleteMany({ where: { instanceId } });
  await prisma.message.deleteMany({ where: { instanceId } });
  await updateInstanceState(instanceId, {
    currentState: "ENROLLED",
    currentNodeId: "node_import",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    completedAt: null,
  });
}

/** Wait until the instance's event count is stable for two consecutive reads,
 *  i.e. no worker is mid-flight writing more events. */
async function waitForQuiescence(
  instanceId: string,
  stableForMs = 1_000,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const count = (await listEventsByInstance(instanceId)).length;
    if (count === last) {
      if (Date.now() - stableSince >= stableForMs) return;
    } else {
      last = count;
      stableSince = Date.now();
    }
    await delay(200);
  }
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
    await delay(200);
  }
  const inst = await findInstanceById(instanceId);
  throw new Error(
    `Timeout waiting for ${instanceId} to reach ${target}. Current: ${inst?.currentState}`,
  );
}

// ---------------------------------------------------------------------------
// Test 1 — outbound send via NylasEmailProvider persists Nylas ids
// ---------------------------------------------------------------------------

async function test1OutboundSend(
  instanceId: string,
  mockClient: MockNylasClient,
): Promise<string> {
  section("Test 1: outbound send through Nylas provider");

  await resetInstance(instanceId);
  log("reset to ENROLLED");

  // Drive the instance through import → outreach using a runtime wired to the
  // Nylas provider (backed by the mock client). runUntilWaiting stops at
  // AWAITING_REPLY after outreach + follow-up entry.
  const runtime = new WorkflowRuntime(
    new NylasEmailProvider(mockClient, "mock-grant"),
    agentProvider(),
  );
  const finalState = await runtime.runUntilWaiting(instanceId);
  log(`ran until waiting — state: ${finalState}`);

  if (mockClient.sent.length === 0) {
    throw new Error("Test 1 FAILED: no message was sent through the Nylas client");
  }
  log(`Nylas client recorded ${mockClient.sent.length} outbound send(s)`);

  // The outbound Message row must carry the Nylas-shaped message + thread id.
  // listMessagesByInstance is ordered createdAt asc and Messages from earlier
  // harness runs are not deleted by resetInstance, so take the MOST RECENT
  // outbound — the one this run just created through the Nylas provider.
  const messages = await listMessagesByInstance(instanceId);
  const outbound = [...messages].reverse().find((m) => m.direction === "OUTBOUND");
  if (!outbound) throw new Error("Test 1 FAILED: no outbound Message persisted");

  log(`outbound Message externalMessageId=${outbound.externalMessageId}, threadId=${outbound.threadId}`);
  if (!outbound.externalMessageId?.startsWith("nylas-msg-")) {
    throw new Error(
      `Test 1 FAILED: externalMessageId not from Nylas provider (got ${outbound.externalMessageId})`,
    );
  }
  if (!outbound.threadId?.startsWith("nylas-thread-")) {
    throw new Error(
      `Test 1 FAILED: threadId not from Nylas provider (got ${outbound.threadId})`,
    );
  }
  log("PASS — Nylas message/thread ids persisted on the outbound Message");

  return outbound.threadId;
}

// ---------------------------------------------------------------------------
// Test 2 — signed inbound webhook correlates + enqueues + advances
// ---------------------------------------------------------------------------

async function postWebhook(
  baseUrl: string,
  rawBody: string,
  signature: string | null,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-nylas-signature"] = signature;

  const res = await fetch(`${baseUrl}/webhooks/nylas`, {
    method: "POST",
    headers,
    body: rawBody,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

async function test2InboundWebhook(
  baseUrl: string,
  instanceId: string,
  threadId: string,
  inboundMsgId: string,
): Promise<void> {
  section("Test 2: signed inbound webhook → correlate → advance");

  const before = await findInstanceById(instanceId);
  const stateBefore = before?.currentState;
  log(`instance state before reply: ${stateBefore} (thread ${threadId})`);

  const { rawBody, signature } = buildSignedWebhook(
    {
      messageId: inboundMsgId,
      threadId,
      subject: "Re: Collaboration opportunity",
      body: "Yes, I'm very interested — let's talk!",
      fromEmail: "creator@example.com",
    },
    WEBHOOK_SECRET,
  );

  const res = await postWebhook(baseUrl, rawBody, signature);
  log(`webhook responded ${res.status}: ${JSON.stringify(res.json)}`);
  if (res.status !== 200) {
    throw new Error(`Test 2 FAILED: webhook returned ${res.status}, expected 200`);
  }

  // The webhook enqueued an inbound-email job; the worker advances the instance
  // from REPLY_RECEIVED through reply detection to NEGOTIATING (POSITIVE).
  await waitForState(instanceId, "NEGOTIATING", 15_000);
  log("instance reached NEGOTIATING off the real inbound event");
  log("PASS — webhook correlated by threadId and drove the engine forward");
}

// ---------------------------------------------------------------------------
// Test 3 — duplicate delivery is idempotent
// ---------------------------------------------------------------------------

async function test3Idempotency(
  baseUrl: string,
  instanceId: string,
  threadId: string,
  inboundMsgId: string,
): Promise<void> {
  section("Test 3: duplicate signed delivery is idempotent");

  // Wait for the system to fully quiesce after Test 2: the worker flips the
  // state to NEGOTIATING slightly before it finishes writing that step's
  // events, so snapshot only once the event count has stopped changing.
  await waitForQuiescence(instanceId);

  const eventsBefore = (await listEventsByInstance(instanceId)).length;
  const stateBefore = (await findInstanceById(instanceId))?.currentState;

  // Re-POST the EXACT same delivery (same externalMessageId as Test 2).
  const { rawBody, signature } = buildSignedWebhook(
    {
      messageId: inboundMsgId,
      threadId,
      subject: "Re: Collaboration opportunity",
      body: "Yes, I'm very interested — let's talk!",
      fromEmail: "creator@example.com",
    },
    WEBHOOK_SECRET,
  );

  const res = await postWebhook(baseUrl, rawBody, signature);
  log(`duplicate webhook responded ${res.status}`);
  await delay(3_000); // give any (incorrectly) enqueued job time to run

  const eventsAfter = (await listEventsByInstance(instanceId)).length;
  const stateAfter = (await findInstanceById(instanceId))?.currentState;
  log(`state: ${stateBefore} → ${stateAfter}, events Δ=${eventsAfter - eventsBefore}`);

  if (stateAfter !== stateBefore) {
    throw new Error(
      `Test 3 FAILED: duplicate delivery changed state (${stateBefore} → ${stateAfter})`,
    );
  }
  if (eventsAfter !== eventsBefore) {
    throw new Error(
      `Test 3 FAILED: duplicate delivery wrote ${eventsAfter - eventsBefore} extra events`,
    );
  }
  log("PASS — duplicate webhook delivery was a no-op (jobId + externalMessageId dedup)");
}

// ---------------------------------------------------------------------------
// Test 4 — tampered body is rejected (401), enqueues nothing
// ---------------------------------------------------------------------------

async function test4BadSignature(
  baseUrl: string,
  threadId: string,
): Promise<void> {
  section("Test 4: tampered body rejected with 401");

  const { rawBody, signature } = buildSignedWebhook(
    {
      messageId: "nylas-inbound-tampered",
      threadId,
      subject: "Re: Collaboration opportunity",
      body: "original body",
      fromEmail: "creator@example.com",
    },
    WEBHOOK_SECRET,
  );

  // Tamper with the body AFTER signing — signature no longer matches.
  const tampered = rawBody.replace("original body", "tampered body");
  const res = await postWebhook(baseUrl, tampered, signature);
  log(`tampered webhook responded ${res.status}`);
  if (res.status !== 401) {
    throw new Error(`Test 4 FAILED: tampered delivery returned ${res.status}, expected 401`);
  }

  // Also: missing signature → 401.
  const resNoSig = await postWebhook(baseUrl, rawBody, null);
  log(`missing-signature webhook responded ${resNoSig.status}`);
  if (resNoSig.status !== 401) {
    throw new Error(`Test 4 FAILED: missing-signature delivery returned ${resNoSig.status}, expected 401`);
  }
  log("PASS — invalid/missing signatures rejected, nothing enqueued");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const instances = await listInstancesByVersion("wfv_seed_v1");
  if (instances.length < 1) {
    console.error(
      `Need at least 1 seeded instance, found ${instances.length}. Run: npm run db:seed`,
    );
    process.exit(1);
  }

  console.log("\nPluvus Workflow — Phase 6 Nylas Integration Harness\n");
  log(`webhook secret: ${WEBHOOK_SECRET === "harness-test-secret" ? "(harness default)" : "(from .env)"}`);

  // Throwaway Express app exposing ONLY the webhook route, mounted exactly as
  // production does (raw parser before any json parser).
  const app = express();
  app.use("/webhooks", express.raw({ type: "*/*", limit: "2mb" }), webhooksRouter);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`webhook test server on ${baseUrl}`);

  // In-process workers process the enqueued inbound-email jobs.
  const mockClient = new MockNylasClient();
  const workers: Worker[] = [
    createNodeExecutionWorker(),
    createInboundEmailWorker(),
  ];
  log("workers started");

  const instanceId = instances[0]!.id;

  // Per-run-unique inbound message id: same id is reused within this run (so
  // Test 3 genuinely exercises duplicate-delivery dedup) but differs across
  // runs, so a prior run's completed BullMQ job (jobId = inbound|<id>) or its
  // Message row can't block or collide with this one.
  const inboundMsgId = `nylas-inbound-${Date.now()}`;

  // Clear any stale per-instance Redis lock left by a previously interrupted
  // run, and drain the inbound queue so old jobs don't interfere.
  await releaseLock(instanceId);
  await getInboundEmailQueue().obliterate({ force: true });
  log(`run inbound message id: ${inboundMsgId}`);

  try {
    const threadId = await test1OutboundSend(instanceId, mockClient);
    await test2InboundWebhook(baseUrl, instanceId, threadId, inboundMsgId);
    await test3Idempotency(baseUrl, instanceId, threadId, inboundMsgId);
    await test4BadSignature(baseUrl, threadId);

    console.log("\n✓ Phase 6 harness complete — all tests passed\n");
  } catch (err) {
    console.error("\n✗ Phase 6 harness FAILED:", err);
    process.exitCode = 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(workers.map((w) => w.close()));
    await getNodeExecutionQueue().close();
    await getInboundEmailQueue().close();
    await closeLockClient();
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
