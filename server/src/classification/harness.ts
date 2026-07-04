/**
 * Phase 7 classification harness — validates reply classification and
 * intent-driven workflow transitions end-to-end.
 *
 * Acceptance criteria:
 *   1. "Yes, interested"        → POSITIVE  → NEGOTIATING
 *   2. "Please remove me"       → OPT_OUT   → OPTED_OUT
 *   3. "Not interested"         → NEGATIVE  → REJECTED
 *   4. "What is the commission rate?" → QUESTION → NEGOTIATING
 *   5. Ambiguous / low-confidence    → UNKNOWN  → MANUAL_REVIEW
 *   6. Low-confidence override: any result below 0.50 → UNKNOWN → MANUAL_REVIEW
 *
 * Strategy: the harness drives instances directly through the engine using
 * WorkflowRuntime.  Classification uses the MockClassificationProvider
 * (keyword-based) so no LLM key is required.  The LangGraphClassificationProvider
 * path is tested implicitly when AGENT_PROVIDER=langgraph is set and the agent
 * service is running.
 *
 * Run with:
 *   npm run harness:phase7   (from server/)
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { WorkflowRuntime } from "../engine/runtime.js";
import { MockEmailProvider } from "../engine/providers.js";
import { MockClassificationProvider, FixedClassificationProvider } from "../adapters/classification/MockClassificationProvider.js";
import {
  listInstancesByVersion,
  findInstanceById,
  listMessagesByInstance,
  listEventsByInstance,
  updateInstanceState,
  prisma,
} from "../db/index.js";
import { closeLockClient } from "../scheduler/lock.js";
import type { InstanceState, ReplyIntent } from "@prisma/client";
import type { ClassifyResult, BrandDecisionClassifyResult } from "../engine/types.js";
import type { ClassificationProvider } from "../adapters/classification/ClassificationProvider.js";
import type { IAgentProvider } from "../engine/providers.js";
import type { NegotiateResult } from "../engine/types.js";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`  ${msg}`);
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}
function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}
function fail(msg: string): never {
  throw new Error(`FAIL: ${msg}`);
}

// ---------------------------------------------------------------------------
// AgentProvider adapter (classification-provider backed)
// ---------------------------------------------------------------------------
// Wires a ClassificationProvider into the IAgentProvider interface so we can
// inject it directly into WorkflowRuntime without touching providerFactory.

class HarnessAgentProvider implements IAgentProvider {
  constructor(private readonly classifier: ClassificationProvider) {}

  async classify(body: string): Promise<ClassifyResult> {
    const result = await this.classifier.classify({ message: body });
    return { intent: result.intent as ReplyIntent, confidence: result.confidence };
  }

  async classifyBrandDecision(body: string): Promise<BrandDecisionClassifyResult> {
    const result = await this.classifier.classify({ message: body });
    switch (result.intent) {
      case "POSITIVE":
      case "QUESTION":
        return { decision: "APPROVE", confidence: result.confidence };
      case "NEGATIVE":
      case "OPT_OUT":
        return { decision: "REJECT", confidence: result.confidence };
      default:
        return { decision: "AMBIGUOUS", confidence: 0 };
    }
  }

  async negotiate(_round: number, _config: Record<string, unknown>): Promise<NegotiateResult> {
    return { outcome: "accept", message: "harness accepts" };
  }

  async draftEmail(): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Instance setup helpers
// ---------------------------------------------------------------------------

async function resetToReplyReceived(instanceId: string, body: string): Promise<string> {
  // Wipe prior messages + events for a clean slate.
  await prisma.event.deleteMany({ where: { instanceId } });
  await prisma.message.deleteMany({ where: { instanceId } });

  // Advance to AWAITING_REPLY via a MockEmailProvider runtime.
  await updateInstanceState(instanceId, {
    currentState: "ENROLLED",
    currentNodeId: "node_import",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    completedAt: null,
  });

  const setupRuntime = new WorkflowRuntime(
    new MockEmailProvider(),
    new HarnessAgentProvider(new MockClassificationProvider()),
  );
  await setupRuntime.runUntilWaiting(instanceId);

  // Inject the inbound reply — transitions to REPLY_RECEIVED.
  const externalMessageId = `harness-inbound-${instanceId}-${Date.now()}`;
  await setupRuntime.injectReply(instanceId, {
    subject: "Re: Collaboration opportunity",
    body,
    threadId: `harness-thread-${instanceId}`,
    externalMessageId,
  });

  const inst = await findInstanceById(instanceId);
  if (inst?.currentState !== "REPLY_RECEIVED") {
    fail(`Expected REPLY_RECEIVED after injectReply, got ${inst?.currentState}`);
  }
  return externalMessageId;
}

// ---------------------------------------------------------------------------
// Individual test scenarios
// ---------------------------------------------------------------------------

interface ScenarioResult {
  message: string;
  expectedIntent: string;
  actualIntent: string;
  confidence: number;
  expectedState: InstanceState;
  actualState: InstanceState | undefined;
}

async function runScenario(
  instanceId: string,
  message: string,
  expectedIntent: string,
  expectedState: InstanceState,
  classifier: ClassificationProvider,
): Promise<ScenarioResult> {
  await resetToReplyReceived(instanceId, message);

  const runtime = new WorkflowRuntime(
    new MockEmailProvider(),
    new HarnessAgentProvider(classifier),
  );

  await runtime.stepInstance(instanceId);

  const updated = await findInstanceById(instanceId);
  const messages = await listMessagesByInstance(instanceId);
  const inbound = messages.filter((m) => m.direction === "INBOUND").at(-1);

  return {
    message,
    expectedIntent,
    actualIntent: inbound?.replyIntent ?? "null",
    confidence: inbound?.classifyConfidence ?? 0,
    expectedState,
    actualState: updated?.currentState,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test1Positive(instanceId: string): Promise<void> {
  section("Test 1: POSITIVE → NEGOTIATING");
  const result = await runScenario(
    instanceId,
    "Yes, I'm interested — let's discuss!",
    "POSITIVE",
    "NEGOTIATING",
    new MockClassificationProvider(),
  );
  log(`message:    "${result.message}"`);
  log(`intent:     ${result.actualIntent} (confidence: ${result.confidence.toFixed(2)})`);
  log(`state:      ${result.actualState}`);
  if (result.actualIntent !== "POSITIVE") fail(`Expected POSITIVE, got ${result.actualIntent}`);
  if (result.actualState !== "NEGOTIATING") fail(`Expected NEGOTIATING, got ${result.actualState}`);
  pass("POSITIVE reply → NEGOTIATING");
}

async function test2OptOut(instanceId: string): Promise<void> {
  section("Test 2: OPT_OUT → OPTED_OUT");
  const result = await runScenario(
    instanceId,
    "Please remove me from your mailing list.",
    "OPT_OUT",
    "OPTED_OUT",
    new MockClassificationProvider(),
  );
  log(`message:    "${result.message}"`);
  log(`intent:     ${result.actualIntent} (confidence: ${result.confidence.toFixed(2)})`);
  log(`state:      ${result.actualState}`);
  if (result.actualIntent !== "OPT_OUT") fail(`Expected OPT_OUT, got ${result.actualIntent}`);
  if (result.actualState !== "OPTED_OUT") fail(`Expected OPTED_OUT, got ${result.actualState}`);
  pass("OPT_OUT reply → OPTED_OUT");
}

async function test3Negative(instanceId: string): Promise<void> {
  section("Test 3: NEGATIVE → REJECTED");
  const result = await runScenario(
    instanceId,
    "Not interested, thanks.",
    "NEGATIVE",
    "REJECTED",
    new MockClassificationProvider(),
  );
  log(`message:    "${result.message}"`);
  log(`intent:     ${result.actualIntent} (confidence: ${result.confidence.toFixed(2)})`);
  log(`state:      ${result.actualState}`);
  if (result.actualIntent !== "NEGATIVE") fail(`Expected NEGATIVE, got ${result.actualIntent}`);
  if (result.actualState !== "REJECTED") fail(`Expected REJECTED, got ${result.actualState}`);
  pass("NEGATIVE reply → REJECTED");
}

async function test4Question(instanceId: string): Promise<void> {
  section("Test 4: QUESTION → NEGOTIATING");
  const result = await runScenario(
    instanceId,
    "What is the commission rate for this campaign?",
    "QUESTION",
    "NEGOTIATING",
    new MockClassificationProvider(),
  );
  log(`message:    "${result.message}"`);
  log(`intent:     ${result.actualIntent} (confidence: ${result.confidence.toFixed(2)})`);
  log(`state:      ${result.actualState}`);
  if (result.actualIntent !== "QUESTION") fail(`Expected QUESTION, got ${result.actualIntent}`);
  if (result.actualState !== "NEGOTIATING") fail(`Expected NEGOTIATING, got ${result.actualState}`);
  pass("QUESTION reply → NEGOTIATING");
}

async function test5Unknown(instanceId: string): Promise<void> {
  section("Test 5: UNKNOWN → MANUAL_REVIEW");
  // "Hmm." has no keywords — MockClassificationProvider returns UNKNOWN @ 0.50.
  const result = await runScenario(
    instanceId,
    "Hmm.",
    "UNKNOWN",
    "MANUAL_REVIEW",
    new MockClassificationProvider(),
  );
  log(`message:    "${result.message}"`);
  log(`intent:     ${result.actualIntent} (confidence: ${result.confidence.toFixed(2)})`);
  log(`state:      ${result.actualState}`);
  if (result.actualIntent !== "UNKNOWN") fail(`Expected UNKNOWN, got ${result.actualIntent}`);
  if (result.actualState !== "MANUAL_REVIEW") fail(`Expected MANUAL_REVIEW, got ${result.actualState}`);
  pass("Ambiguous reply → UNKNOWN → MANUAL_REVIEW");
}

async function test6LowConfidence(instanceId: string): Promise<void> {
  section("Test 6: low-confidence override → UNKNOWN → MANUAL_REVIEW");
  // M4: the real threshold is 0.50 (LOW_CONFIDENCE_THRESHOLD in replyDetection).
  // The prior fixture declared POSITIVE @ 0.60 and expected UNKNOWN — but
  // 0.60 is NOT < 0.50, so the override would NOT fire and this test asserted a
  // behavior that never happens. Use 0.40 so it actually exercises the boundary.
  const result = await runScenario(
    instanceId,
    "Maybe, I'll think about it.",
    "UNKNOWN",
    "MANUAL_REVIEW",
    new FixedClassificationProvider("POSITIVE", 0.40),
  );
  log(`message:    "${result.message}"`);
  log(`declared:   POSITIVE @ 0.40 (below 0.50 threshold)`);
  log(`actual intent on message: ${result.actualIntent} (confidence: ${result.confidence.toFixed(2)})`);
  log(`state:      ${result.actualState}`);
  if (result.actualIntent !== "UNKNOWN") {
    fail(`Expected UNKNOWN after low-confidence override, got ${result.actualIntent}`);
  }
  if (result.actualState !== "MANUAL_REVIEW") {
    fail(`Expected MANUAL_REVIEW after low-confidence, got ${result.actualState}`);
  }
  pass("Low-confidence (0.40 < 0.50) → UNKNOWN override → MANUAL_REVIEW");
}

async function test7EventCreation(instanceId: string): Promise<void> {
  section("Test 7: event creation validation");
  // Run a POSITIVE scenario and verify REPLY_CLASSIFIED event was created.
  await resetToReplyReceived(instanceId, "Yes, absolutely interested!");

  const runtime = new WorkflowRuntime(
    new MockEmailProvider(),
    new HarnessAgentProvider(new MockClassificationProvider()),
  );
  await runtime.stepInstance(instanceId);

  const events = await listEventsByInstance(instanceId);
  const classified = events.find((e) => e.type === "REPLY_CLASSIFIED");
  const transition = events.find(
    (e) => e.type === "STATE_TRANSITION" &&
    (e.payload as Record<string, unknown>)?.["to"] === "NEGOTIATING",
  );

  log(`events created: ${events.map((e) => e.type).join(", ")}`);

  if (!classified) fail("No REPLY_CLASSIFIED event found");
  const payload = classified.payload as Record<string, unknown>;
  log(`REPLY_CLASSIFIED payload: intent=${payload["intent"]}, confidence=${payload["confidence"]}`);

  if (!transition) fail("No STATE_TRANSITION to NEGOTIATING event found");
  pass("REPLY_CLASSIFIED + STATE_TRANSITION events created");

  // Verify MANUAL_REVIEW_FLAGGED event for UNKNOWN case.
  await resetToReplyReceived(instanceId, "Hmm.");
  const runtime2 = new WorkflowRuntime(
    new MockEmailProvider(),
    new HarnessAgentProvider(new MockClassificationProvider()),
  );
  await runtime2.stepInstance(instanceId);

  const events2 = await listEventsByInstance(instanceId);
  const flagged = events2.find((e) => e.type === "MANUAL_REVIEW_FLAGGED");
  if (!flagged) fail("No MANUAL_REVIEW_FLAGGED event found for UNKNOWN intent");
  log(`MANUAL_REVIEW_FLAGGED event: ${JSON.stringify(flagged.payload)}`);
  pass("MANUAL_REVIEW_FLAGGED event created for UNKNOWN intent");
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

  console.log("\nPluvus Workflow — Phase 7 Classification Harness\n");

  const agentMode = process.env["AGENT_PROVIDER"] ?? "mock";
  log(`classification provider: ${agentMode}`);
  if (agentMode === "langgraph") {
    log(`agent service URL: ${process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000"}`);
    log("(will fall back to mock if agent service unreachable)");
  }

  const instanceId = instances[0]!.id;
  log(`using instance: ${instanceId}\n`);

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${name}: ${msg}`);
      console.error(`  ✗ ${msg}`);
    }
  }

  await runTest("test1Positive", () => test1Positive(instanceId));
  await runTest("test2OptOut", () => test2OptOut(instanceId));
  await runTest("test3Negative", () => test3Negative(instanceId));
  await runTest("test4Question", () => test4Question(instanceId));
  await runTest("test5Unknown", () => test5Unknown(instanceId));
  await runTest("test6LowConfidence", () => test6LowConfidence(instanceId));
  await runTest("test7EventCreation", () => test7EventCreation(instanceId));

  console.log(`\n${"─".repeat(62)}`);
  if (failed === 0) {
    console.log(`\n✓ Phase 7 harness complete — all ${passed} tests passed\n`);
  } else {
    console.log(`\n✗ Phase 7 harness: ${passed} passed, ${failed} failed`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    console.log();
    process.exitCode = 1;
  }

  await closeLockClient();
  await prisma.$disconnect();
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
