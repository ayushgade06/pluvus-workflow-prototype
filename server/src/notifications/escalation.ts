// ---------------------------------------------------------------------------
// Manual-queue escalation notifications (Phase 11)
// ---------------------------------------------------------------------------
// When a creator's ExecutionInstance enters MANUAL_REVIEW, the brand running the
// campaign needs to know a human must take over. This module emails the brand
// once per escalation and records the notice as a BrandNotification row so the
// app can show "the brand was (or wasn't) notified" on the manual queue.
//
// Design notes:
//   - Idempotent: keyed on (instanceId + reason). A BullMQ retry of the same
//     step re-enters here; the reserve insert hits the unique constraint and the
//     send is skipped. The brand is never double-emailed for the same event.
//   - Best-effort: a send/record failure must NEVER fail the state transition
//     that put the creator in the queue. Callers fire this after the state is
//     already persisted and swallow errors. A FAILED row is still written so the
//     UI can surface that the brand wasn't reached.
//   - Provider-agnostic: reuses the same IEmailProvider the workflow already
//     uses (mock | nylas). send() addresses the recipient via a Creator-shaped
//     object whose email/name are the brand's — both providers read only those.

import { eq } from "drizzle-orm";
import type {
  BrandNotification,
  BrandNotificationInsert,
  BrandNotificationStatus,
  Creator,
  DealHandoff,
  Event,
  EventInsert,
  Message,
} from "../db/schema.js";
import {
  campaigns,
  creators,
  executionInstances,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import { db } from "../db/drizzle.js";
import { isUniqueViolation } from "../db/errors.js";
import {
  createBrandNotification,
  findBrandNotificationByKey,
  updateBrandNotificationStatus,
  appendEvent,
  listEventsByInstance,
  listMessagesByInstance,
} from "../db/index.js";
import { findDealHandoffByInstance } from "../db/dealHandoffs.js";
import { formatAgreedCompensation } from "../engine/dealTerms.js";
import { buildDraftHistory } from "../engine/executors/negotiationHistory.js";
import type { DraftHistoryEntry } from "../adapters/negotiation/types.js";
import type { IEmailProvider } from "../engine/providers.js";
import type { EmailDraft } from "../engine/types.js";

// The platform operator address — the last-resort recipient when a campaign has
// no notifyEmail and BRAND_NOTIFY_EMAIL is unset. Kept here (not just env) so a
// fresh checkout still routes escalations somewhere reachable in dev.
const OPERATOR_FALLBACK_EMAIL = "affiliatepartner@pluvus.com";

// Human-readable summary for each escalation reason code. The reason itself is
// the machine value persisted on BrandNotification.reason and the event payload.
const REASON_LABELS: Record<string, string> = {
  low_confidence_reply:
    "the AI could not confidently classify the creator's reply",
  output_guard_blocked:
    "an outbound draft was blocked by the safety guard before sending",
  escalated: "the negotiation agent escalated this conversation for human review",
  no_ceiling_configured:
    "this campaign has no maximum budget set, so the AI has no ceiling to negotiate within — set a maximum budget to let it auto-negotiate",
  agent_unavailable:
    "the AI agent was unavailable (degraded mode), so this was routed to a human",
  missing_brand_name:
    "a creator-facing email had no resolvable brand name to sign with (config needs fixing)",
  // Phase E (#5): always-escalate topics — a human must handle these regardless
  // of the AI's confidence (the agent may acknowledge but must not commit).
  legal_or_contract:
    "the creator raised a legal or contract change that needs a human to handle",
  dispute_or_hostile:
    "the creator raised a dispute, payment complaint, or hostile message",
  pricing_exception:
    "the creator asked for a custom fee structure, bonus, or guarantee outside the standard deal",
  undefined_terms:
    "the creator asked about a campaign term that isn't defined and needs a human to clarify",
  usage_rights_or_licensing:
    "the creator raised usage rights, exclusivity, or licensing — a commitment only a human can make",
};

// PLU-70: the reason codes the operator-handoff branch notifies under. Kept
// distinct from the escalation reasons above because these are NOT failures —
// the AI did its job and closed a deal. `handoff_reply` is suffixed with the
// inbound message id at the call site so each distinct creator reply forwards
// exactly once while a retried delivery cannot double-send.
export const DEAL_FINALIZATION_REASON = "needs_deal_finalization";
export const HANDOFF_REPLY_REASON_PREFIX = "handoff_reply";

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? `it was escalated for human review (${reason})`;
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------
// Precedence: per-campaign notifyEmail → BRAND_NOTIFY_EMAIL env → operator.
// Returns null only if every source is empty AND the operator default is
// explicitly cleared (it never is by default), in which case we record SKIPPED.

export function resolveBrandRecipient(campaignNotifyEmail: string | null | undefined): string | null {
  const fromCampaign = campaignNotifyEmail?.trim();
  if (fromCampaign) return fromCampaign;
  const fromEnv = process.env["BRAND_NOTIFY_EMAIL"]?.trim();
  if (fromEnv) return fromEnv;
  return OPERATOR_FALLBACK_EMAIL || null;
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

interface EscalationContext {
  creator: Creator;
  campaignName: string | null;
  brandName: string | null;
  workflowName: string | null;
  notifyEmail: string | null;
  // The full both-sides conversation so far, so the escalation email can show the
  // operator exactly what was said instead of only pointing them to the dashboard.
  // Chronological (oldest → newest); empty when there is no history yet.
  transcript: DraftHistoryEntry[];
}

// DB seam — injectable so the reserve→send→finalize→audit sequencing (incl. the
// P2002 idempotency branch and the FAILED-on-send-error branch) is unit-testable
// without a live database. Defaults to the real db helpers.
export interface EscalationDeps {
  /**
   * `withTranscript: false` skips assembling the both-sides conversation. The
   * PLU-70 operator notices are deliberately concise and never render it, so
   * loading it would be pure cost on a path that closes deals in bulk.
   */
  loadContext(
    instanceId: string,
    opts?: { withTranscript?: boolean },
  ): Promise<EscalationContext | null>;
  findDealHandoffByInstance?(instanceId: string): Promise<DealHandoff | null>;
  createBrandNotification(data: BrandNotificationInsert): Promise<BrandNotification>;
  findBrandNotificationByKey(key: string): Promise<BrandNotification | null>;
  updateBrandNotificationStatus(
    id: string,
    data: { status: BrandNotificationStatus; error?: string | null },
  ): Promise<BrandNotification>;
  appendEvent(data: EventInsert): Promise<Event>;
}

async function loadEscalationContext(
  instanceId: string,
  opts?: { withTranscript?: boolean },
): Promise<EscalationContext | null> {
  // instance → creator + workflowVersion → workflow → (optional) campaign.
  const rows = await db
    .select({
      creator: creators,
      workflowName: workflows.name,
      campaignName: campaigns.name,
      brandName: campaigns.brand,
      notifyEmail: campaigns.notifyEmail,
    })
    .from(executionInstances)
    .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
    .innerJoin(
      workflowVersions,
      eq(executionInstances.workflowVersionId, workflowVersions.id),
    )
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .leftJoin(campaigns, eq(workflows.campaignId, campaigns.id))
    .where(eq(executionInstances.id, instanceId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  // Assemble the both-sides transcript from the SAME source the negotiator/
  // copywriter use (buildDraftHistory): NEGOTIATION_TURN events (our sent turns)
  // interleaved with the creator's INBOUND messages, chronologically. Best-effort
  // — a transcript failure must never block the escalation notice, so a throw here
  // degrades to an empty transcript (the email still sends who/why + dashboard
  // pointer). brandReplyMsgIds is derived exactly as loadCreatorInbounds does.
  let transcript: DraftHistoryEntry[] = [];
  if (opts?.withTranscript === false) {
    return {
      creator: row.creator,
      campaignName: row.campaignName ?? null,
      brandName: row.brandName ?? null,
      workflowName: row.workflowName ?? null,
      notifyEmail: row.notifyEmail ?? null,
      transcript,
    };
  }
  try {
    const [events, messages, inboundEvents] = await Promise.all([
      listEventsByInstance(instanceId, { type: "NEGOTIATION_TURN" }),
      listMessagesByInstance(instanceId),
      listEventsByInstance(instanceId, { type: "INBOUND_REPLY_RECEIVED" }),
    ]);
    const brandReplyMsgIds = new Set(
      inboundEvents
        .filter((e) => (e.payload as Record<string, unknown> | null)?.["brandDecisionReply"] === true)
        .map((e) => (e.payload as Record<string, unknown> | null)?.["externalMessageId"])
        .filter((id): id is string => typeof id === "string"),
    );
    transcript = buildDraftHistory(events, messages as Message[], brandReplyMsgIds);
  } catch (err) {
    console.error(
      `[escalation] could not assemble transcript for instance ${instanceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    creator: row.creator,
    campaignName: row.campaignName ?? null,
    brandName: row.brandName ?? null,
    workflowName: row.workflowName ?? null,
    notifyEmail: row.notifyEmail ?? null,
    transcript,
  };
}

const defaultDeps: EscalationDeps = {
  loadContext: loadEscalationContext,
  findDealHandoffByInstance,
  createBrandNotification,
  findBrandNotificationByKey,
  updateBrandNotificationStatus,
  appendEvent,
};

// ---------------------------------------------------------------------------
// Email composition
// ---------------------------------------------------------------------------

// Cap the transcript rendered into the email so a very long negotiation doesn't
// produce a wall of text. We keep the MOST RECENT turns (the escalation trigger
// and the context around it are what the operator needs first) and note how many
// earlier turns were omitted, with a pointer to the dashboard for the full log.
const MAX_TRANSCRIPT_TURNS = 20;
// Trim any single message so one rambling reply can't dominate the email.
const MAX_TRANSCRIPT_MSG_CHARS = 600;

/** Render the both-sides transcript as a readable conversation block. Returns []
 *  (no lines) when there is no history, so first-turn escalations read as before. */
function renderTranscript(
  transcript: DraftHistoryEntry[],
  brandName: string | null,
  creatorName: string,
): string[] {
  if (!transcript.length) return [];

  const omitted = Math.max(0, transcript.length - MAX_TRANSCRIPT_TURNS);
  const shown = transcript.slice(-MAX_TRANSCRIPT_TURNS);
  const us = brandName ?? "You";

  const body: string[] = [];
  for (const t of shown) {
    const who = t.role === "creator" ? creatorName : us;
    // A round/action/rate tag on our turns gives the operator the negotiation
    // state at a glance (e.g. "You — round 2, COUNTER $375").
    const tag: string[] = [];
    if (t.role === "us") {
      if (typeof t.round === "number") tag.push(`round ${t.round}`);
      if (t.action) tag.push(t.action);
      if (typeof t.rate === "number") tag.push(`$${t.rate}`);
    }
    const header = tag.length ? `${who} — ${tag.join(", ")}:` : `${who}:`;
    let msg = (t.message ?? "").trim();
    if (msg.length > MAX_TRANSCRIPT_MSG_CHARS) {
      msg = `${msg.slice(0, MAX_TRANSCRIPT_MSG_CHARS)}… [truncated]`;
    }
    body.push(header, msg || "(no message text)", "");
  }
  // Drop the trailing blank separator.
  if (body[body.length - 1] === "") body.pop();

  const lines = [
    `─────────────────────────────────────────`,
    `Conversation so far${omitted > 0 ? ` (most recent ${MAX_TRANSCRIPT_TURNS} of ${transcript.length} messages; ${omitted} earlier omitted — see the dashboard for the full log)` : ""}:`,
    `─────────────────────────────────────────`,
    ``,
    ...body,
    ``,
    `─────────────────────────────────────────`,
  ];
  return lines;
}

export function buildEscalationEmail(ctx: EscalationContext, reason: string): EmailDraft {
  const { creator, brandName, campaignName, workflowName, transcript } = ctx;
  const brand = brandName ?? "your brand";
  const creatorLine = creator.handle
    ? `${creator.name} (@${creator.handle})`
    : creator.name;

  const subject = `Action needed: ${creator.name} moved to the manual review queue`;

  const transcriptLines = renderTranscript(transcript ?? [], brandName, creator.name);

  const lines = [
    `Hi ${brand} team,`,
    ``,
    `A creator in your outreach has been escalated to the manual review queue and needs a human to take over.`,
    ``,
    `Creator:   ${creatorLine}`,
    `Email:     ${creator.email}`,
    ...(creator.platform ? [`Platform:  ${creator.platform}`] : []),
    ...(creator.niche ? [`Niche:     ${creator.niche}`] : []),
    ...(campaignName ? [`Campaign:  ${campaignName}`] : []),
    ...(workflowName ? [`Workflow:  ${workflowName}`] : []),
    ``,
    `Why it was escalated: ${reasonLabel(reason)}.`,
    ``,
    // The full both-sides conversation, inline, so the operator can read exactly
    // what was said without leaving their inbox. Empty on a first-turn escalation.
    ...(transcriptLines.length ? [...transcriptLines, ``] : []),
    `To continue the deal, reply to ${creator.name} directly at ${creator.email} — the automated workflow has PAUSED for this creator and will not send any further emails on its own. (Replying to THIS notification does nothing; it is an alert, not a routable thread.) You can also open the Manual Queue in the Pluvus dashboard.`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// notifyBrandOfEscalation
// ---------------------------------------------------------------------------

export interface EscalationResult {
  status: "SENT" | "FAILED" | "SKIPPED" | "ALREADY_NOTIFIED";
  recipient: string | null;
}

/**
 * The shared reserve → send → finalize → audit sequence behind EVERY operator
 * notice (escalations and the PLU-70 handoff notices alike).
 *
 * Parameterized only by the reason code and a draft builder, so all three
 * callers share one copy of the guarantees that actually matter:
 *   - idempotent on (instanceId + reason) via the reserved BrandNotification row,
 *   - a send failure is recorded FAILED with the error rather than thrown,
 *   - no resolvable recipient is recorded SKIPPED rather than silently dropped,
 *   - never throws, so a notification can never block or roll back a state commit.
 *
 * `buildDraft` returning null means "there is nothing to send after all" — used
 * when the context a notice depends on is missing. It is recorded as SKIPPED so
 * the absence is still visible in the Manual Queue.
 */
async function deliverOperatorNotice(
  email: IEmailProvider,
  instanceId: string,
  reason: string,
  buildDraft: (ctx: EscalationContext) => Promise<EmailDraft | null> | EmailDraft | null,
  deps: EscalationDeps,
  opts?: { withTranscript?: boolean; logLabel?: string },
): Promise<EscalationResult> {
  const idempotencyKey = `escalation:${instanceId}:${reason}`;
  const label = opts?.logLabel ?? "escalation";

  try {
    const ctx = await deps.loadContext(instanceId, {
      withTranscript: opts?.withTranscript ?? true,
    });
    if (!ctx) {
      return { status: "SKIPPED", recipient: null };
    }

    const recipient = resolveBrandRecipient(ctx.notifyEmail);

    // ── Reserve (idempotency lock) ────────────────────────────────────────
    // Insert the row first so concurrent/retried steps can't both send. If the
    // key already exists, a prior attempt handled this escalation.
    let reservedId: string;
    try {
      const reserved = await deps.createBrandNotification({
        instanceId,
        recipient: recipient ?? "(none)",
        reason,
        status: recipient ? "SENT" : "SKIPPED",
        idempotencyKey,
      });
      reservedId = reserved.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const prior = await deps.findBrandNotificationByKey(idempotencyKey);
        return {
          status: "ALREADY_NOTIFIED",
          recipient: prior?.recipient ?? recipient,
        };
      }
      throw err;
    }

    // No recipient resolvable → record SKIPPED, no email, no event.
    if (!recipient) {
      return { status: "SKIPPED", recipient: null };
    }

    // ── Send ──────────────────────────────────────────────────────────────
    const draft = await buildDraft(ctx);
    if (!draft) {
      // The notice had nothing to say (its backing record was missing). Record
      // SKIPPED so the gap is visible rather than silently absent.
      await deps.updateBrandNotificationStatus(reservedId, { status: "SKIPPED" });
      return { status: "SKIPPED", recipient };
    }
    // CRITICAL-2: address the brand via the explicit EmailRecipient rather than a
    // forged Creator-shaped object (the "brand-as-Creator" hack the audit flags).
    // These notices are ALERTS, not routable threads: they persist no Message row,
    // so a reply to one has nothing to route back into. (For PLU-70 the operator's
    // route INTO the conversation is the CC on the creator-facing handoff message,
    // not this email.) The creator is still passed as the thread owner for the
    // provider's fallback fields.
    try {
      await email.send(draft, ctx.creator, {
        email: recipient,
        name: ctx.brandName ?? ctx.creator.name,
      });
    } catch (sendErr) {
      const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
      await deps.updateBrandNotificationStatus(reservedId, { status: "FAILED", error: message });
      console.error(
        `[${label}] failed to email operator for instance ${instanceId} (reason ${reason}): ${message}`,
      );
      return { status: "FAILED", recipient };
    }

    // ── Audit event ───────────────────────────────────────────────────────
    await deps.appendEvent({
      instanceId,
      type: "BRAND_NOTIFIED",
      payload: { recipient, reason },
      occurredAt: new Date(),
    });

    console.log(
      `[${label}] operator notified for instance ${instanceId} → ${recipient} (reason ${reason})`,
    );
    return { status: "SENT", recipient };
  } catch (err) {
    // Final safety net: never let a notification failure bubble into the state
    // machine. Log and report, but do not throw.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[${label}] unexpected error notifying operator for instance ${instanceId}: ${message}`,
    );
    return { status: "FAILED", recipient: null };
  }
}

/**
 * Notify the brand that a creator was escalated to the manual queue.
 *
 * Idempotent on (instanceId + reason): a second call for the same escalation
 * returns ALREADY_NOTIFIED without sending. Never throws — failures are recorded
 * as FAILED and returned, so the caller (the state machine) is never blocked.
 */
export async function notifyBrandOfEscalation(
  email: IEmailProvider,
  instanceId: string,
  reason: string,
  deps: EscalationDeps = defaultDeps,
): Promise<EscalationResult> {
  return deliverOperatorNotice(
    email,
    instanceId,
    reason,
    (ctx) => buildEscalationEmail(ctx, reason),
    deps,
    { logLabel: "escalation" },
  );
}

// ---------------------------------------------------------------------------
// PLU-70 — operator handoff notices
// ---------------------------------------------------------------------------

/**
 * "A creator agreed and the deal is waiting on you."
 *
 * Reuses the campaign's existing escalation contact and the existing email
 * transport — there is no separate notification-email configuration for handoff.
 * The only deliberate difference from buildEscalationEmail is brevity: this one
 * carries the AGREEMENT, not the conversation. The operator opens the execution
 * inspector when they want the thread.
 */
export function buildDealFinalizationEmail(
  ctx: EscalationContext,
  handoff: DealHandoff,
): EmailDraft {
  const { creator, brandName } = ctx;
  const brand = brandName ?? "your brand";
  const creatorLine = creator.handle
    ? `${creator.name} (@${creator.handle})`
    : creator.name;

  const subject = `Creator agreement ready for finalization — ${creator.name}`;

  const lines = [
    `Hi ${brand} team,`,
    ``,
    `${creator.name} accepted the offer. The automated workflow has PAUSED here — the deal now needs a human to finalize it and onboard them in Pluvus.`,
    ``,
    `Creator:       ${creatorLine}`,
    `Email:         ${creator.email}`,
    ...(handoff.campaignName ? [`Campaign:      ${handoff.campaignName}`] : []),
    `Compensation:  ${formatAgreedCompensation(handoff.fixedFee, handoff.commissionRate)}`,
    ...(handoff.deliverables ? [`Deliverables:  ${handoff.deliverables}`] : []),
    ...(handoff.timeline ? [`Timeline:      ${handoff.timeline}`] : []),
    ...(handoff.paymentTerms ? [`Payment terms: ${handoff.paymentTerms}`] : []),
    `Accepted:      ${handoff.acceptedAt.toISOString()}`,
    `Execution:     ${handoff.instanceId}`,
    ``,
    `${creator.name} has been told a campaign manager will follow up shortly with their onboarding link.`,
    ``,
    `Open the Manual Queue in the Pluvus dashboard to see the full conversation and mark the handoff complete once they're onboarded.`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: lines.join("\n") };
}

/**
 * Notify the campaign's escalation contact that a deal is ready to finalize.
 *
 * Fired by runtime.stepInstance on a fresh transition into
 * NEEDS_DEAL_FINALIZATION, AFTER the state is committed. Idempotent on
 * (instanceId + "needs_deal_finalization"), so retried delivery can never
 * duplicate the transition or the DealHandoff record.
 *
 * If no recipient resolves, or the send fails, the handoff is NOT lost: the
 * instance stays in NEEDS_DEAL_FINALIZATION and remains visible in the Manual
 * Queue, and the BrandNotification row records SKIPPED/FAILED so the UI can show
 * that the operator was not reached (and offer a re-send).
 */
export async function notifyOperatorOfDealFinalization(
  email: IEmailProvider,
  instanceId: string,
  deps: EscalationDeps = defaultDeps,
  reason: string = DEAL_FINALIZATION_REASON,
): Promise<EscalationResult> {
  const loadHandoff = deps.findDealHandoffByInstance ?? findDealHandoffByInstance;
  return deliverOperatorNotice(
    email,
    instanceId,
    reason,
    async (ctx) => {
      const handoff = await loadHandoff(instanceId);
      if (!handoff) {
        console.error(
          `[deal-handoff] no DealHandoff row for instance ${instanceId} — nothing to notify about`,
        );
        return null;
      }
      return buildDealFinalizationEmail(ctx, handoff);
    },
    deps,
    // The whole point of this email is that it is short. Skip transcript assembly.
    { withTranscript: false, logLabel: "deal-handoff" },
  );
}

/** Forward a creator reply that arrived while the deal was parked on an operator. */
export function buildHandoffReplyEmail(
  ctx: EscalationContext,
  reply: { subject: string; body: string },
): EmailDraft {
  const { creator } = ctx;
  const subject = `${creator.name} replied — ${creator.email}`;

  const lines = [
    `${creator.name} replied while their deal is awaiting finalization.`,
    ``,
    `From:    ${creator.name} <${creator.email}>`,
    `Subject: ${reply.subject}`,
    ``,
    `─────────────────────────────────────────`,
    reply.body.trim() || "(no message text)",
    `─────────────────────────────────────────`,
    ``,
    `Reply to ${creator.name} directly at ${creator.email}. The automated workflow will NOT respond on its own — you own this conversation.`,
    ``,
    `— Pluvus Workflow Automation`,
  ];

  return { subject, body: lines.join("\n") };
}

/**
 * Forward an inbound creator reply to the operator during NEEDS_DEAL_FINALIZATION.
 *
 * The CC on the handoff message already puts the operator in the thread for a
 * "reply all". This covers the creator who hits plain "reply" and therefore
 * reaches only our mailbox. Keyed on the inbound message id, so each distinct
 * reply forwards exactly once while a retried delivery cannot double-send.
 */
export async function notifyOperatorOfHandoffReply(
  email: IEmailProvider,
  instanceId: string,
  reply: { externalMessageId: string; subject: string; body: string },
  deps: EscalationDeps = defaultDeps,
): Promise<EscalationResult> {
  return deliverOperatorNotice(
    email,
    instanceId,
    `${HANDOFF_REPLY_REASON_PREFIX}:${reply.externalMessageId}`,
    (ctx) => buildHandoffReplyEmail(ctx, reply),
    deps,
    { withTranscript: false, logLabel: "deal-handoff" },
  );
}
