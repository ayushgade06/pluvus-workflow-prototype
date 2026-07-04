// ---------------------------------------------------------------------------
// Manual Queue routes (Phase 11)
// ---------------------------------------------------------------------------
// Read + light-action surface for creators that have been escalated to
// MANUAL_REVIEW. Powers the "Manual Queue" tab in the builder:
//
//   GET  /manual-queue/workflows/:workflowId   escalated creators + reason +
//                                               brand-notification status
//   POST /manual-queue/instances/:id/notify     (re)send the brand notice for one
//
// The escalation reason + timestamp are reconstructed from the event log
// (MANUAL_REVIEW_FLAGGED / NEGOTIATION_TURN ESCALATE / STATE_TRANSITION). The
// brand-notification status is joined from the BrandNotification table.

import { Router } from "express";
import type { Request, Response } from "express";
import type { Event, Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { findWorkflowById, findLatestVersion } from "../db/workflows.js";
import {
  findInstanceById,
  listLatestBrandNotificationsForInstances,
  listPendingBrandDecisionsForInstances,
} from "../db/index.js";
import { emailProvider } from "../engine/providerFactory.js";
import { notifyBrandOfEscalation, resolveBrandRecipient } from "../notifications/escalation.js";

const router = Router();

function asRecord(json: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json as Record<string, unknown>;
  }
  return null;
}

function payloadString(p: Record<string, unknown> | null, key: string): string | null {
  const v = p?.[key];
  return typeof v === "string" ? v : null;
}

// Human-readable label for each escalation reason code (mirrors escalation.ts).
const REASON_LABELS: Record<string, string> = {
  low_confidence_reply: "Reply could not be classified confidently",
  max_rounds_reached: "Negotiation hit the maximum rounds",
  max_rounds_reached_on_counter: "Next counter would exceed maximum rounds",
  output_guard_blocked: "Outbound draft blocked by safety guard",
  escalated: "Escalated by the negotiation agent",
  agent_unavailable: "AI agent unavailable (degraded mode)",
  // Brand-decision reasons (AWAITING_BRAND_DECISION rows + timeout/handoff fallbacks).
  missing_brand_name: "Waiting on the brand name to use in emails",
  brand_requested_handoff: "The brand asked for a human to take over",
  brand_reply_ambiguous_after_reask: "The brand's reply couldn't be understood",
  brand_final_counter_pending_delivery: "Brand named a final counter to send",
  brand_decision_timeout: "The brand didn't reply within 72 hours",
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? "Escalated for human review";
}

/**
 * Derive the escalation reason for an instance from its event log.
 * Prefers the most recent escalation-bearing event:
 *   - MANUAL_REVIEW_FLAGGED  → "low_confidence_reply"
 *   - NEGOTIATION_TURN whose payload.outcome is ESCALATE/escalate → payload.reason
 * Returns the reason code + the time the instance was escalated.
 */
