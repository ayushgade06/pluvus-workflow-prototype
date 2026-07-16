import { Router } from "express";
import type { Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  campaigns,
  clicks,
  conversions,
  creators,
  executionInstances,
  partnerships,
  workflowVersions,
  workflows,
} from "../db/schema.js";
import {
  listPartnerships,
  partnershipMetrics,
  payoutRollupForPartnerships,
  findPaymentInfoSummaryByInstance,
  findPartnershipByInstance,
  createPartnership,
  generateReferralCode,
  isUniqueViolation,
  listEventsByInstance,
} from "../db/index.js";
import { buildTrackingLink, mintFeeObligation } from "../engine/executors/partnership.js";
import { resolveAgreedFee, firstNumber } from "../engine/executors/agreedFee.js";

// ---------------------------------------------------------------------------
// Partnerships read API (brand-side, unauthenticated — repo convention)
//
// GET /partnerships                       — list all partnerships with metrics + payout rollup
// GET /partnerships/:id                   — single partnership detail with full rollup
// POST /partnerships/backfill/:instanceId — mint a missing partnership for a terminal instance
// ---------------------------------------------------------------------------

const router = Router();

// ── GET /partnerships ────────────────────────────────────────────────────────
// Returns all partnerships with per-partnership metrics AND payout rollup in
// two grouped queries (no N+1). The list endpoint intentionally does NOT fetch
// per-row obligations/payouts — that data lives in the detail endpoint.
router.get("/", async (_req: Request, res: Response) => {
  const rows = await listPartnerships();

  if (rows.length === 0) {
    res.json([]);
    return;
  }

  const ids = rows.map((p) => p.id);

  // Parallel: per-partnership metrics (2 queries, both grouped) + rollup (3 queries).
  // partnershipMetrics runs N queries — we batch it into one grouped call here.
  const [metricsMap, rollupMap] = await Promise.all([
    batchPartnershipMetrics(ids),
    payoutRollupForPartnerships(ids),
  ]);

  const withData = rows.map((p) => ({
    ...p,
    metrics: metricsMap.get(p.id) ?? emptyMetrics(),
    rollup: rollupMap.get(p.id) ?? emptyRollup(),
  }));

  res.json(withData);
});

// ── GET /partnerships/:id ────────────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const rows = await db
    .select({
      partnership: partnerships,
      creator: {
        id: creators.id,
        name: creators.name,
        email: creators.email,
        handle: creators.handle,
        platform: creators.platform,
      },
      campaignName: campaigns.name,
      campaignBrand: campaigns.brand,
      targetUrl: campaigns.targetUrl,
    })
    .from(partnerships)
    .innerJoin(creators, eq(partnerships.creatorId, creators.id))
    .leftJoin(campaigns, eq(partnerships.campaignId, campaigns.id))
    .where(eq(partnerships.id, id))
    .limit(1);

  if (!rows[0]) {
    res.status(404).json({ error: "Partnership not found" });
    return;
  }

  const { partnership, creator, campaignName, campaignBrand, targetUrl } = rows[0];

  const [metrics, rollupMap, paymentInfoSummary, recentConversions, recentClicks] =
    await Promise.all([
      partnershipMetrics(id),
      payoutRollupForPartnerships([id]),
      findPaymentInfoSummaryByInstance(partnership.instanceId),
      db
        .select()
        .from(conversions)
        .where(eq(conversions.partnershipId, id))
        .orderBy(conversions.attributedAt)
        .limit(100),
      db
        .select()
        .from(clicks)
        .where(eq(clicks.partnershipId, id))
        .orderBy(clicks.clickedAt)
        .limit(100),
    ]);

  res.json({
    ...partnership,
    creator,
    campaign: campaignName
      ? { name: campaignName, brand: campaignBrand, targetUrl }
      : null,
    metrics,
    rollup: rollupMap.get(id) ?? emptyRollup(),
    paymentInfo: paymentInfoSummary,
    recentConversions,
    recentClicks,
  });
});

