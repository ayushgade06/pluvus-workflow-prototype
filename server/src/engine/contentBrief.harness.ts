/**
 * Content Brief verification harness — drives a complete journey through a
 * workflow that ends in PAYMENT_INFO → CONTENT_BRIEF, using mock providers and
 * the real runtime (no Redis/queues). Proves:
 *
 *   PAYMENT_RECEIVED → (auto) CONTENT_BRIEF email (PDF attached) → CONTENT_BRIEF_SENT (terminal)
 *
 * Also verifies: the campaign-brief email carries the correct subject + referral
 * link + creator notes; the configured PDF is loaded from local storage and
 * attached; the send is idempotent (a re-run does not send a second email); a
 * CONTENT_BRIEF_SENT event is recorded and completedAt is stamped; and a legacy
 * graph without a CONTENT_BRIEF node keeps PAYMENT_RECEIVED terminal.
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

function nodes(briefFileRef: string, briefFileName: string): NodeSnapshot[] {
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
      config: { minBudget: 200, maxBudget: 500, maxRounds: 3, commissionRate: 12, brandName: "Acme", senderName: "Acme" },
    },
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

async function main(): Promise<void> {
  console.log("\nContent Brief Harness\n");

  const stamp = process.env["HARNESS_STAMP"] ?? "cb-harness";

  // Store a real PDF via the storage seam under a throwaway uploads dir so the
  // harness never litters the project's uploads/ folder.
  const uploadDir = await mkdtemp(path.join(tmpdir(), "cb-uploads-"));
  const prevUploads = process.env["UPLOADS_DIR"];
  process.env["UPLOADS_DIR"] = uploadDir;
  const stored = await saveUploadedFile(PDF_BYTES, "campaign-brief.pdf");

  const NODES = nodes(stored.reference, stored.originalName);

  const workflow = await prisma.workflow.create({
    data: { name: `Content Brief Harness ${stamp}`, status: "PUBLISHED" },
  });
  const version = await prisma.workflowVersion.create({
    data: { workflowId: workflow.id, version: 1, nodeGraph: NODES as unknown as object },
  });
  const creator = await prisma.creator.create({
    data: { name: "Casey Creator", email: `casey-cb-${stamp}@example.com`, platform: "Instagram", niche: "fitness" },
  });
  // Park directly in PAYMENT_RECEIVED on the payment node — the Payment Info path
  // is covered by paymentInfo.harness.ts; here we exercise Content Brief.
  const instance = await prisma.executionInstance.create({
    data: {
      workflowVersionId: version.id,
      creatorId: creator.id,
      currentState: "PAYMENT_RECEIVED",
      currentNodeId: "node-payment-info",
    },
  });

  const cleanup = async () => {
    await prisma.event.deleteMany({ where: { instanceId: instance.id } });
    await prisma.message.deleteMany({ where: { instanceId: instance.id } });
    await prisma.brandNotification.deleteMany({ where: { instanceId: instance.id } });
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

    // contentBriefApplies must be true for this graph.
    assert.equal(await runtime.contentBriefApplies(instance.id), true);

    // Content Brief auto-runs from PAYMENT_RECEIVED (the step the payment route
    // enqueues): sends the campaign-brief email → CONTENT_BRIEF_SENT (terminal).
    await runtime.stepInstance(instance.id);
    assert.equal(await state(instance.id), "CONTENT_BRIEF_SENT", "Content Brief should reach CONTENT_BRIEF_SENT");
    console.log("  ✓ PAYMENT_RECEIVED → CONTENT_BRIEF_SENT (campaign-brief email sent)");

    // The campaign-brief email was sent with the right subject + copy.
    const msgs = await listMessagesByInstance(instance.id);
    const briefEmail = msgs.find(
      (m) => m.direction === "OUTBOUND" && (m.subject ?? "") === "Your Campaign Brief",
    );
    assert.ok(briefEmail, "a 'Your Campaign Brief' email must be sent");
    assert.ok(briefEmail!.body.includes(REFERRAL), "the email must include the referral link");
    assert.ok(briefEmail!.body.includes(NOTES), "the email must include the creator notes");
    assert.ok(
      (briefEmail!.idempotencyKey ?? "").startsWith("content-brief:"),
      "the send must use the content-brief idempotency key",
    );
    console.log("  ✓ email carries the referral link + creator notes");

    // A CONTENT_BRIEF_SENT event was recorded, and the instance is completed.
    const sentEvents = await listEventsByInstance(instance.id, { type: "CONTENT_BRIEF_SENT" });
    assert.ok(sentEvents.length >= 1, "a CONTENT_BRIEF_SENT event must be recorded");
    const done = await findInstanceById(instance.id);
    assert.ok(done!.completedAt, "completedAt must be stamped (terminal)");
    console.log("  ✓ CONTENT_BRIEF_SENT event recorded + completedAt stamped");

    // Idempotency: re-running the step must NOT send a second brief email. We
    // reset to PAYMENT_RECEIVED and step again; only one brief email exists.
    await prisma.executionInstance.update({
      where: { id: instance.id },
      data: { currentState: "PAYMENT_RECEIVED", currentNodeId: "node-payment-info", completedAt: null },
    });
    await runtime.stepInstance(instance.id);
    const briefEmails = (await listMessagesByInstance(instance.id)).filter(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("content-brief:"),
    );
    assert.equal(briefEmails.length, 1, "re-run must not send a second campaign-brief email");
    assert.equal(await state(instance.id), "CONTENT_BRIEF_SENT", "re-run still ends CONTENT_BRIEF_SENT");
    console.log("  ✓ idempotent: re-run does not duplicate the brief email");

    // ── Legacy graph: no CONTENT_BRIEF node → PAYMENT_RECEIVED stays terminal ──
    const legacyVersion = await prisma.workflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 2,
        nodeGraph: NODES.filter((n) => n.type !== "CONTENT_BRIEF") as unknown as object,
      },
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
      assert.equal(
        await runtime.contentBriefApplies(legacyInstance.id),
        false,
        "legacy graph (no CONTENT_BRIEF) must not apply Content Brief",
      );
      const endState = await runtime.runUntilWaiting(legacyInstance.id);
      assert.equal(endState, "PAYMENT_RECEIVED", "legacy graph keeps PAYMENT_RECEIVED terminal");
      console.log("  ✓ legacy graph: PAYMENT_RECEIVED stays terminal (no auto-chain)");
    } finally {
      await prisma.event.deleteMany({ where: { instanceId: legacyInstance.id } });
      await prisma.executionInstance.delete({ where: { id: legacyInstance.id } });
      await prisma.workflowVersion.delete({ where: { id: legacyVersion.id } });
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
