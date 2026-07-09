import { Router } from "express";
import type { Request, Response } from "express";
import {
  listCampaigns,
  createCampaign,
  updateCampaign,
  getCampaignWithWorkflows,
  findCampaignById,
  deleteCampaign,
} from "../db/campaigns.js";
import {
  createWorkflow,
  updateWorkflow,
} from "../db/workflows.js";
import { getTemplate } from "../templates/index.js";

const router = Router();

// GET /campaigns — list all campaigns with workflow counts
router.get("/", async (_req: Request, res: Response) => {
  try {
    const campaigns = await listCampaigns();
    res.json(
      campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        brand: c.brand,
        objective: c.objective,
        notes: c.notes,
        notifyEmail: c.notifyEmail,
        brandDescription: c.brandDescription,
        deliverables: c.deliverables,
        timeline: c.timeline,
        rewardDescription: c.rewardDescription,
        shipsPhysicalProduct: c.shipsPhysicalProduct,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        workflowCount: c._count.workflows,
      })),
    );
  } catch (err) {
    console.error("[campaigns] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// Lightweight email shape check — good enough to reject obvious typos without
// pulling in a validation lib. The notifyEmail is optional; only validated when
// a non-empty value is supplied.
function isEmailish(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// POST /campaigns — create a campaign
router.post("/", async (req: Request, res: Response) => {
  const {
    name,
    brand,
    objective,
    notes,
    notifyEmail,
    brandDescription,
    deliverables,
    timeline,
    rewardDescription,
    shipsPhysicalProduct,
    usageRights,
    exclusivity,
    paymentTerms,
    attributionWindow,
  } = req.body as {
    name?: string;
    brand?: string;
    objective?: string;
    notes?: string;
    notifyEmail?: string;
    brandDescription?: string;
    deliverables?: string;
    timeline?: string;
    rewardDescription?: string;
    shipsPhysicalProduct?: boolean;
    // HARD-K1 knowledge fields.
    usageRights?: string;
    exclusivity?: string;
    paymentTerms?: string;
    attributionWindow?: string;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!brand || typeof brand !== "string" || !brand.trim()) {
    res.status(400).json({ error: "brand is required" });
    return;
  }
  const trimmedNotify =
    typeof notifyEmail === "string" ? notifyEmail.trim() : "";
  if (trimmedNotify && !isEmailish(trimmedNotify)) {
    res.status(400).json({ error: "notifyEmail must be a valid email address" });
    return;
  }

  try {
    const campaign = await createCampaign({
      name: name.trim(),
      brand: brand.trim(),
      objective: typeof objective === "string" ? objective.trim() || null : null,
      notes: typeof notes === "string" ? notes.trim() || null : null,
      notifyEmail: trimmedNotify || null,
      brandDescription: typeof brandDescription === "string" ? brandDescription.trim() || null : null,
      deliverables: typeof deliverables === "string" ? deliverables.trim() || null : null,
      timeline: typeof timeline === "string" ? timeline.trim() || null : null,
      rewardDescription:
        typeof rewardDescription === "string" ? rewardDescription.trim() || null : null,
      shipsPhysicalProduct: shipsPhysicalProduct === true,
      // HARD-K1 knowledge fields — stated as fact by the agent when the creator
      // asks, deferred honestly when blank.
      usageRights: typeof usageRights === "string" ? usageRights.trim() || null : null,
      exclusivity: typeof exclusivity === "string" ? exclusivity.trim() || null : null,
      paymentTerms: typeof paymentTerms === "string" ? paymentTerms.trim() || null : null,
      attributionWindow:
        typeof attributionWindow === "string" ? attributionWindow.trim() || null : null,
    });
    res.status(201).json({
      id: campaign.id,
      name: campaign.name,
      brand: campaign.brand,
      objective: campaign.objective,
      notes: campaign.notes,
      notifyEmail: campaign.notifyEmail,
      brandDescription: campaign.brandDescription,
      deliverables: campaign.deliverables,
      timeline: campaign.timeline,
      rewardDescription: campaign.rewardDescription,
      shipsPhysicalProduct: campaign.shipsPhysicalProduct,
      usageRights: campaign.usageRights,
      exclusivity: campaign.exclusivity,
      paymentTerms: campaign.paymentTerms,
      attributionWindow: campaign.attributionWindow,
      createdAt: campaign.createdAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] create error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// GET /campaigns/:id — campaign detail with workflows
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const campaign = await getCampaignWithWorkflows(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    res.json({
      id: campaign.id,
      name: campaign.name,
      brand: campaign.brand,
      objective: campaign.objective,
      notes: campaign.notes,
      notifyEmail: campaign.notifyEmail,
      brandDescription: campaign.brandDescription,
      deliverables: campaign.deliverables,
      timeline: campaign.timeline,
      rewardDescription: campaign.rewardDescription,
      shipsPhysicalProduct: campaign.shipsPhysicalProduct,
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
      workflows: campaign.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        versionCount: w._count.versions,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[campaigns] get error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// POST /campaigns/:id/workflows — create a workflow under a campaign
router.post("/:id/workflows", async (req: Request, res: Response) => {
  const { name, templateKey } = req.body as {
    name?: string;
    templateKey?: string;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!templateKey || typeof templateKey !== "string") {
    res.status(400).json({ error: "templateKey is required" });
    return;
  }

  const template = getTemplate(templateKey);
  if (!template) {
    res.status(400).json({
      error: `unknown templateKey '${templateKey}'. Valid keys: affiliate, hybrid, fixed_fee`,
    });
    return;
  }

  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }

    // Stamp brandName/senderName into every node's config so {{brandName}}
    // resolves correctly when draft() is called at send time.
    const nodes = (JSON.parse(JSON.stringify(template.nodes)) as typeof template.nodes).map(
      (node) => ({
        ...node,
        config: {
          brandName: campaign.brand,
          senderName: campaign.brand,
          ...(campaign.brandDescription ? { brandDescription: campaign.brandDescription } : {}),
          ...(campaign.deliverables ? { deliverables: campaign.deliverables } : {}),
          ...(campaign.timeline ? { timeline: campaign.timeline } : {}),
          ...(campaign.rewardDescription ? { rewardDescription: campaign.rewardDescription } : {}),
          ...(campaign.shipsPhysicalProduct ? { shipsPhysicalProduct: true } : {}),
          ...node.config,
        },
      }),
    );

    const workflow = await createWorkflow({
      name: name.trim(),
      status: "DRAFT",
      draftNodes: nodes,
      campaign: { connect: { id: campaign.id } },
    });

    res.status(201).json({
      id: workflow.id,
      name: workflow.name,
      status: workflow.status,
      campaignId: workflow.campaignId,
      templateKey,
      draftNodes: workflow.draftNodes,
      createdAt: workflow.createdAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] create workflow error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// PATCH /campaigns/:id — update editable campaign fields (notifyEmail, etc.)
router.patch("/:id", async (req: Request, res: Response) => {
  const {
    notifyEmail,
    objective,
    notes,
    brandDescription,
    deliverables,
    timeline,
    rewardDescription,
    shipsPhysicalProduct,
  } = req.body as {
    notifyEmail?: string | null;
    objective?: string | null;
    notes?: string | null;
    brandDescription?: string | null;
    deliverables?: string | null;
    timeline?: string | null;
    rewardDescription?: string | null;
    shipsPhysicalProduct?: boolean;
  };

  const patch: Parameters<typeof updateCampaign>[1] = {};

  if (notifyEmail !== undefined) {
    const trimmed = typeof notifyEmail === "string" ? notifyEmail.trim() : "";
    if (trimmed && !isEmailish(trimmed)) {
      res.status(400).json({ error: "notifyEmail must be a valid email address" });
      return;
    }
    patch.notifyEmail = trimmed || null;
  }
  if (objective !== undefined) {
    patch.objective = typeof objective === "string" ? objective.trim() || null : null;
  }
  if (notes !== undefined) {
    patch.notes = typeof notes === "string" ? notes.trim() || null : null;
  }
  if (brandDescription !== undefined) {
    patch.brandDescription = typeof brandDescription === "string" ? brandDescription.trim() || null : null;
  }
  if (deliverables !== undefined) {
    patch.deliverables = typeof deliverables === "string" ? deliverables.trim() || null : null;
  }
  if (timeline !== undefined) {
    patch.timeline = typeof timeline === "string" ? timeline.trim() || null : null;
  }
  if (rewardDescription !== undefined) {
    patch.rewardDescription =
      typeof rewardDescription === "string" ? rewardDescription.trim() || null : null;
  }
  if (shipsPhysicalProduct !== undefined) {
    patch.shipsPhysicalProduct = shipsPhysicalProduct === true;
  }

  try {
    const existing = await findCampaignById(req.params["id"]!);
    if (!existing) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    const campaign = await updateCampaign(req.params["id"]!, patch);
    res.json({
      id: campaign.id,
      name: campaign.name,
      brand: campaign.brand,
      objective: campaign.objective,
      notes: campaign.notes,
      notifyEmail: campaign.notifyEmail,
      brandDescription: campaign.brandDescription,
      deliverables: campaign.deliverables,
      timeline: campaign.timeline,
      rewardDescription: campaign.rewardDescription,
      shipsPhysicalProduct: campaign.shipsPhysicalProduct,
      updatedAt: campaign.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[campaigns] update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// DELETE /campaigns/:id — delete a campaign and all its workflows/instances
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const campaign = await findCampaignById(req.params["id"]!);
    if (!campaign) {
      res.status(404).json({ error: "campaign not found" });
      return;
    }
    await deleteCampaign(req.params["id"]!);
    res.status(204).send();
  } catch (err) {
    console.error("[campaigns] delete error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
