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
import { buildDraftHistory } from "../engine/executors/negotiationHistory.js";
import type { DraftHistoryEntry } from "../adapters/negotiation/types.js";
import type { IEmailProvider } from "../engine/providers.js";
import type { EmailDraft } from "../engine/types.js";
import { DefaultThreadContextResolver } from "../engine/threadContext.js";

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
  // E6: the provider thread id for this instance (from the single-source-of-truth
  // ThreadContextResolver), so the escalation email can carry ONE deep-link to the
  // thread that now holds the whole conversation. undefined when no message has
  // threaded yet — the link is then omitted gracefully.
  threadId: string | null;
}

// DB seam — injectable so the reserve→send→finalize→audit sequencing (incl. the
// P2002 idempotency branch and the FAILED-on-send-error branch) is unit-testable
// without a live database. Defaults to the real db helpers.
export interface EscalationDeps {
  loadContext(instanceId: string): Promise<EscalationContext | null>;
  createBrandNotification(data: BrandNotificationInsert): Promise<BrandNotification>;
  findBrandNotificationByKey(key: string): Promise<BrandNotification | null>;
  updateBrandNotificationStatus(
    id: string,
    data: { status: BrandNotificationStatus; error?: string | null },
  ): Promise<BrandNotification>;
  appendEvent(data: EventInsert): Promise<Event>;
}

async function loadEscalationContext(instanceId: string): Promise<EscalationContext | null> {
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

  // E6: resolve the instance's thread id from the SAME source of truth the send
  // path uses (ThreadContextResolver), so the escalation email can deep-link the
  // one thread with the full history. Best-effort — a resolver/DB failure here
  // must never block the escalation notice, so a throw degrades to no threadId
  // (the email still sends and simply omits the link).
  let threadId: string | null = null;
  try {
    const ctx = await new DefaultThreadContextResolver().resolve(instanceId);
    threadId = ctx.threadId ?? null;
  } catch (err) {
    console.error(
      `[escalation] could not resolve threadId for instance ${instanceId}: ${
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
    threadId,
  };
}

const defaultDeps: EscalationDeps = {
  loadContext: loadEscalationContext,
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

/**
 * @param threadUrl optional provider deep-link builder (E6). When it yields a URL
 *   for the instance's threadId, the email carries a one-click link to the full
 *   thread; when it (or the threadId) is absent, the link is omitted gracefully.
 */
export function buildEscalationEmail(
  ctx: EscalationContext,
  reason: string,
  threadUrl?: (threadId: string) => string | undefined,
): EmailDraft {
  const { creator, brandName, campaignName, workflowName, transcript, threadId } = ctx;
  const brand = brandName ?? "your brand";
  const creatorLine = creator.handle
    ? `${creator.name} (@${creator.handle})`
    : creator.name;

  const subject = `Action needed: ${creator.name} moved to the manual review queue`;

  const transcriptLines = renderTranscript(transcript ?? [], brandName, creator.name);

  // E6: build the deep-link only when BOTH a threadId and a provider that can
  // turn it into a URL are present. Omitted entirely otherwise (no broken link).
  const threadLink = threadId && threadUrl ? threadUrl(threadId) : undefined;

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
    // E6 payoff: one link straight to the email thread that holds the whole
    // back-and-forth. Only present when a threaded thread id + a provider URL
    // builder both exist; omitted cleanly otherwise.
    ...(threadLink ? [`Open the full email thread: ${threadLink}`, ``] : []),
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
  const idempotencyKey = `escalation:${instanceId}:${reason}`;

  try {
    const ctx = await deps.loadContext(instanceId);
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
    // E6: hand the email builder the provider's own thread-URL helper (bound to
    // `email` so `this` resolves) so it can deep-link the thread. Providers that
    // don't implement it (or aren't configured) yield undefined and the link is
    // omitted — the notice is unaffected.
    const threadUrl = email.threadUrl?.bind(email);
    const draft = buildEscalationEmail(ctx, reason, threadUrl);
    // CRITICAL-2: address the brand via the explicit EmailRecipient rather than a
    // forged Creator-shaped object (the "brand-as-Creator" hack the audit flags).
    // This notice goes out on MANUAL_REVIEW (a terminal state), so unlike the
    // brand-DECISION email it does not persist a routable Message row — a reply
    // here has nothing to route back into (the inbound worker skips terminal
    // instances). The creator is still passed as the thread owner for the
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
        `[escalation] failed to email brand for instance ${instanceId} (reason ${reason}): ${message}`,
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
      `[escalation] brand notified for instance ${instanceId} → ${recipient} (reason ${reason})`,
    );
    return { status: "SENT", recipient };
  } catch (err) {
    // Final safety net: never let a notification failure bubble into the state
    // machine. Log and report, but do not throw.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[escalation] unexpected error notifying brand for instance ${instanceId}: ${message}`,
    );
    return { status: "FAILED", recipient: null };
  }
}
