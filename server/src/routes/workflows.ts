import { Router } from "express";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import {
  findWorkflowById,
  updateWorkflow,
  findLatestVersion,
  listVersions,
  createVersion,
  nextVersionNumber,
} from "../db/workflows.js";
import {
  listInstancesByVersion,
  createInstance,
  findInstanceByCreatorAndVersion,
} from "../db/instances.js";
import { listCreators } from "../db/creators.js";
import { findCampaignById } from "../db/campaigns.js";
import { prisma } from "../db/client.js";
import { enqueueNodeExecution } from "../workers/queues.js";
import { validateNodeGraph } from "../templates/index.js";

const router = Router();

// ---------------------------------------------------------------------------
// Re-stamp the campaign brand into node configs.
// ---------------------------------------------------------------------------
// brandName/senderName are stamped into every node config at workflow creation
// (see POST /campaigns/:id/workflows) so {{brandName}} resolves and the
// negotiation agent signs off as the brand rather than its "Pluvus
// Partnerships" fallback. The builder's per-node config forms send a fresh
// config object on save, which can drop those keys — so we re-inject them here
// on every draft save. Existing non-empty values are preserved (a deliberate
// per-node override is never clobbered); only missing/blank values are filled.
function restampBrand(
  nodes: unknown,
  brand: string,
  brandDescription?: string | null,
  deliverables?: string | null,
  timeline?: string | null,
  rewardDescription?: string | null,
  shipsPhysicalProduct?: boolean,
): unknown {
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { config?: unknown; [k: string]: unknown };
    const config = (n.config && typeof n.config === "object" ? n.config : {}) as Record<
      string,
      unknown
    >;
    const hasBrand = typeof config["brandName"] === "string" && config["brandName"] !== "";
    const hasSender = typeof config["senderName"] === "string" && config["senderName"] !== "";
    const hasDesc = typeof config["brandDescription"] === "string" && config["brandDescription"] !== "";
    // deliverables/timeline are re-injected so the Reward Setup node (and the
    // negotiation copy) reliably see the brand-supplied scope even after the
    // builder's per-node forms round-trip a config that dropped them.
    const hasDeliverables = typeof config["deliverables"] === "string" && config["deliverables"] !== "";
    const hasTimeline = typeof config["timeline"] === "string" && config["timeline"] !== "";
    // rewardDescription is a free-text blurb mentioned across the email copy;
    // preserve-if-present like the other campaign fields. shipsPhysicalProduct
    // is a boolean flag that gates the payment form's shipping-address section;
    // it is authoritative from the campaign, so it OVERWRITES every save (a node
    // can't meaningfully override "does this campaign ship a product").
    const hasReward =
      typeof config["rewardDescription"] === "string" && config["rewardDescription"] !== "";
    return {
      ...n,
      config: {
        ...config,
        ...(hasBrand ? {} : { brandName: brand }),
        ...(hasSender ? {} : { senderName: brand }),
        ...(hasDesc || !brandDescription ? {} : { brandDescription }),
        ...(hasDeliverables || !deliverables ? {} : { deliverables }),
        ...(hasTimeline || !timeline ? {} : { timeline }),
        ...(hasReward || !rewardDescription ? {} : { rewardDescription }),
        ...(shipsPhysicalProduct ? { shipsPhysicalProduct: true } : { shipsPhysicalProduct: false }),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Mirror the negotiation commission onto the Reward Setup node.
// ---------------------------------------------------------------------------
// The brand decides the commission % on the NEGOTIATION node. The Reward Setup
// node displays + emails the finalized commission, so it must always reflect the
// CURRENT negotiation value — not a stale copy. Unlike the brand fields above
// (preserve-if-present), this OVERWRITES the reward node's commissionRate every
// save so editing the negotiation node keeps the reward node in sync. Deliverables
// are already carried by restampBrand from the campaign; commission is the one
// field sourced from another node, so it's stamped here.
export function stampRewardFromNegotiation(nodes: unknown): unknown {
  if (!Array.isArray(nodes)) return nodes;

  const negotiation = nodes.find(
    (n): n is { type: string; config?: Record<string, unknown> } =>
      !!n && typeof n === "object" && (n as { type?: unknown }).type === "NEGOTIATION",
  );
  const negConfig = (negotiation?.config ?? {}) as Record<string, unknown>;
  const commission = negConfig["commissionRate"];
  // Only a positive number is a real commission; 0/absent means fixed-fee only,
  // in which case the reward node should carry no commissionRate.
  const hasCommission = typeof commission === "number" && commission > 0;

  return nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: unknown; config?: unknown; [k: string]: unknown };
    if (n.type !== "REWARD_SETUP") return node;
    const config = (n.config && typeof n.config === "object" ? n.config : {}) as Record<
      string,
      unknown
    >;
    // Drop any stale commissionRate, then set it iff the negotiation has one.
    const { commissionRate: _drop, ...rest } = config;
    return {
      ...n,
      config: {
        ...rest,
        ...(hasCommission ? { commissionRate: commission } : {}),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// GET /workflows/:id — workflow detail with draftNodes + latest version
// ---------------------------------------------------------------------------

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const wf = await prisma.workflow.findUnique({
      where: { id: req.params["id"]! },
      include: {
        campaign: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = wf.versions[0] ?? null;

    res.json({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      status: wf.status,
      campaignId: wf.campaignId,
      campaign: wf.campaign
        ? { id: wf.campaign.id, name: wf.campaign.name, brand: wf.campaign.brand }
        : null,
      draftNodes: wf.draftNodes ?? [],
      latestVersion: latestVersion
        ? {
            id: latestVersion.id,
            version: latestVersion.version,
            publishedAt: latestVersion.publishedAt.toISOString(),
          }
        : null,
      createdAt: wf.createdAt.toISOString(),
      updatedAt: wf.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[workflows] get error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /workflows/:id/metadata — update name / description
// ---------------------------------------------------------------------------

router.put("/:id/metadata", async (req: Request, res: Response) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    const updated = await updateWorkflow(wf.id, {
      name: name.trim(),
      ...(description !== undefined
        ? { description: typeof description === "string" ? description.trim() || null : null }
        : {}),
    });
    res.json({ id: updated.id, name: updated.name, description: updated.description });
  } catch (err) {
    console.error("[workflows] metadata update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /workflows/:id/draft — replace the full draftNodes array
// ---------------------------------------------------------------------------

router.put("/:id/draft", async (req: Request, res: Response) => {
  const { nodes } = req.body as { nodes?: unknown };

  const validation = validateNodeGraph(nodes);
  // For draft saves we allow partial/empty graphs (soft validation warnings only).
  // We just store what the builder sends as-is unless it's malformed JSON.
  if (!Array.isArray(nodes)) {
    res.status(400).json({ error: "nodes must be an array" });
    return;
  }

  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    // Re-inject the campaign brand into node configs so it survives builder
    // edits (the per-node forms can drop brandName/senderName on save).
    let nodesToSave: unknown = nodes;
    if (wf.campaignId) {
      const campaign = await findCampaignById(wf.campaignId);
      if (campaign)
        nodesToSave = restampBrand(
          nodes,
          campaign.brand,
          campaign.brandDescription,
          campaign.deliverables,
          campaign.timeline,
          campaign.rewardDescription,
          campaign.shipsPhysicalProduct,
        );
    }
    // Mirror the brand's negotiation commission onto the Reward Setup node so the
    // builder + runtime always show the current value (independent of campaign).
    nodesToSave = stampRewardFromNegotiation(nodesToSave);

    const updated = await updateWorkflow(wf.id, {
      draftNodes: nodesToSave as Prisma.InputJsonValue,
    });

    res.json({
      id: updated.id,
      draftNodes: updated.draftNodes,
      valid: validation.valid,
      validationErrors: validation.errors,
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    console.error("[workflows] draft update error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/validate — validate draftNodes without publishing
// ---------------------------------------------------------------------------

router.post("/:id/validate", async (req: Request, res: Response) => {
  try {
    const wf = await prisma.workflow.findUnique({
      where: { id: req.params["id"]! },
      select: { id: true, draftNodes: true },
    });
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
    const validation = validateNodeGraph(wf.draftNodes);
    res.json({ valid: validation.valid, errors: validation.errors });
  } catch (err) {
    console.error("[workflows] validate error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/publish — create an immutable WorkflowVersion
// ---------------------------------------------------------------------------

router.post("/:id/publish", async (req: Request, res: Response) => {
  const { notes } = req.body as { notes?: string };

  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const validation = validateNodeGraph(wf.draftNodes);
    if (!validation.valid) {
      res.status(422).json({
        error: "workflow has validation errors",
        validationErrors: validation.errors,
      });
      return;
    }

    // Re-stamp brand fields (including brandDescription) at publish time so the
    // immutable snapshot always carries the campaign's brand context even if the
    // builder's draft-save didn't stamp it (e.g. workflows created before
    // brandDescription was added, or configs edited in the builder).
    let nodeGraphToPublish: Prisma.InputJsonValue = wf.draftNodes as Prisma.InputJsonValue;
    if (wf.campaignId) {
      const campaign = await findCampaignById(wf.campaignId);
      if (campaign) {
        nodeGraphToPublish = restampBrand(
          wf.draftNodes,
          campaign.brand,
          campaign.brandDescription,
          campaign.deliverables,
          campaign.timeline,
          campaign.rewardDescription,
          campaign.shipsPhysicalProduct,
        ) as Prisma.InputJsonValue;
      }
    }
    // Freeze the current negotiation commission onto the Reward Setup node so the
    // immutable version carries the finalized value the deal was published with.
    nodeGraphToPublish = stampRewardFromNegotiation(
      nodeGraphToPublish,
    ) as Prisma.InputJsonValue;

    const versionNumber = await nextVersionNumber(wf.id);
    const version = await createVersion({
      version: versionNumber,
      nodeGraph: nodeGraphToPublish,
      publishedAt: new Date(),
      workflow: { connect: { id: wf.id } },
    });

    await updateWorkflow(wf.id, { status: "PUBLISHED" });

    res.status(201).json({
      versionId: version.id,
      version: version.version,
      publishedAt: version.publishedAt.toISOString(),
      notes: notes ?? null,
    });
  } catch (err) {
    console.error("[workflows] publish error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /workflows/:id/versions — list published versions
// ---------------------------------------------------------------------------

router.get("/:id/versions", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const versions = await listVersions(wf.id);
    const countsRaw = await prisma.executionInstance.groupBy({
      by: ["workflowVersionId"],
      where: { workflowVersionId: { in: versions.map((v) => v.id) } },
      _count: true,
    });
    const countMap = new Map(countsRaw.map((r) => [r.workflowVersionId, r._count]));

    res.json(
      versions.map((v) => ({
        id: v.id,
        version: v.version,
        publishedAt: v.publishedAt.toISOString(),
        instanceCount: countMap.get(v.id) ?? 0,
      })),
    );
  } catch (err) {
    console.error("[workflows] versions error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /creators — list all creators for enrollment UI
// ---------------------------------------------------------------------------

router.get("/", async (_req, res) => {
  // This path is unreachable because /:id catches everything.
  // Creators are listed via a separate /creators route in index.ts.
  res.json([]);
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/enroll — enroll creators into latest published version
// ---------------------------------------------------------------------------

router.post("/:id/enroll", async (req: Request, res: Response) => {
  const { creatorIds } = req.body as { creatorIds?: unknown };
  if (!Array.isArray(creatorIds) || creatorIds.length === 0) {
    res.status(400).json({ error: "creatorIds must be a non-empty array" });
    return;
  }
  const ids = creatorIds.filter((id): id is string => typeof id === "string" && !!id);
  if (ids.length === 0) {
    res.status(400).json({ error: "creatorIds must contain valid string ids" });
    return;
  }

  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.status(422).json({
        error: "workflow has no published version. Publish before enrolling creators.",
      });
      return;
    }

    let enrolled = 0;
    let skipped = 0;

    for (const creatorId of ids) {
      try {
        await createInstance({
          creator: { connect: { id: creatorId } },
          workflowVersion: { connect: { id: latestVersion.id } },
        });
        enrolled++;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          skipped++;
        } else if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          skipped++;
        } else {
          throw err;
        }
      }
    }

    res.json({ enrolled, skipped, versionId: latestVersion.id });
  } catch (err) {
    console.error("[workflows] enroll error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /workflows/:id/launch — enqueue node-execution jobs for ENROLLED instances
// ---------------------------------------------------------------------------

router.post("/:id/launch", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.status(422).json({ error: "no published version to launch" });
      return;
    }

    const instances = await listInstancesByVersion(latestVersion.id);
    const enrolled = instances.filter((i) => i.currentState === "ENROLLED");

    for (const instance of enrolled) {
      await enqueueNodeExecution({
        instanceId: instance.id,
        expectedState: "ENROLLED",
        triggerRef: `launch-${instance.id}`,
      });
    }

    res.json({
      launched: enrolled.length,
      versionId: latestVersion.id,
      totalInstances: instances.length,
    });
  } catch (err) {
    console.error("[workflows] launch error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /workflows/:id/execution — live execution summary for this workflow
// ---------------------------------------------------------------------------

router.get("/:id/execution", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["id"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.json({
        versionId: null,
        version: null,
        totalInstances: 0,
        stateCounts: {},
        recentEvents: [],
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    const instances = await listInstancesByVersion(latestVersion.id);
    const stateCounts: Record<string, number> = {};
    for (const inst of instances) {
      stateCounts[inst.currentState] = (stateCounts[inst.currentState] ?? 0) + 1;
    }

    // Recent events across all instances in this version
    const recentEvents = await prisma.event.findMany({
      where: {
        instance: { workflowVersionId: latestVersion.id },
        type: "STATE_TRANSITION",
      },
      orderBy: { occurredAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        payload: true,
        occurredAt: true,
        instanceId: true,
        instance: {
          select: {
            creator: { select: { name: true, handle: true } },
          },
        },
      },
    });

    res.json({
      versionId: latestVersion.id,
      version: latestVersion.version,
      totalInstances: instances.length,
      stateCounts,
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        instanceId: e.instanceId,
        creatorName: e.instance.creator.name,
        creatorHandle: e.instance.creator.handle,
        payload: e.payload,
        occurredAt: e.occurredAt.toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[workflows] execution error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

export default router;
