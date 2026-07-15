/**
 * Payout ledger verification harness (Phase 3) — drives the FULL brand→creator
 * loop against a REAL local stack (Neon DB + the real Express app over HTTP,
 * mock email provider), proving both the confirm path and the dispute path end
 * to end, plus the concurrency guarantee and the GET-mutates-nothing invariant.
 *
 * It boots the real createApp() on an ephemeral port and drives it with fetch,
 * so the routes execute exactly as in production. The "mock email provider's
 * outbox" is the persisted OUTBOUND Message row: sendOnce writes the full draft
 * body (including the token-bearing confirm/dispute links) before send(), so the
 * harness recovers the raw token from there — the token itself is never stored.
 *
 * Proves:
 *   1. Commission payout: sums unpaid conversions, locks each into ONE payout.
 *   2. CONCURRENCY: two parallel commission creations yield exactly ONE payout
 *      (real two-connection FOR UPDATE contention — the proof PGlite can't give).
 *   3. Fixed-fee payout: pays the obligation, flips it PAID.
 *   4. Mark-sent mints a token (sha256-hash-only in the DB), emails the creator.
 *   5. GET interstitial renders AND MUTATES NOTHING (I-5) — asserted by reading
 *      the row before/after two GETs (mail-prefetch simulation).
 *   6. POST confirm → SETTLED + PAYOUT_CONFIRMED + PAYOUT_SETTLED events.
 *   7. POST dispute → DISPUTED + PAYOUT_DISPUTED event + a brand dispute email.
 *   8. Token tamper/reuse: a wrong token 404s; a reused (already-settled) link is
 *      a safe idempotent notice.
 *
 * Creates its own throwaway campaign/workflow/creator/instance/partnership and
 * deletes them on exit. Run:
 *   npm run harness:payouts     (or npx tsx src/engine/payouts.harness.ts)
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

// The routes call emailProvider(); force the mock + a self-referential base URL
// BEFORE the app (and its route modules) read them.
process.env["EMAIL_PROVIDER"] = "mock";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  campaigns,
  conversions,
  creators,
  events,
  executionInstances,
  messages,
  obligations,
  partnerships,
  paymentInfo,
  payouts,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import {
  createCommissionPayout,
  findPayoutById,
  listEventsByInstance,
  listMessagesByInstance,
} from "../db/index.js";
import { createApp } from "../app.js";

const STAMP = process.env["HARNESS_STAMP"] ?? `payouts-${Date.now()}`;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Recover a confirm or dispute raw token from the persisted email body. */
function tokenFromBody(body: string, action: "confirm" | "dispute"): string {
  const re = new RegExp(`/payout/${action}/[^?]+\\?token=([0-9a-f]+)`);
  const m = body.match(re);
  if (!m) throw new Error(`no ${action} token found in email body:\n${body}`);
  return m[1]!;
}

