/**
 * Phase 3 test harness — runs a complete creator journey through the workflow
 * runtime engine using mock providers.
 *
 * Run with:
 *   npx tsx src/engine/harness.ts
 * Or add to package.json scripts:
 *   "harness": "tsx src/engine/harness.ts"
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
import type { InstanceState } from "@prisma/client";
import { listInstancesByVersion, updateInstanceState, findInstanceById } from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(label: string, instanceId: string, state: string, node: string | null, msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${label}] instance=${instanceId.slice(-8)} state=${state} node=${node ?? "none"} | ${msg}`);
}

function separator(title: string) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(72)}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resetInstance(instanceId: string, nodeId = "node_import"): Promise<void> {
  await updateInstanceState(instanceId, {
    currentState: "ENROLLED",
    currentNodeId: nodeId,
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    completedAt: null,
  });
}

async function getState(instanceId: string): Promise<{ state: InstanceState; nodeId: string | null }> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`Instance not found: ${instanceId}`);
  return { state: inst.currentState, nodeId: inst.currentNodeId ?? null };
}

// ---------------------------------------------------------------------------
// Path A: ACCEPTED (happy path with negotiation)
// ---------------------------------------------------------------------------

async function runHappyPath(instance: { id: string }, runtime: WorkflowRuntime): Promise<void> {
  separator("Path A — Happy Path (ENROLLED → ACCEPTED via negotiation)");

  const { id } = instance;
  await resetInstance(id);
  log("A", id, "ENROLLED", "node_import", "Reset to ENROLLED. Starting runUntilWaiting...");

  // Run import → outreach → follow-up entry (AWAITING_REPLY)
  let state = await runtime.runUntilWaiting(id);
  let snap = await getState(id);
  log("A", id, snap.state, snap.nodeId, `runUntilWaiting stopped at ${state}`);

  console.log("  -> Simulating time passing (follow-up due)...");

  // Trigger a follow-up: AWAITING_REPLY → FOLLOWED_UP
  let ctx = await runtime.stepInstance(id);
  snap = await getState(id);
  log("A", id, snap.state, snap.nodeId, "Follow-up step 1 complete (FOLLOWED_UP)");

  // Reschedule: FOLLOWED_UP → AWAITING_REPLY
  ctx = await runtime.stepInstance(id);
  snap = await getState(id);
  log("A", id, snap.state, snap.nodeId, "Follow-up reschedule complete (AWAITING_REPLY)");

  console.log("  -> Injecting positive reply...");

  // Inject inbound reply
  await runtime.injectReply(id, {
    subject: "Re: Collaboration opportunity",
    body: "Yes I'm interested! Let's discuss terms.",
    threadId: `mock-thread-${id}`,
  });
  snap = await getState(id);
  log("A", id, snap.state, snap.nodeId, "Reply injected → REPLY_RECEIVED");

  // Run reply detection → NEGOTIATING
  state = await runtime.runUntilWaiting(id);
  snap = await getState(id);
  log("A", id, snap.state, snap.nodeId, `After reply detection: ${state}`);

  console.log("  -> Creator is negotiating. Simulating 2-round negotiation (counter then accept)...");

  // Round 1: counter
  ctx = await runtime.stepInstance(id);
  snap = await getState(id);
  log("A", id, snap.state, snap.nodeId, `Negotiation round 1: ${snap.state}`);

  // Round 2: accept
  ctx = await runtime.stepInstance(id);
  snap = await getState(id);
  log("A", id, snap.state, snap.nodeId, `Negotiation round 2: ${snap.state}`);

  if (snap.state === "ACCEPTED") {
    console.log("\n  *** Path A complete: creator ACCEPTED the deal! ***\n");
  } else {
    console.log(`\n  *** Path A finished with state: ${snap.state} ***\n`);
  }
  void ctx;
}

// ---------------------------------------------------------------------------
// Path B: OPT_OUT
// ---------------------------------------------------------------------------

async function runOptOutPath(instance: { id: string }): Promise<void> {
  separator("Path B — Opt-Out Path (ENROLLED → OPTED_OUT)");

  const { id } = instance;

  // Use an agent that will classify as OPT_OUT
  const optOutAgent = new MockAgentProvider({ replyIntent: "OPT_OUT" });
  const optOutRuntime = new WorkflowRuntime(new MockEmailProvider(), optOutAgent);

  await resetInstance(id);
  log("B", id, "ENROLLED", "node_import", "Reset to ENROLLED. Starting runUntilWaiting...");

  // Run to AWAITING_REPLY
  let state = await optOutRuntime.runUntilWaiting(id);
  let snap = await getState(id);
  log("B", id, snap.state, snap.nodeId, `Reached ${state}. Injecting opt-out reply...`);

  // Inject opt-out reply
  await optOutRuntime.injectReply(id, {
    subject: "Re: Collaboration opportunity",
    body: "Please remove me from your list. Not interested.",
  });
  snap = await getState(id);
  log("B", id, snap.state, snap.nodeId, "Reply injected → REPLY_RECEIVED");

  // Run reply detection → OPTED_OUT
  state = await optOutRuntime.runUntilWaiting(id);
  snap = await getState(id);
  log("B", id, snap.state, snap.nodeId, `Final state: ${state}`);

  if (snap.state === "OPTED_OUT") {
    console.log("\n  *** Path B complete: creator OPTED_OUT as expected. ***\n");
  } else {
    console.log(`\n  *** Path B finished with unexpected state: ${snap.state} ***\n`);
  }
}

// ---------------------------------------------------------------------------
// Path C: NO_RESPONSE (exhaust all follow-ups)
// ---------------------------------------------------------------------------

async function runNoResponsePath(instance: { id: string }): Promise<void> {
  separator("Path C — No Response Path (ENROLLED → NO_RESPONSE after max follow-ups)");

  const { id } = instance;
  const silentRuntime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

  await resetInstance(id);
  log("C", id, "ENROLLED", "node_import", "Reset to ENROLLED. Starting runUntilWaiting...");

  // Run to AWAITING_REPLY
  let state = await silentRuntime.runUntilWaiting(id);
  let snap = await getState(id);
  log("C", id, snap.state, snap.nodeId, `Reached ${state}. Simulating maxCount follow-ups...`);

  // The follow-up node config has maxCount=3.
  // We need to step through: 3x (AWAITING_REPLY → FOLLOWED_UP → AWAITING_REPLY)
  // then one final step AWAITING_REPLY → NO_RESPONSE
  let iteration = 0;
  const maxIterations = 20; // safety guard

  while (snap.state !== "NO_RESPONSE" && !["ACCEPTED", "REJECTED", "OPTED_OUT"].includes(snap.state)) {
    if (iteration++ >= maxIterations) {
      console.log("  (safety limit reached)");
      break;
    }

    const before = snap.state;
    await silentRuntime.stepInstance(id);
    snap = await getState(id);
    log("C", id, snap.state, snap.nodeId, `Step ${iteration}: ${before} → ${snap.state}`);

    // No reply injected — keep stepping through follow-up cycle
  }

  if (snap.state === "NO_RESPONSE") {
    console.log("\n  *** Path C complete: creator hit NO_RESPONSE after max follow-ups. ***\n");
  } else {
    console.log(`\n  *** Path C finished with state: ${snap.state} ***\n`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log("\nPluvus Workflow Runtime — Phase 3 Test Harness");
  console.log(`Run started at: ${new Date().toISOString()}\n`);

  // Load seeded instances from the DB
  const instances = await listInstancesByVersion("wfv_seed_v1");

  if (instances.length < 3) {
    console.error(
      `Need at least 3 seeded instances, found ${instances.length}. Run: npm run db:seed`,
    );
    process.exit(1);
  }

  const [inst0, inst1, inst2] = instances as [
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
  ];

  // Path A — happy path with negotiation (counter once then accept)
  const happyRuntime = new WorkflowRuntime(
    new MockEmailProvider(),
    new MockAgentProvider({
      replyIntent: "POSITIVE",
      negotiationOutcome: "accept",
      negotiationCounterUntilRound: 1, // counter on round 0, accept on round 1
    }),
  );
  await runHappyPath(inst0, happyRuntime);

  // Path B — opt-out
  await runOptOutPath(inst1);

  // Path C — no response (exhaust all follow-ups)
  await runNoResponsePath(inst2);

  separator("Harness Complete");
  console.log("All three journeys finished successfully.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(1);
});
