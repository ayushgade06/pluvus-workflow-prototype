import { Router } from "express";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  campaigns,
  clicks,
  conversions,
  creators,
  partnerships,
} from "../db/schema.js";
import { listPartnerships, partnershipMetrics } from "../db/index.js";

// ---------------------------------------------------------------------------
// Partnerships read API (brand-side, unauthenticated — repo convention)
//
// GET /partnerships      → list all partnerships with metrics
// GET /partnerships/:id  → single partnership with creator, campaign, metrics,
//                          recent conversions + clicks (cap 100 each)
// ---------------------------------------------------------------------------

const router = Router();

// GET /partnerships
router.get("/", async (_req: Request, res: Response) => {
  const rows = await listPartnerships();

  const withMetrics = await Promise.all(
    rows.map(async (p) => {
      const metrics = await partnershipMetrics(p.id);
      return { ...p, metrics };
    }),
  );

  res.json(withMetrics);
});

// GET /partnerships/:id
router.get("/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const rows = await db
    .select({
      partnership: partnerships,
      creator: { id: creators.id, name: creators.name, email: creators.email, handle: creators.handle, platform: creators.platform },
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

  const [metrics, recentConversions, recentClicks] = await Promise.all([
    partnershipMetrics(id),
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
    campaign: campaignName ? { name: campaignName, brand: campaignBrand, targetUrl } : null,
    metrics,
    recentConversions,
    recentClicks,
  });
});

export default router;
