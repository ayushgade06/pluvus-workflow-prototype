/**
 * Attribution harness — real stack end-to-end:
 *
 *   1. Mint a Partnership (runs the Phase 1 harness path via handlePaymentSubmission).
 *   2. Hit GET /t/:referralCode — assert 302 + click row counted.
 *   3. POST three conversions:
 *        • one attributed (valueCents=0, signup)
 *        • one duplicate (same externalId) → 200 duplicate:true, no new row
 *        • one unknown code → 202 unattributed audit row
 *   4. Assert partnershipMetrics returns correct buckets.
 *   5. Assert CONVERSION_RECORDED events appear in inspector.
 *   6. POST refund on the attributed conversion → assert refunded=true.
 *   7. Assert CONVERSION_REFUNDED event.
 *   8. Assert payout-lock guard: 409 on locked conversion.
 *   9. Cleanup all rows.
 *
 * Run:
 *   npx cross-env NODE_ENV=production tsx --no-warnings src/engine/attribution.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  campaigns,
  clicks,
  conversions,
  creators,
  events,
  executionInstances,
  messages,
  partnerships,
  paymentInfo,
  workflows,
  workflowVersions,
  type InputJsonValue,
} from "../db/schema.js";
import {
  appendEvent,
  findPartnershipByInstance,
  listEventsByInstance,
  partnershipMetrics,
} from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import type { NodeSnapshot } from "./types.js";
import { saveUploadedFile } from "../storage/localFileStorage.js";
import { createApp } from "../app.js";

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8",
);

const AGREED_RATE = 300;
const COMMISSION = 10; // 10%
const TARGET_URL = "https://example.com/product";

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

// ---------------------------------------------------------------------------
// Minimal HTTP helpers — no external dependencies
// ---------------------------------------------------------------------------

interface FetchResult {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function httpRequest(
  options: http.RequestOptions & { body?: string },
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[]>,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function getNoRedirect(base: string, urlPath: string): Promise<FetchResult> {
  const url = new URL(urlPath, base);
  return httpRequest({
    hostname: url.hostname,
    port: Number(url.port),
    path: url.pathname + url.search,
    method: "GET",
  });
}

async function postJson(base: string, urlPath: string, body: unknown): Promise<FetchResult> {
  const url = new URL(urlPath, base);
  const bodyStr = JSON.stringify(body);
  return httpRequest({
    hostname: url.hostname,
    port: Number(url.port),
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(bodyStr),
    },
    body: bodyStr,
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\nAttribution Harness\n");

  const stamp = process.env["HARNESS_STAMP"] ?? `attr-${Date.now()}`;

  const uploadDir = await mkdtemp(path.join(tmpdir(), "attr-uploads-"));
  const prevUploads = process.env["UPLOADS_DIR"];
  process.env["UPLOADS_DIR"] = uploadDir;
  const stored = await saveUploadedFile(PDF_BYTES, "brief.pdf");
  const NODES = mergedNodes(stored.reference, stored.originalName);

  // ── Setup: campaign, workflow, creator, instance ─────────────────────────
  const campaign = (
    await db
      .insert(campaigns)
      .values({
        name: `Attribution Harness ${stamp}`,
        brand: "Acme",
        targetUrl: TARGET_URL,
        hiddenParamKey: "_from",
      })
      .returning()
  )[0]!;

  const workflow = (
    await db
      .insert(workflows)
      .values({ name: `Attribution Harness WF ${stamp}`, status: "PUBLISHED", campaignId: campaign.id })
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
        name: "Attr Tester",
        email: `attr-tester-${stamp}@example.com`,
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

  await appendEvent({
    instanceId: instance.id,
    type: "NEGOTIATION_TURN",
    nodeId: "node-negotiation",
    payload: { outcome: "accept", round: 1, message: "Deal", rate: AGREED_RATE },
  });

  // Spin up the Express app on a random port.
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const partnershipIdRef: { id: string } = { id: "" };

  const cleanup = async () => {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));

    if (partnershipIdRef.id) {
      await db.delete(conversions).where(eq(conversions.partnershipId, partnershipIdRef.id));
      await db.delete(clicks).where(eq(clicks.partnershipId, partnershipIdRef.id));
    }
    await db.delete(conversions).where(eq(conversions.externalId, `signup:unknown-${stamp}`));
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

    // ── Phase 1 path: mint partnership via payout submission ─────────────────
    await runtime.stepInstance(instance.id);
    await runtime.handlePaymentSubmission(instance.id, {
      method: "PAYPAL",
      accountIdentifier: "attr@paypal.me",
      country: "US",
    });

    const partnership = await findPartnershipByInstance(instance.id);
    assert.ok(partnership, "Partnership must be created");
    assert.ok(partnership!.trackingLink, "Partnership must have a trackingLink");
    partnershipIdRef.id = partnership!.id;
    console.log(`  ✓ Partnership minted, referralCode=${partnership!.referralCode}`);

    // ── Step 2: GET /t/:referralCode — assert 302 + click recorded ───────────
    const redirectRes = await getNoRedirect(base, `/t/${partnership!.referralCode}`);
    assert.equal(redirectRes.status, 302, `redirect must be 302, got ${redirectRes.status}`);
    const location = redirectRes.headers["location"] as string;
    assert.ok(location?.includes("example.com"), "redirect must point to targetUrl");
    assert.ok(location?.includes(partnership!.referralCode), "redirect must include referralCode param");

    const clickRows = await db
      .select()
      .from(clicks)
      .where(eq(clicks.partnershipId, partnership!.id));
    assert.equal(clickRows.length, 1, "click must be recorded");
    console.log("  ✓ GET /t/:code → 302, click recorded");

    // ── Step 3a: POST attributed signup conversion (valueCents=0) ────────────
    const signupExternalId = `signup:user-${stamp}`;
    const conv1Res = await postJson(base, "/attribution/conversion", {
      referralCode: partnership!.referralCode,
      externalId: signupExternalId,
      amountCents: 0,
    });
    assert.equal(conv1Res.status, 201, `signup conversion must return 201, got ${conv1Res.status}: ${conv1Res.body}`);
    const conv1Body = JSON.parse(conv1Res.body) as { attributed: boolean; conversionId: string };
    assert.equal(conv1Body.attributed, true);
    const conv1Id = conv1Body.conversionId;
    console.log("  ✓ signup conversion attributed (valueCents=0)");

    // ── Step 3b: duplicate externalId → 200 duplicate:true ───────────────────
    const conv2Res = await postJson(base, "/attribution/conversion", {
      referralCode: partnership!.referralCode,
      externalId: signupExternalId,
      amountCents: 0,
    });
    assert.equal(conv2Res.status, 200);
    const conv2Body = JSON.parse(conv2Res.body) as { duplicate: boolean };
    assert.equal(conv2Body.duplicate, true);

    const convRowsAfterDup = await db
      .select()
      .from(conversions)
      .where(eq(conversions.partnershipId, partnership!.id));
    assert.equal(convRowsAfterDup.length, 1, "duplicate must not create a second row");
    console.log("  ✓ duplicate externalId → 200 duplicate:true, no second row");

    // ── Step 3c: unknown referral code → 202 unattributed ────────────────────
    const conv3Res = await postJson(base, "/attribution/conversion", {
      referralCode: "totally_unknown_xyz",
      externalId: `signup:unknown-${stamp}`,
      amountCents: 0,
    });
    assert.equal(conv3Res.status, 202);
    const conv3Body = JSON.parse(conv3Res.body) as { attributed: boolean };
    assert.equal(conv3Body.attributed, false);
    console.log("  ✓ unknown code → 202, audit row kept");

    // ── Step 4: partnershipMetrics ────────────────────────────────────────────
    const metrics = await partnershipMetrics(partnership!.id);
    assert.equal(metrics.clicks, 1, "clicks must be 1");
    assert.equal(metrics.conversions, 1, "attributed conversions must be 1");
    assert.equal(metrics.revenueCents, 0, "revenue must be 0 for signup");
    assert.equal(metrics.earnedCents, 0, "earned must be 0 for zero-value signup");
    assert.equal(metrics.unpaidCents, 0);
    assert.equal(metrics.paidCents, 0);
    console.log("  ✓ partnershipMetrics: clicks=1, conversions=1, revenue=0");

    // ── Step 5: CONVERSION_RECORDED in inspector ──────────────────────────────
    const convEvents = await listEventsByInstance(instance.id, { type: "CONVERSION_RECORDED" });
    assert.ok(convEvents.length >= 1, "CONVERSION_RECORDED event must be recorded");
    const evPayload = convEvents[0]!.payload as Record<string, unknown>;
    assert.equal(evPayload["externalId"], signupExternalId);
    console.log("  ✓ CONVERSION_RECORDED event in inspector");

    // ── Step 6: refund the conversion ─────────────────────────────────────────
    const refundRes = await postJson(
      base,
      `/attribution/conversion/${signupExternalId}/refund`,
      {},
    );
    assert.equal(refundRes.status, 200, `refund must return 200, got ${refundRes.status}: ${refundRes.body}`);
    const refundBody = JSON.parse(refundRes.body) as { refunded: boolean };
    assert.equal(refundBody.refunded, true);
    console.log("  ✓ refund accepted");

    // ── Step 7: CONVERSION_REFUNDED event ─────────────────────────────────────
    const refundEvents = await listEventsByInstance(instance.id, { type: "CONVERSION_REFUNDED" });
    assert.ok(refundEvents.length >= 1, "CONVERSION_REFUNDED event must be recorded");
    console.log("  ✓ CONVERSION_REFUNDED event in inspector");

    // ── Step 8: payout-lock guard ─────────────────────────────────────────────
    await db
      .update(conversions)
      .set({ payoutId: "pay_fake_001", refunded: false })
      .where(eq(conversions.id, conv1Id));

    const lockedRes = await postJson(
      base,
      `/attribution/conversion/${signupExternalId}/refund`,
      {},
    );
    assert.equal(lockedRes.status, 409, "locked conversion must return 409");
    const lockedBody = JSON.parse(lockedRes.body) as { error: string };
    assert.ok(lockedBody.error.includes("payout"));
    console.log("  ✓ payout-lock guard: 409 when payoutId set");

    console.log("\nAll Attribution checks passed ✓\n");
  } finally {
    await cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Attribution harness failed:", err);
  process.exit(1);
});
