/**
 * Partnership harness — drives a real instance through ACCEPTED → payout-form
 * submit against a live DB, and asserts the Partnership row, the
 * PARTNERSHIP_ACTIVATED event, and the welcome email, including idempotency on
 * a forced duplicate submission.
 *
 * Creates its own throwaway data and deletes it on exit.
 * Run:
 *   npx cross-env NODE_ENV=production tsx --no-warnings src/engine/partnership.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InputJsonValue } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  campaigns,
  creators,
  events,
  executionInstances,
  messages,
  partnerships,
  paymentInfo,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import {
  appendEvent,
  findInstanceById,
  listEventsByInstance,
  listMessagesByInstance,
  findPartnershipByInstance,
} from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import type { NodeSnapshot } from "./types.js";
import { saveUploadedFile } from "../storage/localFileStorage.js";

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);

const AGREED_RATE = 350;
const COMMISSION = 10;
const TARGET_URL = "https://example.com/shop";

function mergedNodes(briefFileRef: string, briefFileName: string): NodeSnapshot[] {
  return [
    { id: "node-import", type: "IMPORT_CREATOR_LIST", order: 0, config: {} },
    {
      id: "node-outreach",
      type: "INITIAL_OUTREACH",
      order: 1,
      config: {
        subjectTemplate: "Partner with {{brandName}}",
        bodyTemplate: "Hi {{creatorName}}",
        brandName: "Acme",
        senderName: "Acme",
      },
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
      config: {
        minBudget: 200,
        maxBudget: 500,
        maxRounds: 3,
        commissionRate: COMMISSION,
        brandName: "Acme",
        senderName: "Acme",
      },
    },
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 5,
      config: {
        brandName: "Acme",
        senderName: "Acme Partnerships",
        commissionRate: COMMISSION,
        briefFileRef,
        briefFileName,
      },
    },
  ];
}

async function main(): Promise<void> {
  console.log("\nPartnership Harness\n");

  const stamp = process.env["HARNESS_STAMP"] ?? `partner-${Date.now()}`;

  const uploadDir = await mkdtemp(path.join(tmpdir(), "partner-uploads-"));
  const prevUploads = process.env["UPLOADS_DIR"];
  process.env["UPLOADS_DIR"] = uploadDir;
  const stored = await saveUploadedFile(PDF_BYTES, "brief.pdf");

  const NODES = mergedNodes(stored.reference, stored.originalName);

  // Campaign with a targetUrl so the tracking link is generated.
  const campaign = (
    await db
      .insert(campaigns)
      .values({
        name: `Partnership Harness ${stamp}`,
        brand: "Acme",
        targetUrl: TARGET_URL,
        hiddenParamKey: "_from",
      })
      .returning()
  )[0]!;

  const workflow = (
    await db
      .insert(workflows)
      .values({ name: `Partnership Harness WF ${stamp}`, status: "PUBLISHED", campaignId: campaign.id })
      .returning()
  )[0]!;

  const version = (
    await db
      .insert(workflowVersions)
      .values({
        workflowId: workflow.id,
        version: 1,
        nodeGraph: NODES as unknown as InputJsonValue,
      })
      .returning()
  )[0]!;

  const creator = (
    await db
      .insert(creators)
      .values({
        name: "Parker Partner",
        email: `parker-partner-${stamp}@example.com`,
        platform: "YouTube",
      })
      .returning()
  )[0]!;

  const instance = (
    await db
      .insert(executionInstances)
      .values({
        workflowVersionId: version.id,
        creatorId: creator.id,
        currentState: "ACCEPTED",
        currentNodeId: null,
      })
      .returning()
  )[0]!;

  // Seed an ACCEPT event so resolveAgreedFee finds the agreed rate.
  await appendEvent({
    instanceId: instance.id,
    type: "NEGOTIATION_TURN",
    nodeId: "node-negotiation",
    payload: { outcome: "accept", round: 1, message: "Deal", rate: AGREED_RATE },
  });

  const cleanup = async () => {
    await db.delete(events).where(eq(events.instanceId, instance.id));
    await db.delete(messages).where(eq(messages.instanceId, instance.id));
    await db.delete(partnerships).where(eq(partnerships.instanceId, instance.id));
    await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, instance.id));
    await db.delete(executionInstances).where(eq(executionInstances.id, instance.id));
    await db.delete(workflowVersions).where(eq(workflowVersions.id, version.id));
    await db.delete(workflows).where(eq(workflows.id, workflow.id));
    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
    await db.delete(creators).where(eq(creators.id, creator.id));
    await rm(uploadDir, { recursive: true, force: true });
    if (prevUploads === undefined) delete process.env["UPLOADS_DIR"];
    else process.env["UPLOADS_DIR"] = prevUploads;
  };

  try {
    const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

    // ── SEND PHASE: ACCEPTED → PAYMENT_PENDING ────────────────────────────────
    await runtime.stepInstance(instance.id);
    const midState = (await findInstanceById(instance.id))!.currentState;
    assert.equal(midState, "PAYMENT_PENDING", "merged Content Brief should reach PAYMENT_PENDING");
    console.log("  ✓ ACCEPTED → PAYMENT_PENDING");

    // ── SUBMISSION PHASE: payout form → CONTENT_BRIEF_SENT ───────────────────
    await runtime.handlePaymentSubmission(instance.id, {
      method: "PAYPAL",
      accountIdentifier: "parker@paypal.me",
      country: "US",
    });

    const finalState = (await findInstanceById(instance.id))!.currentState;
    assert.equal(finalState, "CONTENT_BRIEF_SENT", "payout form should land on CONTENT_BRIEF_SENT");
    console.log("  ✓ payout form → CONTENT_BRIEF_SENT");

    // ── Partnership row ───────────────────────────────────────────────────────
    const partnership = await findPartnershipByInstance(instance.id);
    assert.ok(partnership, "Partnership row must be created");
    assert.match(
      partnership!.referralCode,
      /^[a-z0-9]{1,12}_[0-9a-f]{12}$/,
      "referralCode must have slug_hex format",
    );
    assert.equal(
      partnership!.agreedFeeCents,
      Math.round(AGREED_RATE * 100),
      "agreedFeeCents must equal Math.round(agreedFee * 100)",
    );
    assert.equal(partnership!.commissionRate, COMMISSION, "commissionRate must be frozen");
    assert.ok(
      partnership!.trackingLink?.includes(TARGET_URL),
      "trackingLink must include the target URL",
    );
    assert.ok(
      partnership!.trackingLink?.includes(`_from=${partnership!.referralCode}`),
      "trackingLink must include the referral code as the hidden param",
    );
    assert.equal(partnership!.status, "ACTIVE");
    console.log("  ✓ Partnership row created with correct code, cents, commission, link");

    // ── PARTNERSHIP_ACTIVATED event ───────────────────────────────────────────
    const partnerEvents = await listEventsByInstance(instance.id, {
      type: "PARTNERSHIP_ACTIVATED",
    });
    assert.ok(partnerEvents.length >= 1, "PARTNERSHIP_ACTIVATED event must be appended");
    const evPayload = partnerEvents[0]!.payload as Record<string, unknown>;
    assert.equal(evPayload["referralCode"], partnership!.referralCode);
    console.log("  ✓ PARTNERSHIP_ACTIVATED event recorded");

    // ── Welcome email ─────────────────────────────────────────────────────────
    const allMsgs = await listMessagesByInstance(instance.id);
    const welcomeEmail = allMsgs.find(
      (m) =>
        m.direction === "OUTBOUND" &&
        (m.idempotencyKey ?? "").startsWith("partnership:welcome:"),
    );
    assert.ok(welcomeEmail, "welcome email must be sent");
    assert.ok(
      welcomeEmail!.subject?.includes("tracking link") ||
        welcomeEmail!.subject?.includes("all set"),
      "subject must match the link variant",
    );
    assert.ok(
      welcomeEmail!.body.includes(partnership!.trackingLink!),
      "welcome email body must include the tracking link",
    );
    assert.ok(
      welcomeEmail!.body.includes(`$${AGREED_RATE}`),
      "welcome email must state the agreed fee in dollars",
    );
    console.log("  ✓ welcome email sent with tracking link + fee");

    // ── Idempotency: forced duplicate submission ───────────────────────────────
    // Reset instance back to PAYMENT_PENDING as if the job retried.
    await db
      .update(executionInstances)
      .set({ currentState: "PAYMENT_PENDING", completedAt: null })
      .where(eq(executionInstances.id, instance.id));
    // The PaymentInfo row stays PAYMENT_RECEIVED so the submission re-runs the
    // submission executor path and calls resolvePartnership again.
    await runtime.handlePaymentSubmission(instance.id, {
      method: "PAYPAL",
      accountIdentifier: "parker@paypal.me",
    });

    // Row count must remain 1.
    const partnerRows = await db
      .select()
      .from(partnerships)
      .where(eq(partnerships.instanceId, instance.id));
    assert.equal(partnerRows.length, 1, "re-submit must NOT create a second Partnership row");

    // Welcome email count must remain 1.
    const welcomeEmails = allMsgs.filter(
      (m) =>
        m.direction === "OUTBOUND" &&
        (m.idempotencyKey ?? "").startsWith("partnership:welcome:"),
    );
    assert.equal(welcomeEmails.length, 1, "re-submit must NOT send a second welcome email");
    console.log("  ✓ idempotent: re-submit creates no duplicate row or email");

    // ── No-link variant: campaign without targetUrl ───────────────────────────
    // Override campaign targetUrl to null via a fresh campaign.
    const bareCampaign = (
      await db
        .insert(campaigns)
        .values({ name: `Partnership Harness Bare ${stamp}`, brand: "Acme" })
        .returning()
    )[0]!;
    const bareWorkflow = (
      await db
        .insert(workflows)
        .values({ name: `Bare WF ${stamp}`, status: "PUBLISHED", campaignId: bareCampaign.id })
        .returning()
    )[0]!;
    const bareVersion = (
      await db
        .insert(workflowVersions)
        .values({
          workflowId: bareWorkflow.id,
          version: 1,
          nodeGraph: NODES as unknown as InputJsonValue,
        })
        .returning()
    )[0]!;
    // Use a separate creator so (workflowVersionId, creatorId) stays unique.
    const bareCreator = (
      await db
        .insert(creators)
        .values({
          name: "Riley No-Link",
          email: `riley-nolink-${stamp}@example.com`,
          platform: "TikTok",
        })
        .returning()
    )[0]!;

    const bareInstance2 = (
      await db
        .insert(executionInstances)
        .values({
          workflowVersionId: bareVersion.id,
          creatorId: bareCreator.id,
          currentState: "CONTENT_BRIEF_SENT",
          completedAt: new Date(),
        })
        .returning()
    )[0]!;

    // Directly call resolvePartnership with a ctx that has no campaign.targetUrl.
    const { resolvePartnership } = await import("./executors/partnership.js");
    const { MockEmailProvider: ME } = await import("./providers.js");
    const mockEmail = new ME();
    // Build a minimal ctx without campaign targetUrl.
    const noLinkCtx = {
      instance: bareInstance2,
      node: NODES[NODES.length - 1]!,
      nodeGraph: NODES,
      creator: bareCreator,
      campaign: { ...bareCampaign, targetUrl: null, hiddenParamKey: "_from" },
    } as Parameters<typeof resolvePartnership>[0];
    // Seed a NEGOTIATION_TURN so resolveAgreedFee works.
    await appendEvent({
      instanceId: bareInstance2.id,
      type: "NEGOTIATION_TURN",
      nodeId: "node-negotiation",
      payload: { outcome: "accept", round: 1, message: "Deal", rate: 200 },
    });

    const noLinkPartnership = await resolvePartnership(noLinkCtx, mockEmail);
    assert.ok(noLinkPartnership, "Partnership must be created even without targetUrl");
    assert.equal(noLinkPartnership!.trackingLink, null, "trackingLink must be null when no targetUrl");

    const noLinkMsgs = await listMessagesByInstance(bareInstance2.id);
    const noLinkWelcome = noLinkMsgs.find(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("partnership:welcome:"),
    );
    assert.ok(noLinkWelcome, "welcome email must be sent even without a tracking link");
    assert.ok(
      noLinkWelcome!.subject?.includes("next steps"),
      "no-link variant must use the 'next steps' subject",
    );
    console.log("  ✓ no-link variant: null trackingLink + no-link email subject");

    // Cleanup bare campaign data.
    await db.delete(events).where(eq(events.instanceId, bareInstance2.id));
    await db.delete(messages).where(eq(messages.instanceId, bareInstance2.id));
    await db.delete(partnerships).where(eq(partnerships.instanceId, bareInstance2.id));
    await db.delete(executionInstances).where(eq(executionInstances.id, bareInstance2.id));
    await db.delete(workflowVersions).where(eq(workflowVersions.id, bareVersion.id));
    await db.delete(workflows).where(eq(workflows.id, bareWorkflow.id));
    await db.delete(campaigns).where(eq(campaigns.id, bareCampaign.id));
    await db.delete(creators).where(eq(creators.id, bareCreator.id));

    console.log("\nAll Partnership checks passed ✓\n");
  } finally {
    await cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Partnership harness failed:", err);
  process.exit(1);
});