function deriveEscalation(events: Event[]): { reason: string; escalatedAt: string | null } {
  // Walk newest → oldest to find the event that drove the escalation.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const p = asRecord(e.payload);
    if (e.type === "MANUAL_REVIEW_FLAGGED") {
      return { reason: "low_confidence_reply", escalatedAt: e.occurredAt.toISOString() };
    }
    if (e.type === "NEGOTIATION_TURN") {
      const outcome = payloadString(p, "outcome");
      if (outcome && outcome.toUpperCase() === "ESCALATE") {
        return {
          reason: payloadString(p, "reason") ?? "escalated",
          escalatedAt: e.occurredAt.toISOString(),
        };
      }
    }
  }
  // Fallback: the STATE_TRANSITION into MANUAL_REVIEW carries the timestamp.
  const transition = [...events]
    .reverse()
    .find((e) => e.type === "STATE_TRANSITION" && payloadString(asRecord(e.payload), "to") === "MANUAL_REVIEW");
  return {
    reason: "escalated",
    escalatedAt: transition ? transition.occurredAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// GET /manual-queue/workflows/:workflowId
// ---------------------------------------------------------------------------

router.get("/workflows/:workflowId", async (req: Request, res: Response) => {
  try {
    const wf = await findWorkflowById(req.params["workflowId"]!);
    if (!wf) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }

    const latestVersion = await findLatestVersion(wf.id);
    if (!latestVersion) {
      res.json({ workflowId: wf.id, items: [], total: 0, generatedAt: new Date().toISOString() });
      return;
    }

    const instances = await prisma.executionInstance.findMany({
      where: { workflowVersionId: latestVersion.id, currentState: "MANUAL_REVIEW" },
      include: {
        creator: true,
        events: { orderBy: { occurredAt: "asc" } },
      },
      orderBy: { updatedAt: "desc" },
    });

    const notifications = await listLatestBrandNotificationsForInstances(
      instances.map((i) => i.id),
    );

    const items = instances.map((inst) => {
      const { reason, escalatedAt } = deriveEscalation(inst.events);
      const notification = notifications.get(inst.id) ?? null;
      return {
        instanceId: inst.id,
        creatorId: inst.creatorId,
        creatorName: inst.creator.name,
        creatorEmail: inst.creator.email,
        creatorHandle: inst.creator.handle,
        platform: inst.creator.platform,
        niche: inst.creator.niche,
        negotiationRound: inst.negotiationRound,
        reason,
        reasonLabel: reasonLabel(reason),
        escalatedAt,
        updatedAt: inst.updatedAt.toISOString(),
        notification: notification
          ? {
              status: notification.status,
              recipient: notification.recipient,
              error: notification.error,
              sentAt: notification.createdAt.toISOString(),
            }
          : null,
      };
    });

    // ── AWAITING_BRAND_DECISION rows (email/magic-link resolvable) ───────────
    // These are NOT in the manual queue proper — they're parked waiting on the
    // brand's reply and will auto-resume (or time out to MANUAL_REVIEW in 72h).
    // Surfaced read-only so an operator can see what's pending on the brand.
    const parked = await prisma.executionInstance.findMany({
      where: {
        workflowVersionId: latestVersion.id,
        currentState: "AWAITING_BRAND_DECISION",
      },
      include: { creator: true },
      orderBy: { updatedAt: "desc" },
    });
    const decisionsByInstance = await listPendingBrandDecisionsForInstances(
      parked.map((i) => i.id),
    );
    const pendingDecisions = parked.map((inst) => {
      const decision = decisionsByInstance.get(inst.id) ?? null;
      const reason = decision?.reason ?? "escalated";
      return {
        instanceId: inst.id,
        creatorId: inst.creatorId,
        creatorName: inst.creator.name,
        creatorEmail: inst.creator.email,
        creatorHandle: inst.creator.handle,
        platform: inst.creator.platform,
        niche: inst.creator.niche,
        reason,
        reasonLabel: reasonLabel(reason),
        question: decision?.question ?? null,
        askedAt: decision?.createdAt.toISOString() ?? null,
        expiresAt: decision?.expiresAt.toISOString() ?? null,
        reaskCount: decision?.reaskCount ?? 0,
        updatedAt: inst.updatedAt.toISOString(),
      };
    });

    res.json({
      workflowId: wf.id,
      versionId: latestVersion.id,
      version: latestVersion.version,
      items,
      total: items.length,
      pendingDecisions,
      pendingTotal: pendingDecisions.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[manual-queue] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /manual-queue/instances/:instanceId/notify
// ---------------------------------------------------------------------------
// (Re)send the brand notification for one escalated instance. Useful when the
// first send FAILED (provider down) or the brand's contact was added after the
// escalation. The reason is re-derived from the event log. Because the escalation
// notifier is idempotent on (instanceId + reason), a successful prior SENT will
// short-circuit to ALREADY_NOTIFIED — to force a fresh send we append a "-manual"
// discriminator so the operator can always re-trigger one.

router.post("/instances/:instanceId/notify", async (req: Request, res: Response) => {
  try {
    const instanceId = req.params["instanceId"]!;
    const inst = await findInstanceById(instanceId);
    if (!inst) {
      res.status(404).json({ error: "instance not found" });
      return;
    }
    if (inst.currentState !== "MANUAL_REVIEW") {
      res.status(409).json({
        error: `instance is not in the manual queue (state: ${inst.currentState})`,
      });
      return;
    }

    const events = await prisma.event.findMany({
      where: { instanceId },
      orderBy: { occurredAt: "asc" },
    });
    const { reason } = deriveEscalation(events);

    // Force a fresh notification distinct from the automatic one so operators can
    // always re-send (e.g. after fixing the brand email or a provider outage).
    const manualReason = `${reason}-manual-${events.length}`;
    const result = await notifyBrandOfEscalation(emailProvider(), instanceId, manualReason);

    res.json({ instanceId, reason, ...result });
  } catch (err) {
    console.error("[manual-queue] notify error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /manual-queue/config — resolved default recipient (for the UI to display)
// ---------------------------------------------------------------------------

router.get("/config", (_req: Request, res: Response) => {
  res.json({
    defaultRecipient: resolveBrandRecipient(null),
    envOverride: process.env["BRAND_NOTIFY_EMAIL"]?.trim() || null,
  });
});

export default router;
