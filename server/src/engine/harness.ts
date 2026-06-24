/**
 * Phase 3 test harness — runs a complete creator journey through the workflow
 * runtime engine using mock providers.
 *
 * Run with:
 *   npm run harness          (from server/)
 *   npx tsx src/engine/harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import type { InstanceState } from "@prisma/client";
import {
  listInstancesByVersion,
  updateInstanceState,
  findInstanceById,
  listEventsByInstance,
  listMessagesByInstance,
} from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";

// ---------------------------------------------------------------------------
// Trace collector
// ---------------------------------------------------------------------------

interface PathResult {
  label: string;
  title: string;
  trace: InstanceState[];
  finalState: InstanceState;
  eventsWritten: number;
  messagesWritten: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resetInstance(instanceId: string): Promise<void> {
  await updateInstanceState(instanceId, {
    currentState: "ENROLLED",
    currentNodeId: "node_import",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    completedAt: null,
  });
}

async function currentState(instanceId: string): Promise<InstanceState> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`Instance not found: ${instanceId}`);
  return inst.currentState;
}

// Record a state into the trace only when it differs from the last entry.
function record(trace: InstanceState[], state: InstanceState): void {
  if (trace[trace.length - 1] !== state) trace.push(state);
}

// ---------------------------------------------------------------------------
// Path A: Happy path — ACCEPTED via negotiation
// ---------------------------------------------------------------------------

async function runHappyPath(instanceId: string): Promise<PathResult> {
  const label = "A";
  const title = "Happy Path";
  const trace: InstanceState[] = [];

  const runtime = new WorkflowRuntime(
    new MockEmailProvider(),
    new MockAgentProvider({
      replyIntent: "POSITIVE",
      negotiationOutcome: "accept",
      negotiationCounterUntilRound: 1, // counter round 0, accept round 1
    }),
  );

  const eventsBefore = (await listEventsByInstance(instanceId)).length;
  const messagesBefore = (await listMessagesByInstance(instanceId)).length;

  await resetInstance(instanceId);
  record(trace, "ENROLLED");

  // import → outreach → follow-up entry → AWAITING_REPLY
  await runtime.runUntilWaiting(instanceId);
  record(trace, await currentState(instanceId));

  // Trigger one follow-up cycle: AWAITING_REPLY → FOLLOWED_UP → AWAITING_REPLY
  await runtime.stepInstance(instanceId);
  record(trace, await currentState(instanceId));
  await runtime.stepInstance(instanceId);
  record(trace, await currentState(instanceId));

  // Inject positive reply → REPLY_RECEIVED
  await runtime.injectReply(instanceId, {
    subject: "Re: Collaboration opportunity",
    body: "Yes I'm interested! Let's discuss terms.",
  });
  record(trace, await currentState(instanceId));

  // Reply detection → NEGOTIATING
  await runtime.runUntilWaiting(instanceId);
  record(trace, await currentState(instanceId));

  // Negotiation: round 0 counter → round 1 accept → ACCEPTED
  await runtime.stepInstance(instanceId);
  record(trace, await currentState(instanceId));
  await runtime.stepInstance(instanceId);
  record(trace, await currentState(instanceId));

  const finalState = await currentState(instanceId);
  const eventsAfter = (await listEventsByInstance(instanceId)).length;
  const messagesAfter = (await listMessagesByInstance(instanceId)).length;

  return {
    label, title, trace, finalState,
    eventsWritten: eventsAfter - eventsBefore,
    messagesWritten: messagesAfter - messagesBefore,
  };
}

// ---------------------------------------------------------------------------
// Path B: Opt-out
// ---------------------------------------------------------------------------

async function runOptOutPath(instanceId: string): Promise<PathResult> {
  const label = "B";
  const title = "Opt-Out";
  const trace: InstanceState[] = [];

  const runtime = new WorkflowRuntime(
    new MockEmailProvider(),
    new MockAgentProvider({ replyIntent: "OPT_OUT" }),
  );

  const eventsBefore = (await listEventsByInstance(instanceId)).length;
  const messagesBefore = (await listMessagesByInstance(instanceId)).length;

  await resetInstance(instanceId);
  record(trace, "ENROLLED");

  await runtime.runUntilWaiting(instanceId);
  record(trace, await currentState(instanceId));

  await runtime.injectReply(instanceId, {
    subject: "Re: Collaboration opportunity",
    body: "Please remove me from your list. Not interested.",
  });
  record(trace, await currentState(instanceId));

  await runtime.runUntilWaiting(instanceId);
  record(trace, await currentState(instanceId));

  const finalState = await currentState(instanceId);
  const eventsAfter = (await listEventsByInstance(instanceId)).length;
  const messagesAfter = (await listMessagesByInstance(instanceId)).length;

  return {
    label, title, trace, finalState,
    eventsWritten: eventsAfter - eventsBefore,
    messagesWritten: messagesAfter - messagesBefore,
  };
}

// ---------------------------------------------------------------------------
// Path C: No response — exhaust all follow-ups
// ---------------------------------------------------------------------------

async function runNoResponsePath(instanceId: string): Promise<PathResult> {
  const label = "C";
  const title = "No Response";
  const trace: InstanceState[] = [];

  const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

  const eventsBefore = (await listEventsByInstance(instanceId)).length;
  const messagesBefore = (await listMessagesByInstance(instanceId)).length;

  await resetInstance(instanceId);
  record(trace, "ENROLLED");

  await runtime.runUntilWaiting(instanceId);
  record(trace, await currentState(instanceId));

  // Step through follow-up cycles until NO_RESPONSE
  let iteration = 0;
  const maxIterations = 20;
  let state = await currentState(instanceId);

  while (state !== "NO_RESPONSE" && iteration++ < maxIterations) {
    await runtime.stepInstance(instanceId);
    state = await currentState(instanceId);
    record(trace, state);
  }

  const finalState = await currentState(instanceId);
  const eventsAfter = (await listEventsByInstance(instanceId)).length;
  const messagesAfter = (await listMessagesByInstance(instanceId)).length;

  return {
    label, title, trace, finalState,
    eventsWritten: eventsAfter - eventsBefore,
    messagesWritten: messagesAfter - messagesBefore,
  };
}

// ---------------------------------------------------------------------------
// Output formatter
// ---------------------------------------------------------------------------

function printResult(result: PathResult): void {
  console.log(`Path ${result.label} — ${result.title}`);
  for (const [i, state] of result.trace.entries()) {
    console.log(i === 0 ? `  ${state}` : `  → ${state}`);
  }
  console.log();
  console.log(`  Final State:      ${result.finalState}`);
  console.log(`  Events Written:   ${result.eventsWritten}`);
  console.log(`  Messages Written: ${result.messagesWritten}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const instances = await listInstancesByVersion("wfv_seed_v1");

  if (instances.length < 3) {
    console.error(`Need at least 3 seeded instances, found ${instances.length}. Run: npm run db:seed`);
    process.exit(1);
  }

  const [inst0, inst1, inst2] = instances as [
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
  ];

  console.log("\nPluvus Workflow Runtime — Phase 3 Harness\n");

  const results = [
    await runHappyPath(inst0.id),
    await runOptOutPath(inst1.id),
    await runNoResponsePath(inst2.id),
  ];

  for (const result of results) {
    printResult(result);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(1);
});
