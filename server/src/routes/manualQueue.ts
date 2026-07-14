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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Event, JsonValue } from "../db/schema.js";
import {
  creators,
  events as eventsTable,
  executionInstances,
} from "../db/schema.js";
import { db } from "../db/drizzle.js";
import { findWorkflowById, findLatestVersion } from "../db/workflows.js";
import {
  findInstanceById,
  listEventsByInstance,
  listLatestBrandNotificationsForInstances,
} from "../db/index.js";
import { emailProvider } from "../engine/providerFactory.js";
import { notifyBrandOfEscalation, resolveBrandRecipient } from "../notifications/escalation.js";

const router = Router();

function asRecord(json: JsonValue | null | undefined): Record<string, unknown> | null {
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
  no_ceiling_configured: "Campaign has no maximum budget — set one to auto-negotiate",
  agent_unavailable: "AI agent unavailable (degraded mode)",
  max_rounds_no_agreement: "Negotiation closed — no agreement within the round limit",
  missing_brand_name: "Waiting on the brand name to use in emails",
  // Phase E (#5): always-escalate topics (routed regardless of confidence).
  legal_or_contract: "Legal / contract change — needs a human",
  dispute_or_hostile: "Dispute, payment complaint, or hostile message",
  pricing_exception: "Custom fee structure / bonus / guarantee ask",
  undefined_terms: "Undefined campaign term — needs a human to clarify",
  usage_rights_or_licensing: "Usage rights / exclusivity / licensing ask",
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
      // An explicit payload.reason wins (Phase E always-escalate topics, L4
      // missing_brand_name, etc.); only a reason-less flag defaults to the
      // original reply-detection case (low_confidence_reply). Mirrors
      // runtime.escalationReason so the dashboard + brand FYI agree.
      return {
        reason: payloadString(p, "reason") ?? "low_confidence_reply",
        escalatedAt: e.occurredAt.toISOString(),
      };
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

    const instRows = await db
      .select({ instance: executionInstances, creator: creators })
      .from(executionInstances)
      .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
      .where(
        and(
          eq(executionInstances.workflowVersionId, latestVersion.id),
          eq(executionInstances.currentState, "MANUAL_REVIEW"),
        ),
      )
      .orderBy(desc(executionInstances.updatedAt));

    // Full event log per escalated instance (Prisma's include events), fetched
    // in one query and grouped in memory.
    const ids = instRows.map((r) => r.instance.id);
    const eventsByInstance = new Map<string, Event[]>();
    if (ids.length > 0) {
      const eventRows = await db
        .select()
        .from(eventsTable)
        .where(inArray(eventsTable.instanceId, ids))
        .orderBy(asc(eventsTable.occurredAt));
      for (const ev of eventRows) {
        const list = eventsByInstance.get(ev.instanceId);
        if (list) list.push(ev);
        else eventsByInstance.set(ev.instanceId, [ev]);
      }
    }

    const notifications = await listLatestBrandNotificationsForInstances(ids);

    const items = instRows.map(({ instance: inst, creator }) => {
      const { reason, escalatedAt } = deriveEscalation(eventsByInstance.get(inst.id) ?? []);
      const notification = notifications.get(inst.id) ?? null;
      return {
        instanceId: inst.id,
        creatorId: inst.creatorId,
        creatorName: creator.name,
        creatorEmail: creator.email,
        creatorHandle: creator.handle,
        platform: creator.platform,
        niche: creator.niche,
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

    res.json({
      workflowId: wf.id,
      versionId: latestVersion.id,
      version: latestVersion.version,
      items,
      total: items.length,
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

    const events = await listEventsByInstance(instanceId);
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
