/**
 * Phase 8 negotiation harness — validates bounded negotiation transitions and
 * AI draft generation end-to-end.
 *
 * Acceptance criteria (6 scenarios):
 *   A. Creator accepts          → ACCEPTED
 *   B. Counter within range     → NEGOTIATING → email sent → NEGOTIATING
 *   C. Creator rejects          → REJECTED
 *   D. Unreasonable terms       → MANUAL_REVIEW (ESCALATE)
 *   E. Max rounds enforced      → MANUAL_REVIEW (no further counter)
 *   F. Draft generation         → AI copy in outbound messages
 *
 * Strategy: WorkflowRuntime + MockNegotiationProvider (configured per scenario).
 * No BullMQ workers run — engine calls are direct so the test is fast and
 * deterministic.
 *
 * Run with:
 *   npm run harness:phase8   (from server/)
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { WorkflowRuntime } from "../engine/runtime.js";
import {
  MockEmailProvider,
  MockAgentProvider,
  buildNegotiationRequest,
  mapNegotiationResponse,
} from "../engine/providers.js";
import { MockNegotiationProvider } from "../adapters/negotiation/MockNegotiationProvider.js";
import { MockClassificationProvider } from "../adapters/classification/MockClassificationProvider.js";
import type { ClassificationProvider } from "../adapters/classification/ClassificationProvider.js";
import type { NegotiationProvider } from "../adapters/negotiation/NegotiationProvider.js";
import type { IAgentProvider, IEmailProvider } from "../engine/providers.js";
import type {
  ClassifyResult,
  NegotiateResult,
  EmailDraft,
  PriorNegotiationContext,
} from "../engine/types.js";
import type { Creator } from "../db/schema.js";
import type { NegotiationTerm } from "../adapters/negotiation/types.js";
import {
  listInstancesByVersion,
  findInstanceById,
  listMessagesByInstance,
  listEventsByInstance,
  updateInstanceState,
} from "../db/index.js";
import { eq } from "drizzle-orm";
import { db, pool } from "../db/drizzle.js";
import { events as eventsTable, messages as messagesTable } from "../db/schema.js";
import { closeLockClient } from "../scheduler/lock.js";
import type { InstanceState } from "../db/schema.js";

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
// Harness agent provider — wires ClassificationProvider + NegotiationProvider
// ---------------------------------------------------------------------------

class HarnessAgentProvider implements IAgentProvider {
  constructor(
    private readonly classifier: ClassificationProvider,
    private readonly negotiator: NegotiationProvider,
  ) {}

  async classify(body: string): Promise<ClassifyResult> {
    const r = await this.classifier.classify({ message: body });
    return { intent: r.intent as ClassifyResult["intent"], confidence: r.confidence };
  }

  async negotiate(
    round: number,
    config: Record<string, unknown>,
    creatorReply = "",
    priorContext?: PriorNegotiationContext,
  ): Promise<NegotiateResult> {
    const resp = await this.negotiator.negotiate(
      buildNegotiationRequest(round, config, creatorReply, priorContext),
    );
    return mapNegotiationResponse(resp, round);
  }

  async draftEmail(
    purpose: "initial_outreach" | "follow_up" | "counter_offer" | "acceptance",
    creator: Creator,
    config: Record<string, unknown>,
    extra?: { round?: number; proposedTerms?: NegotiationTerm },
  ): Promise<EmailDraft | null> {
    return this.negotiator.draft({
      purpose,
      creatorName: creator.name,
      creatorPlatform: creator.platform ?? undefined,
      creatorNiche: creator.niche ?? undefined,
      senderName: typeof config["senderName"] === "string" ? config["senderName"] : undefined,
      round: extra?.round,
      proposedTerms: extra?.proposedTerms,
    });
  }
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function resetInstance(instanceId: string): Promise<void> {
  await db.delete(eventsTable).where(eq(eventsTable.instanceId, instanceId));
  await db.delete(messagesTable).where(eq(messagesTable.instanceId, instanceId));
  await updateInstanceState(instanceId, {
    currentState: "ENROLLED",
    currentNodeId: "node_import",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    completedAt: null,
  });
}

function makeRuntime(
  negotiator: NegotiationProvider,
  emailProv?: IEmailProvider,
): WorkflowRuntime {
  return new WorkflowRuntime(
    emailProv ?? new MockEmailProvider(),
    new HarnessAgentProvider(new MockClassificationProvider(), negotiator),
  );
}

async function driveToNegotiating(
  instanceId: string,
  runtime: WorkflowRuntime,
): Promise<void> {
  await resetInstance(instanceId);
  // import → outreach → follow-up wait → AWAITING_REPLY
  await runtime.runUntilWaiting(instanceId);

  // Inject positive reply → REPLY_RECEIVED
  await runtime.injectReply(instanceId, {
    subject: "Re: Collaboration",
    body: "Yes I am definitely interested!",
    externalMessageId: `harness-reply-${instanceId}-${Date.now()}`,
  });

  // Reply detection → NEGOTIATING
  await runtime.runUntilWaiting(instanceId);

  const inst = await findInstanceById(instanceId);
  if (inst?.currentState !== "NEGOTIATING") {
    fail(`Expected NEGOTIATING after reply detection, got ${inst?.currentState}`);
  }
}

async function getState(id: string): Promise<InstanceState> {
  const inst = await findInstanceById(id);
  if (!inst) fail(`Instance not found: ${id}`);
  return inst.currentState;
}

// ---------------------------------------------------------------------------
// Scenario A — Creator accepts → ACCEPTED
// ---------------------------------------------------------------------------

async function scenarioA(instanceId: string): Promise<void> {
  section("Scenario A: Creator accepts → ACCEPTED");

  const negotiator = new MockNegotiationProvider({ forceAction: "ACCEPT" });
  const runtime = makeRuntime(negotiator);
  await driveToNegotiating(instanceId, runtime);

  const messagesBefore = (await listMessagesByInstance(instanceId)).length;
  await runtime.stepInstance(instanceId);

  const state = await getState(instanceId);
  const messages = await listMessagesByInstance(instanceId);
  const outbound = messages.filter((m) => m.direction === "OUTBOUND");
  const events = await listEventsByInstance(instanceId);
  const negEvent = events.find((e) => e.type === "NEGOTIATION_TURN");

  log(`final state:      ${state}`);
  log(`new outbound msgs: ${messages.length - messagesBefore}`);
  log(`negotiation event: ${negEvent ? JSON.stringify(negEvent.payload) : "none"}`);

  if (state !== "ACCEPTED") fail(`Expected ACCEPTED, got ${state}`);
  if (outbound.length === 0) fail("Expected at least one outbound message (acceptance email)");
  if (!negEvent) fail("Expected NEGOTIATION_TURN event");
  pass("ACCEPT → ACCEPTED + acceptance email sent + event persisted");
}

// ---------------------------------------------------------------------------
// Scenario B — Counter within range → stays NEGOTIATING + email sent
// ---------------------------------------------------------------------------

async function scenarioB(instanceId: string): Promise<void> {
  section("Scenario B: Counter within range → NEGOTIATING + email sent");

  const negotiator = new MockNegotiationProvider({ counterUntilRound: 1 });
  const runtime = makeRuntime(negotiator);
  await driveToNegotiating(instanceId, runtime);

  const before = await findInstanceById(instanceId);
  const roundBefore = before!.negotiationRound;
  const msgsBefore = (await listMessagesByInstance(instanceId)).length;

  // First step: COUNTER
  await runtime.stepInstance(instanceId);

  const after = await findInstanceById(instanceId);
  const messages = await listMessagesByInstance(instanceId);
  const newOutbound = messages.filter(
    (m) => m.direction === "OUTBOUND" && messages.indexOf(m) >= msgsBefore,
  );

  log(`negotiationRound: ${roundBefore} → ${after!.negotiationRound}`);
  log(`state:            ${after!.currentState}`);
  log(`new outbound msgs: ${messages.length - msgsBefore}`);

  // After sending a counter-offer the executor awaits the creator's reply, so
  // the instance returns to AWAITING_REPLY (not NEGOTIATING). The negotiation
  // loop resumes only when the next inbound reply arrives.
  if (after!.currentState !== "AWAITING_REPLY") fail(`Expected AWAITING_REPLY, got ${after!.currentState}`);
  if (after!.negotiationRound <= roundBefore) fail("negotiationRound should have incremented");
  if (messages.length <= msgsBefore) fail("Expected a counter-offer outbound email");
  pass("COUNTER → AWAITING_REPLY + negotiationRound incremented + counter-offer email sent");

  // Verify the loop terminates: the creator replies again, we re-enter
  // NEGOTIATING, and this round accepts. This also exercises multi-round history
  // threading (FIX-1): round 2's request carries round 1's counter turn.
  await runtime.injectReply(instanceId, {
    subject: "Re: Collaboration",
    body: "Yes, that works for me — let's do it!",
    externalMessageId: `harness-b-reply2-${instanceId}-${Date.now()}`,
  });
  await runtime.runUntilWaiting(instanceId); // REPLY_RECEIVED → classify → NEGOTIATING

  const acceptNegotiator = new MockNegotiationProvider({ forceAction: "ACCEPT" });
  const runtime2 = makeRuntime(acceptNegotiator);
  await runtime2.stepInstance(instanceId); // NEGOTIATING → ACCEPTED

  const finalState = await getState(instanceId);
  log(`after second round: ${finalState}`);
  if (finalState !== "ACCEPTED") fail(`Expected ACCEPTED after counter+reply+accept, got ${finalState}`);
  pass("Second negotiation round → ACCEPTED");
}

// ---------------------------------------------------------------------------
// Scenario C — Creator rejects → REJECTED
// ---------------------------------------------------------------------------

async function scenarioC(instanceId: string): Promise<void> {
  section("Scenario C: Creator rejects → REJECTED");

  const negotiator = new MockNegotiationProvider({ forceAction: "REJECT" });
  const runtime = makeRuntime(negotiator);
  await driveToNegotiating(instanceId, runtime);

  await runtime.stepInstance(instanceId);
  const state = await getState(instanceId);
  const events = await listEventsByInstance(instanceId);
  const negEvent = events.find((e) => e.type === "NEGOTIATION_TURN");

  log(`final state: ${state}`);
  log(`event:       ${JSON.stringify(negEvent?.payload)}`);

  if (state !== "REJECTED") fail(`Expected REJECTED, got ${state}`);
  pass("REJECT → REJECTED + NEGOTIATION_TURN event");
}

// ---------------------------------------------------------------------------
// Scenario D — Unreasonable terms → MANUAL_REVIEW (ESCALATE)
// ---------------------------------------------------------------------------

async function scenarioD(instanceId: string): Promise<void> {
  section("Scenario D: Unreasonable terms → MANUAL_REVIEW (ESCALATE)");

  const negotiator = new MockNegotiationProvider({ forceAction: "ESCALATE" });
  const runtime = makeRuntime(negotiator);
  await driveToNegotiating(instanceId, runtime);

  await runtime.stepInstance(instanceId);
  const state = await getState(instanceId);
  const events = await listEventsByInstance(instanceId);
  const negEvent = events.find((e) => e.type === "NEGOTIATION_TURN");

  log(`final state: ${state}`);
  log(`event:       ${JSON.stringify(negEvent?.payload)}`);

  if (state !== "MANUAL_REVIEW") fail(`Expected MANUAL_REVIEW, got ${state}`);
  pass("ESCALATE → MANUAL_REVIEW + NEGOTIATION_TURN event");
}

// ---------------------------------------------------------------------------
// Scenario E — Max rounds enforced → REJECTED + courteous close email (#15)
// ---------------------------------------------------------------------------
// V1 (founder #15): a negotiation that fails to reach agreement within the round
// budget auto-CLOSES rather than paging a human — a brief close email to the
// creator, then REJECTED (terminal). No counter-offer is sent (the deal is over),
// but ONE outbound close email IS sent. Previously this dead-ended in
// MANUAL_REVIEW with no email.

async function scenarioE(instanceId: string): Promise<void> {
  section("Scenario E: Max rounds enforced → REJECTED + close email");

  // counterUntilRound=99 would counter forever — but the executor hard-stops at
  // maxRounds before calling the agent. We pre-set negotiationRound to maxRounds
  // to trigger the guard.
  const negotiator = new MockNegotiationProvider({ counterUntilRound: 99 });
  const runtime = makeRuntime(negotiator);
  await driveToNegotiating(instanceId, runtime);

  // Manually set negotiationRound to maxRounds (5, from seed config) so the
  // next stepInstance hits the hard stop immediately.
  await updateInstanceState(instanceId, {
    currentState: "NEGOTIATING",
    currentNodeId: "node_negotiation",
    negotiationRound: 5, // equals maxRounds
  });

  const msgsBefore = (await listMessagesByInstance(instanceId)).length;
  await runtime.stepInstance(instanceId);

  const state = await getState(instanceId);
  const msgsAfter = (await listMessagesByInstance(instanceId)).length;
  const events = await listEventsByInstance(instanceId);
  const negEvent = events.find(
    (e) => e.type === "NEGOTIATION_TURN" &&
      (e.payload as Record<string, unknown>)?.["reason"]?.toString().includes("max_rounds"),
  );

  log(`final state:        ${state}`);
  log(`new outbound msgs:  ${msgsAfter - msgsBefore} (should be 1 — close email)`);
  log(`max-rounds event:   ${negEvent ? "found" : "not found"}`);

  if (state !== "REJECTED") fail(`Expected REJECTED at max rounds, got ${state}`);
  // Exactly the courteous close email — NOT a counter-offer. One new outbound msg.
  if (msgsAfter - msgsBefore !== 1) {
    fail(`Expected exactly 1 close email at max rounds, got ${msgsAfter - msgsBefore}`);
  }
  if (!negEvent) fail("Expected NEGOTIATION_TURN event with a max_rounds reason");
  const outcome = (negEvent!.payload as Record<string, unknown>)?.["outcome"];
  if (outcome !== "REJECT") fail(`Expected outcome REJECT, got ${String(outcome)}`);
  pass("Max rounds hit → REJECTED, one close email sent, REJECT event recorded");
}

// ---------------------------------------------------------------------------
// Scenario F — Draft generation: AI-generated copy in outbound messages
// ---------------------------------------------------------------------------

async function scenarioF(instanceId: string): Promise<void> {
  section("Scenario F: Draft generation via NegotiationProvider.draft()");

  const negotiator = new MockNegotiationProvider({ forceAction: "ACCEPT" });
  const runtime = makeRuntime(negotiator);

  await resetInstance(instanceId);
  const msgsBefore = (await listMessagesByInstance(instanceId)).length;

  // Drive through outreach — this calls agent.draftEmail("initial_outreach").
  await runtime.runUntilWaiting(instanceId);

  const messages = await listMessagesByInstance(instanceId);
  const outbound = messages.filter((m) => m.direction === "OUTBOUND" && messages.indexOf(m) >= msgsBefore);

  log(`outbound messages: ${outbound.length}`);

  if (outbound.length === 0) fail("Expected at least one outbound message from initial outreach");

  const outreachMsg = outbound[0]!;
  log(`outreach subject: "${outreachMsg.subject}"`);
  log(`outreach body preview: "${outreachMsg.body?.slice(0, 80)}..."`);

  // Verify the draft was generated (not empty, has greeting).
  if (!outreachMsg.body?.toLowerCase().includes("hi ")) {
    fail(`Outreach body doesn't look like a generated email: ${outreachMsg.body?.slice(0, 100)}`);
  }
  pass("Initial outreach copy generated via NegotiationProvider.draft()");

  // Trigger one follow-up to verify follow-up draft generation.
  await runtime.stepInstance(instanceId); // AWAITING_REPLY → FOLLOWED_UP
  await runtime.stepInstance(instanceId); // FOLLOWED_UP → AWAITING_REPLY

  const messages2 = await listMessagesByInstance(instanceId);
  const followUpMsg = messages2.filter((m) => m.direction === "OUTBOUND").at(-1);

  if (!followUpMsg) fail("Expected follow-up outbound message");
  log(`follow-up subject: "${followUpMsg.subject}"`);
  log(`follow-up body preview: "${followUpMsg.body?.slice(0, 80)}..."`);

  if (!followUpMsg.body?.toLowerCase().includes("follow")) {
    fail(`Follow-up body doesn't look like a follow-up: ${followUpMsg.body?.slice(0, 100)}`);
  }
  pass("Follow-up copy generated via NegotiationProvider.draft()");

  // Drive to negotiation and verify counter-offer draft.
  await runtime.injectReply(instanceId, {
    subject: "Re: Collaboration",
    body: "Yes, interested!",
    externalMessageId: `harness-f-reply-${instanceId}-${Date.now()}`,
  });
  await runtime.runUntilWaiting(instanceId); // → NEGOTIATING

  const acceptNegotiator = new MockNegotiationProvider({ forceAction: "ACCEPT" });
  const runtime2 = makeRuntime(acceptNegotiator);

  const msgsBefore2 = (await listMessagesByInstance(instanceId)).length;
  await runtime2.stepInstance(instanceId); // NEGOTIATING → ACCEPTED

  const messages3 = await listMessagesByInstance(instanceId);
  const newOutboundMsgs = messages3.slice(msgsBefore2).filter((m) => m.direction === "OUTBOUND");

  if (newOutboundMsgs.length === 0) fail("Expected acceptance email");
  const acc = newOutboundMsgs[0]!;
  log(`acceptance subject: "${acc.subject}"`);
  log(`acceptance body preview: "${acc.body?.slice(0, 80)}..."`);
  pass("Acceptance email generated via NegotiationProvider.draft()");
}

// ---------------------------------------------------------------------------
// Scenario G — Output guard blocks a draft that leaks the ceiling (FIX-4)
// ---------------------------------------------------------------------------

// A deliberately misbehaving provider: it ACCEPTs but its draft copy leaks the
// internal ceiling ($2000) — exactly what a prompt slip / injection could do.
class LeakingNegotiationProvider implements NegotiationProvider {
  async negotiate(): Promise<import("../adapters/negotiation/types.js").NegotiationResponse> {
    return {
      action: "ACCEPT",
      proposedTerms: { rate: 500 },
      responseDraft: "We're delighted to confirm.",
      reasoning: "Terms acceptable",
    };
  }
  async draft(): Promise<import("../adapters/negotiation/types.js").DraftResponse> {
    // Leaks the ceiling rate (2000) that must never reach the creator.
    return {
      subject: "You're in!",
      body: "Hi there — great news, we can actually go all the way up to $2,000 for this. Best, Pluvus",
    };
  }
}

async function scenarioG(instanceId: string): Promise<void> {
  section("Scenario G: Output guard blocks ceiling-leaking draft → MANUAL_REVIEW");

  const runtime = makeRuntime(new LeakingNegotiationProvider());
  await driveToNegotiating(instanceId, runtime);

  const msgsBefore = (await listMessagesByInstance(instanceId)).length;
  await runtime.stepInstance(instanceId);

  const state = await getState(instanceId);
  const msgsAfter = (await listMessagesByInstance(instanceId)).length;
  const events = await listEventsByInstance(instanceId);
  const blockEvent = events.find(
    (e) =>
      e.type === "NEGOTIATION_TURN" &&
      (e.payload as Record<string, unknown>)?.["reason"] === "output_guard_blocked",
  );

  log(`final state:       ${state}`);
  log(`new outbound msgs: ${msgsAfter - msgsBefore} (should be 0 — send blocked)`);
  log(`guard event:       ${blockEvent ? JSON.stringify(blockEvent.payload) : "none"}`);

  if (state !== "MANUAL_REVIEW") fail(`Expected MANUAL_REVIEW after guard block, got ${state}`);
  if (msgsAfter > msgsBefore) fail("Leaking draft must NOT be sent (no new outbound message)");
  if (!blockEvent) fail("Expected NEGOTIATION_TURN event with output_guard_blocked reason");
  const leaks = (blockEvent.payload as Record<string, unknown>)?.["leaks"];
  if (!Array.isArray(leaks) || !leaks.some((l) => String(l).startsWith("ceiling"))) {
    fail(`Expected a ceiling leak recorded, got ${JSON.stringify(leaks)}`);
  }
  pass("Ceiling-leaking draft blocked → MANUAL_REVIEW, no email sent, leak recorded");
}

// ---------------------------------------------------------------------------
// Scenario H — Outbound send idempotency: a retry must not double-send (FIX-11)
// ---------------------------------------------------------------------------

// Wraps MockEmailProvider and counts send() calls so the test can prove a retry
// after a "crash" does not send a second email to the creator.
class CountingEmailProvider implements IEmailProvider {
  public sendCount = 0;
  private readonly inner = new MockEmailProvider();

  draft(creator: Creator, template: string, config: Record<string, unknown>) {
    return this.inner.draft(creator, template, config);
  }
  async send(draft: EmailDraft, creator: Creator) {
    this.sendCount++;
    return this.inner.send(draft, creator);
  }
}

async function scenarioH(instanceId: string): Promise<void> {
  section("Scenario H: Outbound send idempotency — retry does not double-send (FIX-11)");

  const email = new CountingEmailProvider();
  const negotiator = new MockNegotiationProvider({ forceAction: "ACCEPT" });
  const runtime = makeRuntime(negotiator, email);
  await driveToNegotiating(instanceId, runtime);

  // Reset the counter so we measure ONLY the negotiation send (driveToNegotiating
  // already sent the initial outreach).
  email.sendCount = 0;
  const outboundBefore = (await listMessagesByInstance(instanceId)).filter(
    (m) => m.direction === "OUTBOUND",
  ).length;

  // First negotiation step → ACCEPT → one email sent + one reserved/finalized row.
  await runtime.stepInstance(instanceId);
  const sendsAfterFirst = email.sendCount;
  const outboundAfterFirst = (await listMessagesByInstance(instanceId)).filter(
    (m) => m.direction === "OUTBOUND",
  ).length;

  log(`sends during first step:        ${sendsAfterFirst} (expect 1)`);
  log(`new outbound msgs after first:  ${outboundAfterFirst - outboundBefore} (expect 1)`);
  if (sendsAfterFirst !== 1) fail(`Expected exactly 1 send, got ${sendsAfterFirst}`);

  // Simulate a crash-and-retry: the email + reserved message row are committed,
  // but the state transition is "lost". We force the instance back to
  // NEGOTIATING at the SAME round and re-run the step — exactly what a BullMQ
  // retry would do. The idempotency key must short-circuit the send.
  await updateInstanceState(instanceId, {
    currentState: "NEGOTIATING",
    currentNodeId: "node_negotiation",
    completedAt: null,
  });

  await runtime.stepInstance(instanceId);

  const sendsAfterRetry = email.sendCount;
  const newOutboundAfterRetry =
    (await listMessagesByInstance(instanceId)).filter((m) => m.direction === "OUTBOUND").length -
    outboundBefore;

  log(`sends after retry:         ${sendsAfterRetry} (expect still 1)`);
  log(`new outbound msgs after retry: ${newOutboundAfterRetry} (expect still 1)`);

  if (sendsAfterRetry !== 1) fail(`Retry double-sent: expected 1 send total, got ${sendsAfterRetry}`);
  if (newOutboundAfterRetry !== 1) fail(`Retry duplicated outbound message: got ${newOutboundAfterRetry}`);
  pass("Retry did not double-send (1 send, 1 outbound message) — idempotency holds");
}

// ---------------------------------------------------------------------------
// Regression check: Phase 7 harness still runs cleanly
// ---------------------------------------------------------------------------

async function regressionPhase7(instanceId: string): Promise<void> {
  section("Regression: Phase 7 classification still works");

  // Use MockAgentProvider directly (old interface) to verify no regressions.
  const runtime = new WorkflowRuntime(
    new MockEmailProvider(),
    new MockAgentProvider({ replyIntent: "POSITIVE", negotiationOutcome: "accept" }),
  );

  await resetInstance(instanceId);
  await runtime.runUntilWaiting(instanceId);

  await runtime.injectReply(instanceId, {
    subject: "Re: Collab",
    body: "Yes!",
    externalMessageId: `harness-reg-${instanceId}-${Date.now()}`,
  });

  await runtime.runUntilWaiting(instanceId); // → NEGOTIATING

  const stateAfterClassify = await getState(instanceId);
  if (stateAfterClassify !== "NEGOTIATING") {
    fail(`Phase 7 regression: expected NEGOTIATING, got ${stateAfterClassify}`);
  }
  pass("Phase 7 classification path still works (MockAgentProvider)");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const instances = await listInstancesByVersion("wfv_seed_v1");
  if (instances.length < 7) {
    console.error(
      `Need at least 7 seeded instances, found ${instances.length}. Run: npm run db:seed`,
    );
    process.exit(1);
  }

  console.log("\nPluvus Workflow — Phase 8 Negotiation Harness\n");

  const negMode = process.env["NEGOTIATION_PROVIDER"] ?? "mock";
  log(`negotiation provider: ${negMode}`);
  if (negMode === "langgraph") {
    log(`agent service URL: ${process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000"}`);
  }
  console.log();

  // Assign one instance per scenario to keep them isolated.
  const [iA, iB, iC, iD, iE, iF, iReg] = instances as [
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
    (typeof instances)[number],
  ];
  // Scenarios G/H reuse the spare 8th instance when available, else an earlier
  // one. Every scenario fully resets its instance and they run sequentially, so
  // reuse is safe and isolated.
  const iG = instances[7] ?? iA;
  const iH = instances[7] ?? iB;

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  async function run(name: string, fn: () => Promise<void>): Promise<void> {
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

  await run("scenarioA", () => scenarioA(iA.id));
  await run("scenarioB", () => scenarioB(iB.id));
  await run("scenarioC", () => scenarioC(iC.id));
  await run("scenarioD", () => scenarioD(iD.id));
  await run("scenarioE", () => scenarioE(iE.id));
  await run("scenarioF", () => scenarioF(iF.id));
  await run("scenarioG", () => scenarioG(iG.id));
  await run("scenarioH", () => scenarioH(iH.id));
  await run("regressionPhase7", () => regressionPhase7(iReg.id));

  console.log(`\n${"─".repeat(62)}`);
  if (failed === 0) {
    console.log(`\n✓ Phase 8 harness complete — all ${passed} tests passed\n`);
  } else {
    console.log(`\n✗ Phase 8 harness: ${passed} passed, ${failed} failed`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    console.log();
    process.exitCode = 1;
  }

  await closeLockClient();
  await pool.end();
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
