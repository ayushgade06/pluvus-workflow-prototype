/**
 * Payment Info verification harness — drives a complete journey through a
 * workflow that ends in REWARD_SETUP → PAYMENT_INFO, using mock providers and
 * the real runtime (no Redis/queues). Proves:
 *
 *   REWARD_CONFIRMED → (auto) PAYMENT_INFO email → PAYMENT_PENDING
 *     → creator submits the hosted form → PAYMENT_RECEIVED (terminal)
 *
 * Also verifies: the payout token + link resolve back to the instance; the
 * payout-request email carries the tokenized link; the submission is persisted;
 * and a second submission is an idempotent no-op (StaleInstance handled).
 *
 * Creates its own throwaway workflow/version/creator/instance and deletes them
 * on exit, so it does not depend on or mutate seed data. Run:
 *   npx tsx src/engine/paymentInfo.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import type { InstanceState, InputJsonValue } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  brandNotifications,
  creators,
  events,
  executionInstances,
  messages,
  paymentInfo,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import {
  findInstanceById,
  listEventsByInstance,
  listMessagesByInstance,
  findPaymentInfoByToken,
  findPaymentInfoByInstance,
} from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import type { NodeSnapshot } from "./types.js";
import { paymentFormLink } from "./executors/paymentEmail.js";
import { renderPaymentFormPage } from "../routes/paymentPage.js";
import { shipsPhysicalProductOf } from "../routes/payment.js";

const NODES: NodeSnapshot[] = [
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
    config: { minBudget: 200, maxBudget: 500, maxRounds: 3, commissionRate: 12, brandName: "Acme", senderName: "Acme", deliverables: "2 Reels", timeline: "Live by Aug 1, 2026" },
  },
  {
    id: "node-reward-setup",
    type: "REWARD_SETUP",
    order: 5,
    config: { deliverables: "2 Reels", timeline: "Live by Aug 1, 2026", brandName: "Acme", senderName: "Acme" },
  },
  {
    id: "node-payment-info",
    type: "PAYMENT_INFO",
    order: 6,
    config: { brandName: "Acme", senderName: "Acme" },
  },
];

async function state(instanceId: string): Promise<InstanceState> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  return inst.currentState;
}

async function main(): Promise<void> {
  console.log("\nPayment Info Harness\n");

  const stamp = process.env["HARNESS_STAMP"] ?? "pi-harness";
  const workflow = (await db.insert(workflows).values({
    name: `Payment Info Harness ${stamp}`,
    status: "PUBLISHED",
  }).returning())[0]!;
  const version = (await db.insert(workflowVersions).values({
    workflowId: workflow.id,
    version: 1,
    nodeGraph: NODES as unknown as InputJsonValue,
  }).returning())[0]!;
  const creator = (await db.insert(creators).values({
    name: "Casey Creator",
    email: `casey-pi-${stamp}@example.com`,
    platform: "Instagram",
    niche: "fitness",
  }).returning())[0]!;
  // Park directly in REWARD_CONFIRMED on the reward node — the Reward Setup path
  // is already covered by rewardSetup.harness.ts; here we exercise Payment Info.
  const instance = (await db.insert(executionInstances).values({
    workflowVersionId: version.id,
    creatorId: creator.id,
    currentState: "REWARD_CONFIRMED",
    currentNodeId: "node-reward-setup",
  }).returning())[0]!;

  const cleanup = async () => {
    // PaymentInfo has ON DELETE RESTRICT → must be removed before the instance.
    await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, instance.id));
    await db.delete(events).where(eq(events.instanceId, instance.id));
    await db.delete(messages).where(eq(messages.instanceId, instance.id));
    await db.delete(brandNotifications).where(eq(brandNotifications.instanceId, instance.id));
    await db.delete(executionInstances).where(eq(executionInstances.id, instance.id));
    await db.delete(workflowVersions).where(eq(workflowVersions.id, version.id));
    await db.delete(workflows).where(eq(workflows.id, workflow.id));
    await db.delete(creators).where(eq(creators.id, creator.id));
  };

  try {
    const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider());

    // paymentInfoApplies must be true for this graph.
    assert.equal(await runtime.paymentInfoApplies(instance.id), true);

    // Payment Info auto-runs from REWARD_CONFIRMED (the step the worker enqueues):
    // sends the payout-request email → PAYMENT_PENDING.
    await runtime.stepInstance(instance.id);
    assert.equal(await state(instance.id), "PAYMENT_PENDING", "Payment Info should enter PAYMENT_PENDING");
    console.log("  ✓ REWARD_CONFIRMED → PAYMENT_PENDING (payout-request email sent)");

    // A PaymentInfo row now exists. BUG-S1: the row stores the sha256 HASH of the
    // token; the RAW token lives in the sent email link (and the PAYMENT_INFO_SENT
    // event). Extract the raw token from the outbound email to resolve the row.
    const payment = await findPaymentInfoByInstance(instance.id);
    assert.ok(payment, "a PaymentInfo row must be created");
    assert.equal(payment!.status, "PAYMENT_PENDING");

    const rawTokenOf = (body: string): string => {
      const m = body.match(/\/payment\/([^\s/]+)/);
      assert.ok(m, "the email must contain a /payment/<token> link");
      return m![1]!;
    };
    const msgs0 = await listMessagesByInstance(instance.id);
    const requestEmail = msgs0.find(
      (m) => m.direction === "OUTBOUND" && (m.subject ?? "") === "Payment Information Required",
    );
    assert.ok(requestEmail, "a 'Payment Information Required' email must be sent");
    const rawToken = rawTokenOf(requestEmail!.body);

    // The stored value is the HASH, never the raw token (BUG-S1).
    assert.notEqual(payment!.token, rawToken, "the DB must store the hash, not the raw token");

    const resolved = await findPaymentInfoByToken(rawToken);
    assert.ok(resolved, "the RAW token must resolve back to a PaymentInfo row");
    assert.equal(resolved!.instance.id, instance.id, "token resolves to the right instance");
    assert.equal(resolved!.instance.creator.name, "Casey Creator");
    console.log("  ✓ raw token resolves back to creator + instance (hash stored at rest)");

    assert.ok(
      requestEmail!.body.includes(paymentFormLink(rawToken)),
      "the email must include the tokenized payout-form link (raw token)",
    );
    console.log("  ✓ payout-request email includes the tokenized form link");

    // Idempotency: re-running the step must NOT rotate the token or re-send. We
    // reset to REWARD_CONFIRMED and step again; the stored hash stays the same.
    await db.update(executionInstances)
      .set({ currentState: "REWARD_CONFIRMED", currentNodeId: "node-reward-setup" })
      .where(eq(executionInstances.id, instance.id));
    await runtime.stepInstance(instance.id);
    const paymentAfter = await findPaymentInfoByInstance(instance.id);
    assert.equal(paymentAfter!.token, payment!.token, "re-run must reuse the same token hash (no new link)");
    const requestEmails = (await listMessagesByInstance(instance.id)).filter(
      (m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith("payment:request:"),
    );
    assert.equal(requestEmails.length, 1, "re-run must not send a second payout-request email");
    console.log("  ✓ idempotent: re-run reuses token, no duplicate email");

    // The creator submits the hosted form → PAYMENT_RECEIVED (terminal).
    await runtime.handlePaymentSubmission(instance.id, {
      method: "PAYPAL",
      accountIdentifier: "casey@paypal.me",
      country: "United States",
      notes: "prefer monthly payouts",
    });
    assert.equal(await state(instance.id), "PAYMENT_RECEIVED", "submission must reach PAYMENT_RECEIVED");
    console.log("  ✓ form submission → PAYMENT_RECEIVED (terminal)");

    // The submitted payout fields were persisted.
    const submitted = await findPaymentInfoByInstance(instance.id);
    assert.equal(submitted!.status, "PAYMENT_RECEIVED");
    assert.equal(submitted!.method, "PAYPAL");
    assert.equal(submitted!.accountIdentifier, "casey@paypal.me");
    assert.equal(submitted!.country, "United States");
    assert.ok(submitted!.submittedAt, "submittedAt must be stamped");

    // A PAYMENT_RECEIVED event was recorded, and the instance is completed.
    const recvEvents = await listEventsByInstance(instance.id, { type: "PAYMENT_RECEIVED" });
    assert.ok(recvEvents.length >= 1, "a PAYMENT_RECEIVED event must be recorded");
    const done = await findInstanceById(instance.id);
    assert.ok(done!.completedAt, "completedAt must be stamped (terminal)");
    console.log("  ✓ payout fields persisted + PAYMENT_RECEIVED event + completedAt stamped");

    // Idempotent re-submission: the instance is now terminal (not PAYMENT_PENDING),
    // so handlePaymentSubmission must reject rather than double-advance.
    let threw = false;
    try {
      await runtime.handlePaymentSubmission(instance.id, {
        method: "WISE",
        accountIdentifier: "someone-else@wise.com",
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, "a second submission after PAYMENT_RECEIVED must be rejected");
    const unchanged = await findPaymentInfoByInstance(instance.id);
    assert.equal(unchanged!.method, "PAYPAL", "payout method must not be overwritten by a late submission");
    console.log("  ✓ second submission rejected; stored payout unchanged");

    // ── Physical-product graph: shipping address collected on the form ────────
    // A separate version whose PAYMENT_INFO node is stamped with
    // shipsPhysicalProduct + a reward blurb. Proves: the payout email nudges the
    // creator about shipping; the hosted page renders the address section; and a
    // submitted address persists into PaymentInfo.extra.shipping.
    const shipNodes: NodeSnapshot[] = NODES.map((n) =>
      n.type === "PAYMENT_INFO"
        ? {
            ...n,
            config: {
              ...n.config,
              shipsPhysicalProduct: true,
              rewardDescription: "a free pair of our running shoes",
            },
          }
        : n,
    );
    const shipVersion = (await db.insert(workflowVersions).values({
      workflowId: workflow.id,
      version: 3,
      nodeGraph: shipNodes as unknown as InputJsonValue,
    }).returning())[0]!;
    const shipInstance = (await db.insert(executionInstances).values({
      workflowVersionId: shipVersion.id,
      creatorId: creator.id,
      currentState: "REWARD_CONFIRMED",
      currentNodeId: "node-reward-setup",
    }).returning())[0]!;
    try {
      // Auto-run Payment Info → PAYMENT_PENDING; the payout email mentions shipping.
      await runtime.stepInstance(shipInstance.id);
      assert.equal(await state(shipInstance.id), "PAYMENT_PENDING");
      const shipMsgs = await listMessagesByInstance(shipInstance.id);
      const shipReq = shipMsgs.find(
        (m) => m.direction === "OUTBOUND" && (m.subject ?? "") === "Payment Information Required",
      );
      assert.ok(shipReq, "a payout-request email must be sent");
      assert.match(shipReq!.body, /shipping address/i, "email nudges the creator about shipping");
      console.log("  ✓ physical product: payout email nudges the creator about shipping");

      // The hosted page gate reads shipsPhysicalProduct off the version's nodeGraph.
      // BUG-S1: resolve via the RAW token from the email link, not the stored hash.
      const shipRawToken = (() => {
        const m = shipReq!.body.match(/\/payment\/([^\s/]+)/);
        assert.ok(m, "the ship email must contain a /payment/<token> link");
        return m![1]!;
      })();
      const resolvedShip = await findPaymentInfoByToken(shipRawToken);
      assert.equal(
        shipsPhysicalProductOf(resolvedShip),
        true,
        "the page gate must read shipsPhysicalProduct from the nodeGraph",
      );
      assert.match(
        renderPaymentFormPage({
          token: shipRawToken,
          creatorName: "Casey Creator",
          brandName: "Acme",
          showShippingAddress: shipsPhysicalProductOf(resolvedShip),
        }),
        /name="shipLine1"/,
        "the rendered form must include the shipping-address section",
      );
      console.log("  ✓ physical product: form gate + rendered shipping section");

      // Submit with a shipping address → persisted under extra.shipping.
      const shipping = {
        name: "Casey Creator",
        line1: "500 Marathon Rd",
        line2: "Apt 4",
        city: "Austin",
        region: "Texas",
        postalCode: "78701",
        country: "United States",
      };
      await runtime.handlePaymentSubmission(shipInstance.id, {
        method: "PAYPAL",
        accountIdentifier: "casey@paypal.me",
        extra: { shipping },
      });
      assert.equal(await state(shipInstance.id), "PAYMENT_RECEIVED");
      const shipSubmitted = await findPaymentInfoByInstance(shipInstance.id);
      const extra = shipSubmitted!.extra as { shipping?: Record<string, string> } | null;
      assert.deepEqual(extra?.shipping, shipping, "shipping address must persist in extra.shipping");
      console.log("  ✓ physical product: shipping address persisted in PaymentInfo.extra");
    } finally {
      await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, shipInstance.id));
      await db.delete(events).where(eq(events.instanceId, shipInstance.id));
      await db.delete(messages).where(eq(messages.instanceId, shipInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, shipInstance.id));
      await db.delete(workflowVersions).where(eq(workflowVersions.id, shipVersion.id));
    }

    // ── Legacy graph: no PAYMENT_INFO node → REWARD_CONFIRMED stays terminal ──
    const legacyVersion = (await db.insert(workflowVersions).values({
      workflowId: workflow.id,
      version: 2,
      nodeGraph: NODES.filter((n) => n.type !== "PAYMENT_INFO") as unknown as InputJsonValue,
    }).returning())[0]!;
    const legacyInstance = (await db.insert(executionInstances).values({
      workflowVersionId: legacyVersion.id,
      creatorId: creator.id,
      currentState: "REWARD_CONFIRMED",
      currentNodeId: "node-reward-setup",
    }).returning())[0]!;
    try {
      assert.equal(
        await runtime.paymentInfoApplies(legacyInstance.id),
        false,
        "legacy graph (no PAYMENT_INFO) must not apply Payment Info",
      );
      const endState = await runtime.runUntilWaiting(legacyInstance.id);
      assert.equal(endState, "REWARD_CONFIRMED", "legacy graph keeps REWARD_CONFIRMED terminal");
      console.log("  ✓ legacy graph: REWARD_CONFIRMED stays terminal (no auto-chain)");
    } finally {
      await db.delete(events).where(eq(events.instanceId, legacyInstance.id));
      await db.delete(executionInstances).where(eq(executionInstances.id, legacyInstance.id));
      await db.delete(workflowVersions).where(eq(workflowVersions.id, legacyVersion.id));
    }

    console.log("\nAll Payment Info checks passed ✓\n");
  } finally {
    await cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Payment Info harness failed:", err);
  process.exit(1);
});
