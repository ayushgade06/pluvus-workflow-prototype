/**
 * Reward Setup verification harness — drives a complete journey through a
 * workflow that ends in a REWARD_SETUP node, using mock providers and the real
 * runtime (no Redis/queues). Proves:
 *
 *   NEGOTIATING → ACCEPTED → (auto) REWARD_SETUP email → REWARD_PENDING
 *     → creator replies "I Agree" → REWARD_CONFIRMED
 *
 * Also verifies a non-confirming reply keeps the instance in REWARD_PENDING.
 *
 * Creates its own throwaway workflow/version/creator/instance and deletes them
 * on exit, so it does not depend on or mutate seed data. Run:
 *   npx tsx src/engine/rewardSetup.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import type { InstanceState } from "@prisma/client";
import { prisma } from "../db/client.js";
import {
  findInstanceById,
  listEventsByInstance,
  listMessagesByInstance,
} from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import type { NodeSnapshot } from "./types.js";
import { stampRewardFromNegotiation } from "../routes/workflows.js";

const REWARD_NODES: NodeSnapshot[] = [
  { id: "node-import", type: "IMPORT_CREATOR_LIST", order: 0, config: {} },
  {
    id: "node-outreach",
    type: "INITIAL_OUTREACH",
    order: 1,
    config: { subjectTemplate: "Partner with {{brandName}}", bodyTemplate: "Hi {{creatorName}}", brandName: "Acme", senderName: "Acme" },
  },
  {
    id: "node-followup",
    type: "FOLLOW_UP",
    order: 2,
    config: { intervals: [3], intervalUnit: "days", maxCount: 1, bodyTemplate: "Following up", stopOnReply: true },
  },
  { id: "node-reply-detection", type: "REPLY_DETECTION", order: 3, config: { lowConfidenceThreshold: 0.5 } },
  {
    id: "node-negotiation",
    type: "NEGOTIATION",
    order: 4,
    // The brand set an 18% commission on the negotiation node — a non-default,
    // non-10% value to prove commission is variable, not frozen.
    config: { minBudget: 200, maxBudget: 500, maxRounds: 3, commissionRate: 18, brandName: "Acme", senderName: "Acme", deliverables: "2 Instagram Reels + 3 Instagram Stories", timeline: "Content live by Aug 1, 2026" },
  },
  {
    id: "node-reward-setup",
    type: "REWARD_SETUP",
    order: 5,
    // Intentionally NO commissionRate here — it must come from the negotiation
    // node via the save-time stamp, not a hardcoded copy. Deliverables/timeline
    // are stamped from the campaign (mirrored here).
    config: { deliverables: "2 Instagram Reels + 3 Instagram Stories", timeline: "Content live by Aug 1, 2026", brandName: "Acme", senderName: "Acme" },
  },
];

async function state(instanceId: string): Promise<InstanceState> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  return inst.currentState;
}

async function main(): Promise<void> {
  console.log("\nReward Setup Harness\n");

  // ── Setup: throwaway workflow + version + creator + instance ──────────────
  const stamp = process.env["HARNESS_STAMP"] ?? "rs-harness";
  const workflow = await prisma.workflow.create({
    data: { name: `Reward Setup Harness ${stamp}`, status: "PUBLISHED" },
  });
  // Apply the same save/publish stamp the workflows route runs, so the frozen
  // version carries the negotiation commission on the Reward Setup node.
  const publishedGraph = stampRewardFromNegotiation(REWARD_NODES);
  const version = await prisma.workflowVersion.create({
    data: { workflowId: workflow.id, version: 1, nodeGraph: publishedGraph as unknown as object },
  });
  const creator = await prisma.creator.create({
    data: { name: "Casey Creator", email: `casey-${stamp}@example.com`, platform: "Instagram", niche: "fitness" },
  });
  const instance = await prisma.executionInstance.create({
    data: { workflowVersionId: version.id, creatorId: creator.id, currentState: "ENROLLED", currentNodeId: "node-import" },
  });

  const cleanup = async () => {
    await prisma.event.deleteMany({ where: { instanceId: instance.id } });
    await prisma.message.deleteMany({ where: { instanceId: instance.id } });
    await prisma.brandNotification.deleteMany({ where: { instanceId: instance.id } });
    await prisma.executionInstance.delete({ where: { id: instance.id } });
    await prisma.workflowVersion.delete({ where: { id: version.id } });
    await prisma.workflow.delete({ where: { id: workflow.id } });
    await prisma.creator.delete({ where: { id: creator.id } });
  };

  try {
    // Mock: reply POSITIVE, negotiation counters once then accepts at round 1.
    const runtime = new WorkflowRuntime(
      new MockEmailProvider(),
      new MockAgentProvider({
        replyIntent: "POSITIVE",
        negotiationOutcome: "accept",
        negotiationCounterUntilRound: 1,
      }),
    );

    // Drive to AWAITING_REPLY (import → outreach → follow-up entry).
    await runtime.runUntilWaiting(instance.id);
    assert.equal(await state(instance.id), "AWAITING_REPLY");

    // Creator replies positively → REPLY_RECEIVED → (reply detection) NEGOTIATING.
    await runtime.injectReply(instance.id, {
      subject: "Re: Partner",
      body: "Yes I'm interested! What are the terms?",
    });
    await runtime.runUntilWaiting(instance.id);
    assert.equal(await state(instance.id), "NEGOTIATING");

    // Negotiation: round 0 counter → AWAITING_REPLY.
    await runtime.stepInstance(instance.id);
    assert.equal(await state(instance.id), "AWAITING_REPLY");

    // Creator names a rate inside the band → back to NEGOTIATING → ACCEPTED.
    await runtime.injectReply(instance.id, {
      subject: "Re: Partner",
      body: "That works, let's do $450.",
    });
    await runtime.runUntilWaiting(instance.id);
    assert.equal(await state(instance.id), "NEGOTIATING");
    await runtime.stepInstance(instance.id);
    assert.equal(await state(instance.id), "ACCEPTED", "negotiation should accept at the agreed rate");
    console.log("  ✓ negotiation reached ACCEPTED");

    // Reward Setup auto-runs from ACCEPTED (here we invoke the step the worker
    // would enqueue): sends the confirmation email → REWARD_PENDING.
    assert.equal(await runtime.rewardSetupApplies(instance.id), true);
    await runtime.stepInstance(instance.id);
    assert.equal(await state(instance.id), "REWARD_PENDING", "Reward Setup should enter REWARD_PENDING");
    console.log("  ✓ ACCEPTED → REWARD_PENDING (confirmation email sent)");

    // The confirmation email was sent — assert an outbound message with the
    // "Campaign Agreement Confirmation" subject exists.
    const msgs = await listMessagesByInstance(instance.id);
    const confirmationEmail = msgs.find(
      (m) => m.direction === "OUTBOUND" && (m.subject ?? "").includes("Campaign Agreement Confirmation"),
    );
    assert.ok(confirmationEmail, "a Campaign Agreement Confirmation email must be sent");
    assert.ok(
      confirmationEmail!.body.includes('"I Agree"'),
      "confirmation email should ask the creator to reply 'I Agree'",
    );
    // Deliverables must render as SEPARATE bullets (split on '+'), not one line.
    assert.ok(
      confirmationEmail!.body.includes("    - 2 Instagram Reels") &&
        confirmationEmail!.body.includes("    - 3 Instagram Stories"),
      `confirmation email should split deliverables into separate bullets (got: ${confirmationEmail!.body})`,
    );
    assert.ok(
      !confirmationEmail!.body.includes("2 Instagram Reels + 3 Instagram Stories"),
      "deliverables must not appear as a single '+'-joined line",
    );
    // Timeline line present.
    assert.ok(
      confirmationEmail!.body.includes("Timeline: Content live by Aug 1, 2026"),
      "confirmation email should include the timeline line",
    );
    // Commission must reflect the brand's 18% from the negotiation node (via the
    // save-time stamp), NOT a hardcoded 10% — proving commission is variable.
    assert.ok(
      confirmationEmail!.body.includes("Commission: 18%"),
      `confirmation email should show the brand's 18% commission (got: ${confirmationEmail!.body})`,
    );

    // Exactly ONE post-acceptance email: the negotiation's onboarding/acceptance
    // email must be SUPPRESSED when a Reward Setup node exists. Assert no outbound
    // message came from the negotiation acceptance path.
    const acceptanceEmails = msgs.filter(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("negotiation:acceptance:"),
    );
    assert.equal(
      acceptanceEmails.length,
      0,
      "negotiation acceptance email must be suppressed when Reward Setup exists (only ONE confirmation email)",
    );
    console.log("  ✓ single confirmation email: variable 18% commission, split deliverables, timeline, I Agree");
    console.log("  ✓ negotiation acceptance/onboarding email suppressed (no duplicate)");

    // An agreement reply confirms → REWARD_CONFIRMED (terminal). The deterministic
    // matcher catches "I Agree" without relying on the classifier. (The
    // non-confirming/question path is covered by rewardReply.test.ts, which can
    // stub distinct classifier intents — the fixed-POSITIVE mock used to drive
    // negotiation here would confirm any reply, so it can't express that case.)
    await runtime.handleRewardReply(instance.id, {
      subject: "Re: Campaign Agreement Confirmation",
      body: "I Agree!",
    });
    assert.equal(await state(instance.id), "REWARD_CONFIRMED", "'I Agree' must confirm");
    console.log("  ✓ 'I Agree' → REWARD_CONFIRMED");

    // Confirmed is terminal: a REWARD_CONFIRMED event was written.
    const events = await listEventsByInstance(instance.id, { type: "REWARD_CONFIRMED" });
    assert.ok(events.length >= 1, "a REWARD_CONFIRMED event must be recorded");

    // ── Non-confirming reply keeps the instance in REWARD_PENDING ────────────
    // Fresh instance parked directly in REWARD_PENDING, driven by a QUESTION-fixed
    // agent so the classifier fallback (non-POSITIVE) does NOT confirm.
    const creator2 = await prisma.creator.create({
      data: { name: "Dana Creator", email: `dana-${stamp}@example.com`, platform: "Instagram", niche: "beauty" },
    });
    const pending = await prisma.executionInstance.create({
      data: {
        workflowVersionId: version.id,
        creatorId: creator2.id,
        currentState: "REWARD_PENDING",
        currentNodeId: "node-reward-setup",
      },
    });
    try {
      const questionRuntime = new WorkflowRuntime(
        new MockEmailProvider(),
        new MockAgentProvider({ replyIntent: "QUESTION" }),
      );
      await questionRuntime.handleRewardReply(pending.id, {
        subject: "Re: Campaign Agreement Confirmation",
        body: "One thing — can you clarify the posting schedule before I confirm?",
      });
      assert.equal(
        await state(pending.id),
        "REWARD_PENDING",
        "a non-agreement reply must keep the instance in REWARD_PENDING",
      );
      console.log("  ✓ non-agreement reply keeps instance in REWARD_PENDING");
    } finally {
      await prisma.event.deleteMany({ where: { instanceId: pending.id } });
      await prisma.message.deleteMany({ where: { instanceId: pending.id } });
      await prisma.executionInstance.delete({ where: { id: pending.id } });
      await prisma.creator.delete({ where: { id: creator2.id } });
    }

    console.log("\nAll Reward Setup checks passed ✓\n");
  } finally {
    await cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Reward Setup harness failed:", err);
  process.exit(1);
});