async function main(): Promise<void> {
  console.log("\nPayout Ledger Harness\n");

  // ── boot the real app on an ephemeral port ──────────────────────────────────
  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((r) => server.on("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  process.env["PAYMENT_BASE_URL"] = origin; // links point back at this server
  console.log(`  (app listening on ${origin})`);

  // ── seed a partnership with conversions + a fixed-fee obligation ─────────────
  const campaign = (
    await db
      .insert(campaigns)
      .values({ name: `Payout Harness ${STAMP}`, brand: "Acme", notifyEmail: `brand-${STAMP}@example.com` })
      .returning()
  )[0]!;
  const workflow = (await db.insert(workflows).values({ name: `Payout WF ${STAMP}`, campaignId: campaign.id, status: "PUBLISHED" }).returning())[0]!;
  const version = (await db.insert(workflowVersions).values({ workflowId: workflow.id, version: 1, nodeGraph: [] }).returning())[0]!;
  const creator = (await db.insert(creators).values({ name: "Casey Creator", email: `casey-${STAMP}@example.com`, platform: "Instagram" }).returning())[0]!;
  const instance = (await db.insert(executionInstances).values({ workflowVersionId: version.id, creatorId: creator.id, currentState: "CONTENT_BRIEF_SENT" }).returning())[0]!;
  // The creator submitted payout info (PayPal) — the payout copies it (I-2).
  await db.insert(paymentInfo).values({ instanceId: instance.id, token: `pi-${STAMP}`, status: "PAYMENT_RECEIVED", method: "PAYPAL", accountIdentifier: "casey@paypal.me" });
  const partnership = (
    await db
      .insert(partnerships)
      .values({ instanceId: instance.id, campaignId: campaign.id, creatorId: creator.id, referralCode: `code-${STAMP}`, agreedFeeCents: 42000, commissionRate: 0.1 })
      .returning()
  )[0]!;
  // Two unpaid commission conversions + one refunded (excluded) + one obligation.
  await db.insert(conversions).values([
    { partnershipId: partnership.id, referralCode: partnership.referralCode, externalId: `conv-a-${STAMP}`, valueCents: 5000, commissionCents: 500, refunded: false },
    { partnershipId: partnership.id, referralCode: partnership.referralCode, externalId: `conv-b-${STAMP}`, valueCents: 7000, commissionCents: 700, refunded: false },
    { partnershipId: partnership.id, referralCode: partnership.referralCode, externalId: `conv-refunded-${STAMP}`, valueCents: 9000, commissionCents: 900, refunded: true },
  ]);
  const obligation = (
    await db.insert(obligations).values({ partnershipId: partnership.id, description: "Agreed collaboration fee", amountCents: 42000, status: "PENDING" }).returning()
  )[0]!;

  const cleanup = async () => {
    await db.delete(events).where(eq(events.instanceId, instance.id));
    await db.delete(messages).where(eq(messages.instanceId, instance.id));
    await db.delete(conversions).where(eq(conversions.partnershipId, partnership.id));
    await db.delete(payouts).where(eq(payouts.partnershipId, partnership.id));
    await db.delete(obligations).where(eq(obligations.partnershipId, partnership.id));
    await db.delete(partnerships).where(eq(partnerships.id, partnership.id));
    await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, instance.id));
    await db.delete(executionInstances).where(eq(executionInstances.id, instance.id));
    await db.delete(workflowVersions).where(eq(workflowVersions.id, version.id));
    await db.delete(workflows).where(eq(workflows.id, workflow.id));
    await db.delete(creators).where(eq(creators.id, creator.id));
    await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
    await new Promise<void>((r) => server.close(() => r()));
  };

  try {
    // ── 1 + 2. CONCURRENCY: two parallel commission creations → ONE payout ─────
    // Fire both against the REAL Neon DB (two connections) at once. Exactly one
    // wins the FOR UPDATE lock and creates a payout; the other finds nothing
    // unpaid and rejects. This is the guarantee PGlite's single connection can't
    // demonstrate.
    const results = await Promise.allSettled([
      createCommissionPayout(partnership.id, { method: "PAYPAL", destination: "casey@paypal.me" }),
      createCommissionPayout(partnership.id, { method: "PAYPAL", destination: "casey@paypal.me" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one concurrent commission-create succeeds");
    assert.equal(rejected.length, 1, "the other rejects (no unpaid commission left)");

    const commissionPayoutRows = await db.select().from(payouts).where(eq(payouts.partnershipId, partnership.id));
    assert.equal(commissionPayoutRows.length, 1, "exactly ONE payout row exists after concurrent creates");
    const commissionPayout = commissionPayoutRows[0]!;
    assert.equal(commissionPayout.amountCents, 1200, "sum of the two unpaid conversions (500 + 700), refunded excluded");
    assert.equal(commissionPayout.conversionCount, 2);
    assert.equal(commissionPayout.method, "PAYPAL");
    assert.equal(commissionPayout.destination, "casey@paypal.me");
    console.log("  ✓ concurrency: two parallel commission creates → exactly one payout ($12.00, refunded excluded)");

    // The two eligible conversions are now locked into this payout; refunded one isn't.
    const lockedConvs = await db.select().from(conversions).where(eq(conversions.partnershipId, partnership.id));
    const locked = lockedConvs.filter((c) => c.payoutId === commissionPayout.id);
    assert.equal(locked.length, 2, "both eligible conversions locked into the payout");
    console.log("  ✓ conversions locked into the payout (payoutId set)");

    // ── 3. Fixed-fee payout via HTTP ───────────────────────────────────────────
    const feeRes = await fetch(`${origin}/payouts/obligations/${obligation.id}/fixed-fee`, { method: "POST" });
    assert.equal(feeRes.status, 201, "fixed-fee create returns 201");
    const feePayout = (await feeRes.json()) as { id: string; amountCents: number; payoutType: string };
    assert.equal(feePayout.payoutType, "FIXED_FEE");
    assert.equal(feePayout.amountCents, 42000);
    const obAfter = (await db.select().from(obligations).where(eq(obligations.id, obligation.id)))[0]!;
    assert.equal(obAfter.status, "PAID", "obligation flipped PAID");
    assert.equal(obAfter.payoutId, feePayout.id);
    console.log("  ✓ fixed-fee payout ($420.00) pays the obligation → PAID");

    // Double-pay the obligation → 400 with current status.
    const dupRes = await fetch(`${origin}/payouts/obligations/${obligation.id}/fixed-fee`, { method: "POST" });
    assert.equal(dupRes.status, 400, "second fixed-fee create on a PAID obligation is 400");
    console.log("  ✓ fixed-fee double-pay blocked (400, status PAID)");

    // ── 4. Mark the COMMISSION payout sent → token minted + email sent ─────────
    const sendRes = await fetch(`${origin}/payouts/${commissionPayout.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "PP-TXN-123" }),
    });
    assert.equal(sendRes.status, 200, "mark-sent returns 200");
    const sendBody = (await sendRes.json()) as { status: string; emailSent: boolean };
    assert.equal(sendBody.status, "SENT");
    assert.equal(sendBody.emailSent, true, "the sent email went out (mock provider)");

    const sentRow = await findPayoutById(commissionPayout.id);
    assert.ok(sentRow!.confirmTokenHash, "a confirm-token HASH is stored");
    assert.equal(sentRow!.confirmTokenHash!.length, 64, "stored value is a sha256 hex hash, not a raw token");
    assert.ok(sentRow!.confirmTokenExpiresAt, "token expiry stamped");
    assert.equal(sentRow!.reference, "PP-TXN-123");
    console.log("  ✓ mark-sent: SENT + sha256 token hash + expiry + reference; email sent");

    // Recover the raw token from the persisted email body (the outbox).
    const outbox1 = await listMessagesByInstance(instance.id);
    const sentEmail = outbox1.find((m) => m.direction === "OUTBOUND" && (m.idempotencyKey ?? "").startsWith(`payout:sent:${commissionPayout.id}`));
    assert.ok(sentEmail, "the payout-sent email is persisted as an OUTBOUND message");
    assert.ok(sentEmail!.body.includes("$12.00"), "email states the amount");
    assert.ok(sentEmail!.body.includes("PP-TXN-123"), "email states the reference");
    const confirmToken = tokenFromBody(sentEmail!.body, "confirm");
    const disputeToken = tokenFromBody(sentEmail!.body, "dispute");
    assert.equal(confirmToken, disputeToken, "the same raw token backs both links");
    assert.notEqual(confirmToken, sentRow!.confirmTokenHash, "the raw token is NOT the stored hash");
    console.log("  ✓ raw token recovered from the email outbox (never stored in the DB)");

    // ── 5. GET interstitial MUTATES NOTHING (I-5) ──────────────────────────────
    const before = await findPayoutById(commissionPayout.id);
    // Simulate mail-scanner prefetch: two GETs of BOTH links.
    for (const action of ["confirm", "dispute"] as const) {
      const g1 = await fetch(`${origin}/payout/${action}/${commissionPayout.id}?token=${confirmToken}`);
      assert.equal(g1.status, 200, `GET ${action} interstitial renders 200`);
      const html = await g1.text();
      assert.ok(/<form method="POST"/.test(html), `GET ${action} renders a POST form (button), not a mutation`);
      await fetch(`${origin}/payout/${action}/${commissionPayout.id}?token=${confirmToken}`); // second prefetch
    }
    const after = await findPayoutById(commissionPayout.id);
    assert.equal(after!.status, before!.status, "status unchanged by GETs");
    assert.equal(after!.status, "SENT", "still SENT after four GETs");
    assert.equal(after!.confirmedAt, before!.confirmedAt, "confirmedAt unchanged");
    assert.equal(after!.disputedAt, before!.disputedAt, "disputedAt unchanged");
    assert.equal(after!.settledAt, before!.settledAt, "settledAt unchanged");
    console.log("  ✓ I-5: GET interstitial (×4, both links) mutated nothing — still SENT");

    // Token tamper: a wrong token 404s on GET.
    const tamperRes = await fetch(`${origin}/payout/confirm/${commissionPayout.id}?token=deadbeef`);
    assert.equal(tamperRes.status, 404, "a tampered token GET 404s");
    console.log("  ✓ token tamper: wrong token → 404 (no detail)");

    // ── 6. POST confirm → SETTLED + events ─────────────────────────────────────
    const confirmRes = await fetch(`${origin}/payout/confirm/${commissionPayout.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      body: new URLSearchParams({ token: confirmToken }).toString(),
    });
    assert.equal(confirmRes.status, 200, "POST confirm renders 200");
    const confirmedRow = await findPayoutById(commissionPayout.id);
    assert.equal(confirmedRow!.status, "SETTLED", "confirm short-circuits to SETTLED");
    assert.ok(confirmedRow!.confirmedAt && confirmedRow!.settledAt, "confirmedAt + settledAt stamped");
    assert.equal(confirmedRow!.confirmIp, "203.0.113.7", "first x-forwarded-for hop captured");

    const confEvents = await listEventsByInstance(instance.id);
    assert.ok(confEvents.some((e) => e.type === "PAYOUT_CONFIRMED"), "PAYOUT_CONFIRMED event recorded");
    assert.ok(confEvents.some((e) => e.type === "PAYOUT_SETTLED"), "PAYOUT_SETTLED event recorded");
    console.log("  ✓ POST confirm → SETTLED, confirmIp captured, CONFIRMED + SETTLED events");

    // Reuse: the confirm link after settling is a safe idempotent notice (not 500).
    const reuseRes = await fetch(`${origin}/payout/confirm/${commissionPayout.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: confirmToken }).toString(),
    });
    assert.equal(reuseRes.status, 200, "reused confirm link is a safe no-op notice");
    const reuseHtml = await reuseRes.text();
    assert.ok(/Nothing to do|already/i.test(reuseHtml), "reuse shows the already-actioned notice");
    console.log("  ✓ token reuse after settle: safe idempotent notice");

    // ── 7. DISPUTE loop on the FIXED-FEE payout → brand email ──────────────────
    const sendFeeRes = await fetch(`${origin}/payouts/${feePayout.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "PP-TXN-FEE" }),
    });
    assert.equal(sendFeeRes.status, 200);
    const feeOutbox = await listMessagesByInstance(instance.id);
    const feeSentEmail = feeOutbox.find((m) => (m.idempotencyKey ?? "").startsWith(`payout:sent:${feePayout.id}`));
    assert.ok(feeSentEmail, "fixed-fee payout-sent email persisted");
    const feeDisputeToken = tokenFromBody(feeSentEmail!.body, "dispute");

    const disputeRes = await fetch(`${origin}/payout/dispute/${feePayout.id}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "HarnessAgent/1.0" },
      body: new URLSearchParams({ token: feeDisputeToken }).toString(),
    });
    assert.equal(disputeRes.status, 200, "POST dispute renders 200");
    const disputedRow = await findPayoutById(feePayout.id);
    assert.equal(disputedRow!.status, "DISPUTED");
    assert.ok(disputedRow!.disputedAt, "disputedAt stamped");
    assert.equal(disputedRow!.confirmUserAgent, "HarnessAgent/1.0", "user-agent captured on dispute");

    const disputeEvents = await listEventsByInstance(instance.id);
    assert.ok(disputeEvents.some((e) => e.type === "PAYOUT_DISPUTED"), "PAYOUT_DISPUTED event recorded");

    // The brand dispute email was persisted (keyed payout:disputed:{id}).
    const afterDisputeOutbox = await listMessagesByInstance(instance.id);
    const disputeEmail = afterDisputeOutbox.find((m) => (m.idempotencyKey ?? "") === `payout:disputed:${feePayout.id}`);
    assert.ok(disputeEmail, "a brand dispute email was sent");
    assert.ok(/^\[DISPUTE\]/.test(disputeEmail!.subject ?? ""), "dispute email subject is a [DISPUTE] alert");
    assert.ok((disputeEmail!.body ?? "").includes("$420.00"), "dispute email states the amount");
    console.log("  ✓ POST dispute → DISPUTED, UA captured, DISPUTED event, brand notified");

    // ── 8. Brand settle resolves the dispute ──────────────────────────────────
    const settleRes = await fetch(`${origin}/payouts/${feePayout.id}/settle`, { method: "POST" });
    assert.equal(settleRes.status, 200, "brand settle of a DISPUTED payout returns 200");
    const settledRow = await findPayoutById(feePayout.id);
    assert.equal(settledRow!.status, "SETTLED", "disputed payout resolved to SETTLED by the brand");
    console.log("  ✓ brand settle: DISPUTED → SETTLED");

    // ── 9. Auto-settle sweep: a SENT payout with no response settles ───────────
    // Seed a fresh obligation → fixed-fee payout, mark it sent, backdate sentAt
    // beyond the cutoff, then run the scheduler sweep and assert it settles with
    // an { auto: true } event (I-7). Proves the background settle path (NOT a
    // lazy GET-time settle).
    const sweepOb = (
      await db.insert(obligations).values({ partnershipId: partnership.id, description: "Sweep fee", amountCents: 5000, status: "PENDING" }).returning()
    )[0]!;
    const sweepRes = await fetch(`${origin}/payouts/obligations/${sweepOb.id}/fixed-fee`, { method: "POST" });
    const sweepPayout = (await sweepRes.json()) as { id: string };
    await fetch(`${origin}/payouts/${sweepPayout.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "PP-SWEEP" }),
    });
    // Backdate sentAt to 30 days ago so it is well past the auto-settle cutoff.
    await db.update(payouts).set({ sentAt: new Date(Date.now() - 30 * 864e5) }).where(eq(payouts.id, sweepPayout.id));

    const { sweepAutoSettlePayouts } = await import("../scheduler/payoutSweep.js");
    const settledCount = await sweepAutoSettlePayouts();
    assert.ok(settledCount >= 1, "the sweep settled at least the backdated payout");
    const sweptRow = await findPayoutById(sweepPayout.id);
    assert.equal(sweptRow!.status, "SETTLED", "auto-settle sweep flipped the stale SENT payout to SETTLED");
    assert.ok(sweptRow!.settledAt, "settledAt stamped by the sweep");
    const autoEvents = await listEventsByInstance(instance.id);
    assert.ok(
      autoEvents.some((e) => e.type === "PAYOUT_SETTLED" && (e.payload as { auto?: boolean } | null)?.auto === true),
      "a PAYOUT_SETTLED { auto: true } event was recorded",
    );
    console.log("  ✓ auto-settle sweep: stale SENT payout → SETTLED with { auto: true } event");

    console.log("\nAll payout ledger checks passed ✓\n");
  } finally {
    await cleanup();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Payout ledger harness failed:", err);
  process.exit(1);
});