// ── POST /partnerships/backfill/:instanceId ──────────────────────────────────
// Mint a missing Partnership for a terminal instance (CONTENT_BRIEF_SENT) that
// completed before Phase 1 deployed or whose mint failed. Idempotent: if a
// partnership already exists for the instance, returns it unchanged.
router.post("/backfill/:instanceId", async (req: Request, res: Response) => {
  const { instanceId } = req.params as { instanceId: string };

  // Guard: the instance must exist.
  const instRows = await db
    .select()
    .from(executionInstances)
    .where(eq(executionInstances.id, instanceId))
    .limit(1);
  const instance = instRows[0];
  if (!instance) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  // Already has a partnership — return it (idempotent).
  const existing = await findPartnershipByInstance(instanceId);
  if (existing) {
    res.json({ partnership: existing, created: false });
    return;
  }

  // Require terminal state.
  if (instance.currentState !== "CONTENT_BRIEF_SENT") {
    res.status(400).json({
      error: `Instance is not terminal (state: ${instance.currentState}). Only CONTENT_BRIEF_SENT instances can be backfilled.`,
    });
    return;
  }

  // Load the creator (for referral code generation).
  const creatorRows = await db
    .select()
    .from(creators)
    .where(eq(creators.id, instance.creatorId))
    .limit(1);
  const creator = creatorRows[0];
  if (!creator) {
    res.status(422).json({ error: "Creator not found for this instance" });
    return;
  }

  // Load the workflow version + campaign (via workflow) for tracking link + commission rate.
  let campaign: typeof campaigns.$inferSelect | null = null;
  let nodeGraph: Array<{ type: string; config: Record<string, unknown> }> = [];

  const versionRows = await db
    .select({
      nodeGraph: workflowVersions.nodeGraph,
      campaignId: workflows.campaignId,
    })
    .from(workflowVersions)
    .leftJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .where(eq(workflowVersions.id, instance.workflowVersionId))
    .limit(1);

  const versionRow = versionRows[0];
  if (versionRow) {
    const ng = versionRow.nodeGraph;
    if (Array.isArray(ng)) nodeGraph = ng as typeof nodeGraph;

    if (versionRow.campaignId) {
      const campRows = await db
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, versionRow.campaignId))
        .limit(1);
      campaign = campRows[0] ?? null;
    }
  }

  // Recover money terms from PAYMENT_INFO_SENT event (I-2), falling back to config.
  let fixedFee: number | undefined;
  let commissionRate: number | undefined;

  const paymentInfoEvents = await listEventsByInstance(instanceId, {
    type: "PAYMENT_INFO_SENT",
  });
  const piEvent = paymentInfoEvents[0];
  if (piEvent?.payload && typeof piEvent.payload === "object" && !Array.isArray(piEvent.payload)) {
    const p = piEvent.payload as Record<string, unknown>;
    if (typeof p["fixedFee"] === "number") fixedFee = p["fixedFee"] as number;
    if (typeof p["commission"] === "number") commissionRate = p["commission"] as number;
  }
  if (fixedFee === undefined) {
    const negotiationConfig = nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
    const events = await listEventsByInstance(instanceId, { type: "NEGOTIATION_TURN" });
    fixedFee = resolveAgreedFee(events, negotiationConfig, {});
  }
  if (commissionRate === undefined) {
    const negotiationConfig = nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};
    const cbConfig = nodeGraph.find((n) => n.type === "CONTENT_BRIEF")?.config ?? {};
    commissionRate = firstNumber(cbConfig["commissionRate"], negotiationConfig["commissionRate"]);
  }

  const agreedFeeCents = fixedFee !== undefined ? Math.round(fixedFee * 100) : null;
  const targetUrl = campaign?.targetUrl ?? null;
  const hiddenParamKey = campaign?.hiddenParamKey ?? "_from";

  // Mint with referral-code collision retry (same recipe as mintWithRetry in partnership.ts).
  const MAX_ATTEMPTS = 5;
  let partnership: typeof partnerships.$inferSelect;
  let minted = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateReferralCode(creator.name);
    const trackingLink = buildTrackingLink(targetUrl, hiddenParamKey, code);
    try {
      partnership = await createPartnership({
        instanceId,
        campaignId: versionRow?.campaignId ?? null,
        creatorId: creator.id,
        referralCode: code,
        trackingLink,
        commissionRate: commissionRate ?? null,
        agreedFeeCents,
      });
      minted = true;
      break;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS - 1) continue;
      // Concurrent backfill — re-read.
      const reread = await findPartnershipByInstance(instanceId);
      if (reread) {
        res.json({ partnership: reread, created: false });
        return;
      }
      res.status(500).json({ error: "Partnership mint failed — check server logs" });
      return;
    }
  }

  if (!minted || !partnership!) {
    res.status(500).json({ error: "Exhausted referral code attempts" });
    return;
  }

  // Mint the fee obligation (idempotent, non-fatal).
  try {
    await mintFeeObligation(partnership!.id, partnership!.agreedFeeCents);
  } catch (err) {
    console.error("[backfill] fee obligation mint failed (non-fatal)", err);
  }

  res.status(201).json({ partnership: partnership!, created: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Metrics {
  clicks: number;
  conversions: number;
  revenueCents: number;
  earnedCents: number;
  unpaidCents: number;
  paidCents: number;
}

function emptyMetrics(): Metrics {
  return {
    clicks: 0,
    conversions: 0,
    revenueCents: 0,
    earnedCents: 0,
    unpaidCents: 0,
    paidCents: 0,
  };
}

import type { PayoutRollup } from "../db/partnerships.js";

function emptyRollup(): PayoutRollup {
  return {
    unpaidFeeCents: 0,
    unpaidCommissionCents: 0,
    inFlightCents: 0,
    settledCents: 0,
    hasDispute: false,
  };
}

/**
 * Batch metrics for a list of partnershipIds in 2 grouped queries (no N+1).
 * Mirrors the per-row logic in `partnershipMetrics` (conversions.ts) but runs
 * once for the whole list instead of once per row.
 */
async function batchPartnershipMetrics(
  ids: string[],
): Promise<Map<string, Metrics>> {
  if (ids.length === 0) return new Map();

  const [clickRows, convRows] = await Promise.all([
    db
      .select({
        partnershipId: clicks.partnershipId,
        n: sql<number>`count(*)`,
      })
      .from(clicks)
      .where(
        sql`${clicks.partnershipId} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .groupBy(clicks.partnershipId),

    db
      .select({
        partnershipId: conversions.partnershipId,
        conversions: sql<number>`count(*) filter (where ${conversions.refunded} = false)`,
        revenueCents: sql<number>`coalesce(sum(${conversions.valueCents}) filter (where ${conversions.refunded} = false), 0)`,
        earnedCents: sql<number>`coalesce(sum(${conversions.commissionCents}) filter (where ${conversions.refunded} = false), 0)`,
        unpaidCents: sql<number>`coalesce(sum(${conversions.commissionCents}) filter (where ${conversions.refunded} = false and ${conversions.payoutId} is null), 0)`,
        paidCents: sql<number>`coalesce(sum(${conversions.commissionCents}) filter (where ${conversions.refunded} = false and ${conversions.payoutId} is not null), 0)`,
      })
      .from(conversions)
      .where(
        sql`${conversions.partnershipId} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .groupBy(conversions.partnershipId),
  ]);

  const clickMap = new Map(clickRows.map((r) => [r.partnershipId, Number(r.n)]));
  const convMap = new Map(convRows.map((r) => [r.partnershipId, r]));

  const result = new Map<string, Metrics>();
  for (const id of ids) {
    const cv = convMap.get(id);
    result.set(id, {
      clicks: clickMap.get(id) ?? 0,
      conversions: Number(cv?.conversions ?? 0),
      revenueCents: Number(cv?.revenueCents ?? 0),
      earnedCents: Number(cv?.earnedCents ?? 0),
      unpaidCents: Number(cv?.unpaidCents ?? 0),
      paidCents: Number(cv?.paidCents ?? 0),
    });
  }
  return result;
}

export default router;
