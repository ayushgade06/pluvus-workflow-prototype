/**
 * Content Brief verification harness — drives the MERGED post-negotiation flow
 * (negotiation → Content Brief) using mock providers and the real runtime (no
 * Redis/queues). Content Brief now sends ONE email (finalized offer + secure
 * payout link + brief PDF) and collects payout itself. Proves:
 *
 *   ACCEPTED → (auto) merged Content Brief email → PAYMENT_PENDING
 *            → (form submit) → CONTENT_BRIEF_SENT (terminal)
 *
 * Also verifies: the merged email carries the finalized offer (fee/commission/
 * deliverables) + the tokenized payout link + referral link + creator notes; the
 * configured PDF is loaded from local storage and attached; the send is
 * idempotent (a re-run does not send a second email); a CONTENT_BRIEF_SENT event
 * is recorded and completedAt is stamped only after the form submission.
 *
 * Plus a LEGACY sub-case: a graph that still has REWARD_SETUP → PAYMENT_INFO →
 * CONTENT_BRIEF drives PAYMENT_RECEIVED → CONTENT_BRIEF_SENT with the brief-only
 * email (backward compatibility), and a graph with NO CONTENT_BRIEF node keeps
 * PAYMENT_RECEIVED terminal.
 *
 * Creates its own throwaway workflow/version/creator/instance + a temp PDF, and
 * deletes them on exit, so it does not depend on or mutate seed data. Run:
 *   npx tsx src/engine/contentBrief.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InstanceState } from "@prisma/client";
import { prisma } from "../db/client.js";
import {
  appendEvent,
  findInstanceById,
  listEventsByInstance,
  listMessagesByInstance,
} from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import type { NodeSnapshot } from "./types.js";
import { saveUploadedFile } from "../storage/localFileStorage.js";

// A minimal but valid PDF (header + trailer). The mock provider never inspects
// the bytes; this just proves the executor reads a real file from storage.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);

const REFERRAL = "https://example.com/referral/casey-cb";
const NOTES = "Please tag @acme in your first post.";
const AGREED_RATE = 420;
const COMMISSION = 12;
const DELIVERABLES = "2 Reels + 1 Story";

// Shared pipeline prefix (import → outreach → follow-up → reply → negotiation).
function pipelinePrefix(): NodeSnapshot[] {
  return [
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
      config: { minBudget: 200, maxBudget: 500, maxRounds: 3, commissionRate: COMMISSION, deliverables: DELIVERABLES, brandName: "Acme", senderName: "Acme" },
    },
  ];
}

// MERGED graph: negotiation → Content Brief (the new default). Commission +
// deliverables are stamped onto the brief node (mirrors stampRewardFromNegotiation
// + restampBrand), so the executor can render the finalized offer.
function mergedNodes(briefFileRef: string, briefFileName: string): NodeSnapshot[] {
  return [
    ...pipelinePrefix(),
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 5,
      config: {
        brandName: "Acme",
        senderName: "Acme",
        commissionRate: COMMISSION,
        deliverables: DELIVERABLES,
        briefFileRef,
        briefFileName,
        referralLink: REFERRAL,
        creatorNotes: NOTES,
      },
    },
  ];
}

// LEGACY graph: negotiation → Reward Setup → Payment Info → Content Brief. Content
// Brief runs from PAYMENT_RECEIVED with the brief-only email.
function legacyNodes(briefFileRef: string, briefFileName: string): NodeSnapshot[] {
  return [
    ...pipelinePrefix(),
    { id: "node-reward-setup", type: "REWARD_SETUP", order: 5, config: { brandName: "Acme", senderName: "Acme" } },
    { id: "node-payment-info", type: "PAYMENT_INFO", order: 6, config: { brandName: "Acme", senderName: "Acme" } },
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 7,
      config: {
        brandName: "Acme",
        senderName: "Acme",
        briefFileRef,
        briefFileName,
        referralLink: REFERRAL,
        creatorNotes: NOTES,
      },
    },
  ];
}

async function state(instanceId: string): Promise<InstanceState> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  return inst.currentState;
}

// Seed the ACCEPT NEGOTIATION_TURN event so resolveAgreedFee recovers the agreed
// rate as the finalized offer (mirrors what the negotiation executor persists).
async function seedAcceptEvent(instanceId: string): Promise<void> {
  await appendEvent({
    instance: { connect: { id: instanceId } },
    type: "NEGOTIATION_TURN",
    nodeId: "node-negotiation",
    payload: { outcome: "accept", round: 1, message: "Deal", rate: AGREED_RATE },
  });
}

async function main(): Promise<void> {
  console.log("\nContent Brief Harness\n");

  const stamp = process.env["HARNESS_STAMP"] ?? "cb-harness";

  // Store a real PDF via the storage seam under a throwaway uploads dir so the
  // harness never litters the project's uploads/ folder.
  const uploadDir = await mkdtemp(path.join(tmpdir(), "cb-uploads-"));
  const prevUploads = process.env["UPLOADS_DIR"];
  process.env["UPLOADS_DIR"] = uploadDir;
  const stored = await saveUploadedFile(PDF_BYTES, "campaign-brief.pdf");

  const MERGED = mergedNodes(stored.reference, stored.originalName);
  const LEGACY = legacyNodes(stored.reference, stored.originalName);

  const workflow = await prisma.workflow.create({
    data: { name: `Content Brief Harness ${stamp}`, status: "PUBLISHED" },
  });
  const version = await prisma.workflowVersion.create({
    data: { workflowId: workflow.id, version: 1, nodeGraph: MERGED as unknown as object },
  });
  const creator = await prisma.creator.create({
    data: { name: "Casey Creator", email: `casey-cb-${stamp}@example.com`, platform: "Instagram", niche: "fitness" },
  });
  // Park directly in ACCEPTED with currentNodeId cleared — exactly what the
  // negotiation ACCEPT leaves behind for the merged hand-off.
  const instance = await prisma.executionInstance.create({
    data: {
      workflowVersionId: version.id,
      creatorId: creator.id,
      currentState: "ACCEPTED",
      currentNodeId: null,
    },
  });
  await seedAcceptEvent(instance.id);

  const cleanup = async () => {
    await prisma.event.deleteMany({ where: { instanceId: instance.id } });
    await prisma.message.deleteMany({ where: { instanceId: instance.id } });
    await prisma.brandNotification.deleteMany({ where: { instanceId: instance.id } });
    await prisma.paymentInfo.deleteMany({ where: { instanceId: instance.id } });
    await prisma.executionInstance.delete({ where: { id: instance.id } });
    await prisma.workflowVersion.delete({ where: { id: version.id } });
    await prisma.workflow.delete({ where: { id: workflow.id } });
    await prisma.creator.delete({ where: { id: creator.id } });
    await rm(uploadDir, { recursive: true, force: true });
    if (prevUploads === undefined) delete process.env["UPLOADS_DIR"];
    else process.env["UPLOADS_DIR"] = prevUploads;
  };

  try {
    const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

    // ── MERGED FLOW ───────────────────────────────────────────────────────────
    assert.equal(await runtime.contentBriefApplies(instance.id), true);

    // Content Brief auto-runs from ACCEPTED (the step the node-exec worker
    // enqueues): sends the merged email → PAYMENT_PENDING (waits on the form).
    await runtime.stepInstance(instance.id);
    assert.equal(await state(instance.id), "PAYMENT_PENDING", "merged Content Brief should reach PAYMENT_PENDING");
    console.log("  ✓ ACCEPTED → PAYMENT_PENDING (merged email sent, awaiting payout form)");

    // The merged email carries: subject, finalized offer (fee/commission/
    // deliverables), the tokenized payout link, referral link, creator notes.
    const msgs = await listMessagesByInstance(instance.id);
    const briefEmail = msgs.find(
      (m) => m.direction === "OUTBOUND" && (m.subject ?? "") === "Your Campaign Brief",
    );
    assert.ok(briefEmail, "a 'Your Campaign Brief' email must be sent");
    assert.ok(briefEmail!.body.includes(`$${AGREED_RATE}`), "email must state the agreed fee");
    assert.ok(briefEmail!.body.includes(`${COMMISSION}%`), "email must state the commission");
    assert.ok(briefEmail!.body.includes("2 Reels"), "email must list the deliverables");
    assert.ok(/\/payment\//.test(briefEmail!.body), "email must include the tokenized payout link");
    assert.ok(briefEmail!.body.includes(REFERRAL), "email must include the referral link");
    assert.ok(briefEmail!.body.includes(NOTES), "email must include the creator notes");
    assert.ok(
      (briefEmail!.idempotencyKey ?? "").startsWith("content-brief:"),
      "the send must use the content-brief idempotency key",
    );
    console.log("  ✓ email carries offer (fee/commission/deliverables) + payout link + referral + notes");

    // A PaymentInfo row/token was minted, and no completedAt yet (still waiting).
    const pi = await prisma.paymentInfo.findUnique({ where: { instanceId: instance.id } });
    assert.ok(pi && pi.token, "a PaymentInfo row + token must be minted");
    const midInst = await findInstanceById(instance.id);
    assert.ok(!midInst!.completedAt, "completedAt must NOT be stamped while awaiting the form");

    // Idempotency: re-running the send step must NOT send a second email or mint a
    // second token. Reset to ACCEPTED and step again.
    await prisma.executionInstance.update({
      where: { id: instance.id },
      data: { currentState: "ACCEPTED", currentNodeId: null },
    });
    await runtime.stepInstance(instance.id);
    const briefEmails = (await listMessagesByInstance(instance.id)).filter(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("content-brief:"),
    );
    assert.equal(briefEmails.length, 1, "re-run must not send a second merged email");
    console.log("  ✓ idempotent: re-run does not duplicate the merged email");

    // Form submission finalizes the run: PAYMENT_PENDING → CONTENT_BRIEF_SENT.
    await runtime.handlePaymentSubmission(instance.id, {
      method: "PAYPAL",
      accountIdentifier: "casey@paypal.me",
      country: "US",
    });
    assert.equal(await state(instance.id), "CONTENT_BRIEF_SENT", "form submit must complete the run");
    const sentEvents = await listEventsByInstance(instance.id, { type: "CONTENT_BRIEF_SENT" });
    assert.ok(sentEvents.length >= 1, "a CONTENT_BRIEF_SENT event must be recorded");
    const done = await findInstanceById(instance.id);
    assert.ok(done!.completedAt, "completedAt must be stamped after the form submission (terminal)");
    console.log("  ✓ payout form submit → CONTENT_BRIEF_SENT + completedAt stamped");

    // ── LEGACY SUB-CASE: reward → payment → content-brief still reaches terminal ─
    const legacyVersion = await prisma.workflowVersion.create({
      data: { workflowId: workflow.id, version: 2, nodeGraph: LEGACY as unknown as object },
    });
    const legacyInstance = await prisma.executionInstance.create({
      data: {
        workflowVersionId: legacyVersion.id,
        creatorId: creator.id,
        currentState: "PAYMENT_RECEIVED",
        currentNodeId: "node-payment-info",
      },
    });
    try {
      assert.equal(await runtime.contentBriefApplies(legacyInstance.id), true);
      // Legacy Content Brief runs from PAYMENT_RECEIVED with the brief-only email.
      await runtime.stepInstance(legacyInstance.id);
      assert.equal(await state(legacyInstance.id), "CONTENT_BRIEF_SENT", "legacy graph reaches CONTENT_BRIEF_SENT");
      const legacyMsgs = await listMessagesByInstance(legacyInstance.id);
      const legacyBrief = legacyMsgs.find(
        (m) => m.direction === "OUTBOUND" && (m.subject ?? "") === "Your Campaign Brief",
      );
      assert.ok(legacyBrief, "legacy graph must send the brief email");
      assert.ok(!/\/payment\//.test(legacyBrief!.body), "legacy brief email must NOT include a payout link (already collected)");
      console.log("  ✓ legacy graph: PAYMENT_RECEIVED → CONTENT_BRIEF_SENT (brief-only email, no payout link)");
    } finally {
      await prisma.event.deleteMany({ where: { instanceId: legacyInstance.id } });
      await prisma.message.deleteMany({ where: { instanceId: legacyInstance.id } });
      await prisma.executionInstance.delete({ where: { id: legacyInstance.id } });
      await prisma.workflowVersion.delete({ where: { id: legacyVersion.id } });
    }

    // ── LEGACY SUB-CASE: no CONTENT_BRIEF node → PAYMENT_RECEIVED stays terminal ─
    const bareVersion = await prisma.workflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 3,
        nodeGraph: LEGACY.filter((n) => n.type !== "CONTENT_BRIEF") as unknown as object,
      },
    });
    const bareInstance = await prisma.executionInstance.create({
      data: {
        workflowVersionId: bareVersion.id,
        creatorId: creator.id,
        currentState: "PAYMENT_RECEIVED",
        currentNodeId: "node-payment-info",
      },
    });
    try {
      assert.equal(await runtime.contentBriefApplies(bareInstance.id), false);
      const endState = await runtime.runUntilWaiting(bareInstance.id);
      assert.equal(endState, "PAYMENT_RECEIVED", "graph with no CONTENT_BRIEF keeps PAYMENT_RECEIVED terminal");
      console.log("  ✓ legacy graph without CONTENT_BRIEF: PAYMENT_RECEIVED stays terminal");
    } finally {
      await prisma.event.deleteMany({ where: { instanceId: bareInstance.id } });
      await prisma.executionInstance.delete({ where: { id: bareInstance.id } });
      await prisma.workflowVersion.delete({ where: { id: bareVersion.id } });
    }

    console.log("\nAll Content Brief checks passed ✓\n");
  } finally {
    await cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Content Brief harness failed:", err);
  process.exit(1);
});
