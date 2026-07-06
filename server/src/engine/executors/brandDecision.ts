import type { Creator } from "@prisma/client";
import {
  listMessagesByInstance,
  createBrandDecision,
  findPendingBrandDecisionByInstance,
  updateBrandDecision,
  generateBrandDecisionToken,
} from "../../db/index.js";
import { updateCampaign } from "../../db/campaigns.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { extractReplyText } from "./replyText.js";
import {
  scanBrandDecisionTokens,
  BRAND_DECISION_CONFIDENCE_THRESHOLD,
  type BrandDecisionAction,
  type BrandDecisionParse,
} from "../brandDecisionParse.js";
import {
  buildBrandDecisionEmail,
  buildBrandNameRequestEmail,
  type BrandDecisionLinkAction,
} from "../../notifications/brandDecisionEmail.js";
import { resolveBrandRecipient } from "../../notifications/escalation.js";

// ---------------------------------------------------------------------------
// executeBrandDecision — the generic brand-decision loop (§2.3)
// ---------------------------------------------------------------------------
// Two entry points, mirroring how Reward Setup / Payment Info split outbound
// (send + enter waiting) from the reply phase:
//
//   1. openBrandDecision(...)   OUTBOUND. Called by an escalating executor (B9
//      negotiation max-rounds, in this pass) instead of returning MANUAL_REVIEW.
//      Creates the BrandDecision row (token + expiresAt + resume context) and
//      sends the actionable email, then returns a NodeResult that parks the run
//      in AWAITING_BRAND_DECISION.
//
//   2. executeBrandDecision(...)  INBOUND/REPLY. Dispatched by state when a reply
//      arrives while AWAITING_BRAND_DECISION. Runs the parse pipeline (§2.4) on
//      the latest inbound reply and maps the answer to the next state.
//
// The resolution MAP (answer → next state) is per-reason, supplied on the
// BrandDecision.contextJson so the reply phase can resume without re-deriving it.

// ── contextJson shape ──────────────────────────────────────────────────────
// What the outbound side stashes so the reply side can resume + resolve. Kept
// permissive (all optional beyond `reason`) so different escalation cases can
// carry only what they need.
export interface BrandDecisionContext {
  reason: string;
  /** Which magic-link/reply actions were offered — the resolution map keys. */
  actions: BrandDecisionLinkAction[];
  /**
   * Which resolution shape this decision uses:
   *   "business" (default) — APPROVE/REJECT/COUNTER/HANDOFF (B9, A-cases, …)
   *   "config"             — the reply IS a config VALUE (the L4 missing-brand
   *                          name), written back + the blocked node re-run.
   */
  kind?: "business" | "config";
  /** Node to resume at when the answer re-opens negotiation (COUNTER on B9). */
  negotiationNodeId?: string | null;
  /** The creator's latest rate on the table, for the timeline + resume copy. */
  creatorRate?: number;
  floor?: number;
  ceiling?: number;
  maxRounds?: number;
  round?: number;
  /** True when the creator's reply looked like a prompt injection — forces at
   *  least a re-ask + warning and blocks an auto-APPROVE (§ infra table). */
  injectionSuspected?: boolean;
  // ── config-fix (L4 missing_brand_name) variant ──────────────────────────
  /** The node type that was blocked (REWARD_SETUP / PAYMENT_INFO / CONTENT_BRIEF),
   *  for the timeline. */
  blockedNodeType?: string;
  /** The parent campaign to write the supplied brand name back to. */
  campaignId?: string | null;
  /** The state the blocked node runs FROM — where we transition back to so a
   *  re-enqueued node-execution job re-runs the same node with a resolvable
   *  name. (ACCEPTED for Reward Setup, REWARD_CONFIRMED for Payment Info,
   *  PAYMENT_RECEIVED for Content Brief.) */
  rerunFromState?: string;
}

// ── Outbound ────────────────────────────────────────────────────────────────

export interface OpenBrandDecisionInput {
  reason: string;
  /** The human-readable question shown to the brand (persisted verbatim). */
  question: string;
  /** Resume/resolution context stashed on the row for the reply phase. */
  context: BrandDecisionContext;
  /** Which actions the email offers. Approve/reject-only cases omit "counter". */
  actions?: BrandDecisionLinkAction[];
  /** Optional suggested counter amount pre-filled on the counter magic link. */
  suggestedCounter?: number;
  /** The creator's raw reply, quoted for the read-intent / unreadable cases. */
  quotedReply?: string;
  /** Which email to send: the business decision email (default) or the L4
   *  missing-brand-name request email (reply with a name, not a token). */
  emailKind?: "business" | "config";
  /** The event type + payload the outbound transition records. Reuses the
   *  escalating node's own event type (e.g. NEGOTIATION_TURN) so the timeline
   *  reads continuously. */
  eventType: NodeResult["eventType"];
  eventPayload?: Record<string, unknown>;
}

/**
 * Open a brand-decision round-trip: create the BrandDecision row, send the
 * actionable email, and return the NodeResult that parks the run in
 * AWAITING_BRAND_DECISION. Called from an escalating executor's business branch.
 *
 * Best-effort on the email send (mirrors notifyBrandOfEscalation): the row is
 * created first (so a reply can always match), and a send failure is logged but
 * does NOT throw — the run is already parked and the 72h sweep / dashboard is
 * the backstop. The row's token is the capability the reply/magic-link matches.
 */
export async function openBrandDecision(
  ctx: ExecutionContext,
  email: IEmailProvider,
  input: OpenBrandDecisionInput,
): Promise<NodeResult> {
  const { instance, creator, campaign } = ctx;
  const actions = input.actions ?? ["approve", "reject", "counter", "handoff"];

  const token = generateBrandDecisionToken();
  await createBrandDecision({
    instanceId: instance.id,
    reason: input.reason,
    question: input.question,
    token,
    contextJson: { ...input.context, actions },
  });

  const recipient = resolveBrandRecipient(campaign?.notifyEmail);
  const brandName = campaign?.brand ?? "your brand";

  if (recipient) {
    const draft =
      input.emailKind === "config"
        ? buildBrandNameRequestEmail({
            brandName,
            creatorName: creator.name,
            creatorHandle: creator.handle,
            campaignName: campaign?.name ?? null,
            question: input.question,
            token,
          })
        : buildBrandDecisionEmail({
            brandName,
            creatorName: creator.name,
            creatorHandle: creator.handle,
            campaignName: campaign?.name ?? null,
            question: input.question,
            token,
            actions,
            ...(input.suggestedCounter !== undefined ? { suggestedCounter: input.suggestedCounter } : {}),
            ...(input.quotedReply ? { quotedReply: input.quotedReply } : {}),
          });
    // Address the brand by re-using send() with a recipient-shaped object — the
    // same trick notifyBrandOfEscalation uses; both providers read only email+name.
    const brandAsCreator = { ...creator, email: recipient, name: brandName } as Creator;
    try {
      await email.send(draft, brandAsCreator);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[brand-decision] failed to email brand for instance ${instance.id} (reason ${input.reason}): ${message}`,
      );
    }
  } else {
    console.warn(
      `[brand-decision] no brand recipient resolvable for instance ${instance.id} (reason ${input.reason}) — row created, awaiting dashboard/sweep`,
    );
  }

  return {
    nextState: "AWAITING_BRAND_DECISION",
    // Keep currentNodeId on the escalating node (e.g. the negotiation node) so
    // the timeline stays coherent and loadContext resolves a real node while the
    // run is parked. The reply phase is dispatched on STATE, not this node type.
    nextNodeId: ctx.node.id,
    eventType: input.eventType,
    eventPayload: {
      ...(input.eventPayload ?? {}),
      brandDecisionToken: token,
      brandDecisionOpened: true,
    },
  };
}

// The state each L4-blockable node runs FROM — where the config-fix transitions
// back to so a re-enqueued node-execution job re-runs the SAME node with the
// now-resolvable brand name.
const RERUN_FROM_STATE: Record<string, NodeResult["nextState"]> = {
  REWARD_SETUP: "ACCEPTED",
  PAYMENT_INFO: "REWARD_CONFIRMED",
  CONTENT_BRIEF: "PAYMENT_RECEIVED",
};

/**
 * L4 config-fix (§3 Category D): the blocked node (Reward Setup / Payment Info /
 * Content Brief) has no resolvable brand name. Instead of dead-ending in
 * MANUAL_REVIEW, open a brand-decision round-trip that asks the brand for the
 * name by email; on reply we write it to campaign.brand and re-run the node.
 *
 * Requires a linked campaign to write the name back to — without one there is
 * nothing to persist, so we fall back to the plain MANUAL_REVIEW escalation
 * (blockedByMissingBrand's old behavior) rather than open an unresolvable loop.
 */
export async function openMissingBrandDecision(
  ctx: ExecutionContext,
  email: IEmailProvider,
): Promise<NodeResult> {
  const { campaign, creator, node } = ctx;
  const rerunFromState = RERUN_FROM_STATE[node.type];

  // No campaign to write the name back to (or an unknown node type) — we can't
  // auto-resolve, so keep the old dead-end behavior for a human to fix.
  if (!campaign?.id || !rerunFromState) {
    return {
      nextState: "MANUAL_REVIEW",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "MANUAL_REVIEW_FLAGGED",
      eventPayload: { outcome: "ESCALATE", reason: "missing_brand_name", node: node.type },
    };
  }

  const question = `What brand name should we use in emails to ${creator.name} (and other creators in this campaign)?`;

  return openBrandDecision(ctx, email, {
    reason: "missing_brand_name",
    question,
    // Only HANDOFF is a meaningful control action here; the name arrives as free
    // text. handoff lets a brand punt to a human.
    actions: ["handoff"],
    emailKind: "config",
    context: {
      reason: "missing_brand_name",
      actions: ["handoff"],
      kind: "config",
      blockedNodeType: node.type,
      campaignId: campaign.id,
      rerunFromState,
    },
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: { outcome: "ESCALATE", reason: "missing_brand_name", node: node.type },
  });
}

// ── Inbound / reply phase ────────────────────────────────────────────────────

/**
 * Handle a brand reply that arrived while the instance is AWAITING_BRAND_DECISION.
 * Runs the parse pipeline (deterministic tokens → AI fallback → AMBIGUOUS) and
 * maps the parsed action to the next state per the row's stored resolution map.
 *
 * Re-ask policy (§2.4): the FIRST ambiguous reply stays AWAITING_BRAND_DECISION
 * with reaskCount incremented (the executor's caller sends the clarification);
 * a SECOND ambiguous reply parks the run in MANUAL_REVIEW.
 */
export async function executeBrandDecision(
  ctx: ExecutionContext,
  _email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance } = ctx;

  if (instance.currentState !== "AWAITING_BRAND_DECISION") {
    throw new Error(
      `BRAND_DECISION reply expects AWAITING_BRAND_DECISION state, got ${instance.currentState}`,
    );
  }

  const decision = await findPendingBrandDecisionByInstance(instance.id);
  if (!decision) {
    // No pending decision to resolve — nothing to act on. Hand to a human rather
    // than guess. (Shouldn't happen: the run only enters this state via
    // openBrandDecision, which always creates the row first.)
    return manualReview(instance.id, "brand_decision_missing_row");
  }

  const context = (decision.contextJson ?? {}) as unknown as BrandDecisionContext;

  const messages = await listMessagesByInstance(instance.id);
  const latestInbound = messages.filter((m) => m.direction === "INBOUND").at(-1);
  const rawReply = latestInbound?.body ?? "";
  const replyText = rawReply ? extractReplyText(rawReply) : "";

  // ── L4 config-fix variant (missing_brand_name) ────────────────────────────
  // The "decision" here is a CONFIG VALUE, not APPROVE/REJECT: the brand's reply
  // IS the brand name. Write it back to the campaign and re-run the blocked node
  // (§3 Category D). HANDOFF still short-circuits to the dashboard so a brand who
  // can't supply a name can bail. An empty/unusable name re-asks once, then
  // dashboards — same policy as an ambiguous business reply.
  if (context.kind === "config") {
    return resolveConfigFix(decision.id, context, decision.reaskCount, replyText, rawReply);
  }

  // ── Parse pipeline (§2.4) ─────────────────────────────────────────────────
  // 1. deterministic token scan (a match wins immediately, no AI hop)
  let parse: BrandDecisionParse | null = scanBrandDecisionTokens(replyText);
  // 2. no token → AI fallback (reuses the classification adapter; degrades to
  //    AMBIGUOUS on a down agent — never guesses a money decision)
  if (!parse) {
    const ai = await agent.classifyBrandDecision(replyText);
    const belowThreshold = ai.confidence < BRAND_DECISION_CONFIDENCE_THRESHOLD;
    parse = {
      decision: belowThreshold ? "AMBIGUOUS" : ai.decision,
      confidence: ai.confidence,
      source: "agent",
      ...(ai.value !== undefined ? { value: ai.value } : {}),
    };
  }

  // An injection-suspected reply must never auto-map to APPROVE even if it says
  // "yes" — force at least one re-ask with a warning (§ infra table).
  if (context.injectionSuspected && parse.decision === "APPROVE") {
    parse = { decision: "AMBIGUOUS", confidence: parse.confidence, source: parse.source };
  }

  const commonPayload = {
    brandDecisionId: decision.id,
    reason: decision.reason,
    decision: parse.decision,
    confidence: parse.confidence,
    source: parse.source,
    ...(parse.value !== undefined ? { value: parse.value } : {}),
  };

  // ── Resolution map (answer → next state) ──────────────────────────────────
  switch (parse.decision) {
    case "AMBIGUOUS":
      return resolveAmbiguous(decision.id, decision.reaskCount, rawReply, commonPayload);

    case "HANDOFF":
      await recordResolution(decision.id, "HANDED_OFF", parse, rawReply);
      return {
        nextState: "MANUAL_REVIEW",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "MANUAL_REVIEW_FLAGGED",
        // Override the original escalation reason so the brand notice + audit
        // read "brand requested handoff", not e.g. "max_rounds_reached".
        eventPayload: { ...commonPayload, reason: "brand_requested_handoff", handoff: true },
      };

    case "REJECT":
      await recordResolution(decision.id, "RESOLVED", parse, rawReply);
      return {
        nextState: "REJECTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        eventPayload: commonPayload,
      };

    case "APPROVE":
      await recordResolution(decision.id, "RESOLVED", parse, rawReply);
      // What APPROVE means depends on WHY we paged the brand:
      //
      //   low_confidence_reply (A1/A2) — the brand is reading the creator's
      //     INTENT, not signing off on a money deal. "Approve" = "yes, they're
      //     interested" → resume NEGOTIATING so the negotiation node runs the
      //     normal present/counter logic against the creator's reply (which is
      //     already in the thread). This does NOT close a deal.
      //
      //   max_rounds_reached / escalated (B9/B10) — the brand is approving the
      //     creator's NUMBER → ACCEPTED, which auto-advances into Reward Setup
      //     exactly as a normal negotiation acceptance does (§3 B9/B10).
      if (context.reason === "low_confidence_reply") {
        return {
          nextState: "NEGOTIATING",
          nextNodeId: context.negotiationNodeId ?? null,
          eventType: "REPLY_CLASSIFIED",
          // Reads as the brand resolving the ambiguous reply to POSITIVE.
          eventPayload: { ...commonPayload, resolvedIntent: "POSITIVE", resumedNegotiation: true },
        };
      }
      return {
        nextState: "ACCEPTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        eventPayload: { ...commonPayload, approvedRate: context.creatorRate },
      };

    case "COUNTER":
      await recordResolution(decision.id, "RESOLVED", parse, rawReply);
      // For A1/A2, a brand COUNTER <n> means "read them as proposing <n>" — the
      // conversation is still early (round 0), so we can safely resume the
      // negotiation node, which reads the creator's reply + the number now on the
      // thread and steps normally. No max-rounds loop risk here (unlike B9).
      if (context.reason === "low_confidence_reply") {
        return {
          nextState: "NEGOTIATING",
          nextNodeId: context.negotiationNodeId ?? null,
          eventType: "REPLY_CLASSIFIED",
          eventPayload: {
            ...commonPayload,
            resolvedIntent: "POSITIVE",
            resumedNegotiation: true,
            ...(parse.value !== undefined ? { seededRate: parse.value } : {}),
          },
        };
      }
      // B9/B11 locked decision 1: a brand COUNTER is a FINAL take-it-or-leave-it
      // offer to the creator, NOT a re-opened negotiation round. Delivering it
      // requires a one-shot "final offer sent" sub-state that waits on the
      // creator for accept/reject only (§2.2 implementation note) — that
      // machinery is a follow-on checklist item and is NOT built in this pass.
      //
      // Critically, we must NOT resume the NEGOTIATION node here: the run is at
      // negotiationRound >= maxRounds, so re-entering NEGOTIATING would re-trip
      // the max-rounds hard stop and open another brand decision — an infinite
      // loop. Until the final-offer sub-state exists, a brand counter is parked
      // for a human, who sends the final offer manually. The brand's number is
      // recorded on the BrandDecision (decisionValue) + event for that handoff.
      return {
        nextState: "MANUAL_REVIEW",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "MANUAL_REVIEW_FLAGGED",
        eventPayload: {
          ...commonPayload,
          brandCounter: parse.value,
          finalOffer: true,
          reason: "brand_final_counter_pending_delivery",
        },
      };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// First ambiguous reply → re-ask once (stay AWAITING_BRAND_DECISION, bump
// reaskCount). Second → dashboard (MANUAL_REVIEW). The clarification email send
// is the caller's job (inbound worker), driven by the REASKED status.
async function resolveAmbiguous(
  decisionId: string,
  reaskCount: number,
  rawReply: string,
  payload: Record<string, unknown>,
): Promise<NodeResult> {
  if (reaskCount >= 1) {
    await updateBrandDecision(decisionId, {
      status: "HANDED_OFF",
      brandReplyRaw: rawReply,
      decision: "AMBIGUOUS",
      resolvedAt: new Date(),
    });
    return {
      nextState: "MANUAL_REVIEW",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "MANUAL_REVIEW_FLAGGED",
      // Descriptive reason so the brand notice + audit read "ambiguous after
      // re-ask", not the original escalation reason.
      eventPayload: { ...payload, reason: "brand_reply_ambiguous_after_reask", reaskExhausted: true },
    };
  }
  await updateBrandDecision(decisionId, {
    status: "REASKED",
    brandReplyRaw: rawReply,
    decision: "AMBIGUOUS",
    reaskCount: reaskCount + 1,
  });
  return {
    // Stay parked; the caller sends one clarification email.
    nextState: "AWAITING_BRAND_DECISION",
    nextNodeId: null,
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: { ...payload, reasked: true, reaskCount: reaskCount + 1 },
  };
}

// ── L4 config-fix resolution ─────────────────────────────────────────────────
// The brand's reply supplies the missing brand name. HANDOFF short-circuits to
// the dashboard; otherwise the reply text (sanitized) becomes campaign.brand and
// we transition back to the state the blocked node runs FROM, so a re-enqueued
// node-execution job re-runs that node — now with a resolvable name. An empty /
// unusable name re-asks once, then dashboards.
async function resolveConfigFix(
  decisionId: string,
  context: BrandDecisionContext,
  reaskCount: number,
  replyText: string,
  rawReply: string,
): Promise<NodeResult> {
  // A brand that can't/won't supply a name can still bail to a human.
  const token = scanBrandDecisionTokens(replyText);
  if (token?.decision === "HANDOFF") {
    await updateBrandDecision(decisionId, {
      status: "HANDED_OFF",
      brandReplyRaw: rawReply,
      decision: "HANDOFF",
      resolvedAt: new Date(),
    });
    return {
      nextState: "MANUAL_REVIEW",
      nextNodeId: null,
      completedAt: new Date(),
      eventType: "MANUAL_REVIEW_FLAGGED",
      eventPayload: { brandDecisionId: decisionId, reason: "brand_requested_handoff", handoff: true },
    };
  }

  const name = sanitizeBrandName(replyText);
  if (!name || !context.campaignId || !context.rerunFromState) {
    // No usable name (or we can't re-run without the campaign/state) — re-ask
    // once, then dashboard. Mirrors the ambiguous-reply policy.
    return resolveAmbiguous(decisionId, reaskCount, rawReply, {
      brandDecisionId: decisionId,
      reason: context.reason,
      kind: "config",
    });
  }

  // Write the supplied name back to the campaign, then record + re-run.
  await updateCampaign(context.campaignId, { brand: name });
  await updateBrandDecision(decisionId, {
    status: "RESOLVED",
    brandReplyRaw: rawReply,
    decision: "CONFIG",
    resolvedAt: new Date(),
  });

  // Transition BACK to the state the blocked node runs from; the caller re-
  // enqueues a node-execution job so the SAME node re-runs with the name present.
  return {
    nextState: context.rerunFromState as NodeResult["nextState"],
    nextNodeId: null,
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: {
      brandDecisionId: decisionId,
      reason: "missing_brand_name",
      resolvedBrandName: name,
      blockedNodeType: context.blockedNodeType ?? null,
      rerun: true,
    },
  };
}

// Turn a brand's free-text reply into a usable brand name, or "" if none.
// Takes the first non-empty line (brands often reply "It's Acme Co.\n\nThanks"),
// strips a leading "it's / it is / we're / the brand is", drops a trailing email
// sign-off ("... Thanks", "... Cheers"), trims surrounding punctuation, and caps
// the length. Conservative: a junk reply yields "" so the caller re-asks rather
// than writing garbage into every future email.
export function sanitizeBrandName(reply: string): string {
  const firstLine = (reply ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  let name = firstLine
    .replace(/^(?:it['’]s|it is|we['’]re|we are|the brand(?: name)? is|brand:?)\s+/i, "")
    // Drop a trailing sign-off that shared the line with the name
    // ("Acme Athletics. Thanks!" → "Acme Athletics").
    .replace(
      /[.,;:!\s]+(?:thanks(?:\s+so\s+much)?|thank\s+you|cheers|regards|best|thx|ty)\b.*$/i,
      "",
    )
    .replace(/[.!,;:]+$/g, "")
    .trim();
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name;
}

async function recordResolution(
  decisionId: string,
  status: "RESOLVED" | "HANDED_OFF",
  parse: BrandDecisionParse,
  rawReply: string,
): Promise<void> {
  await updateBrandDecision(decisionId, {
    status,
    brandReplyRaw: rawReply,
    decision: parse.decision,
    ...(parse.value !== undefined ? { decisionValue: parse.value } : {}),
    resolvedAt: new Date(),
  });
}

function manualReview(_instanceId: string, reason: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "MANUAL_REVIEW_FLAGGED",
    eventPayload: { reason },
  };
}

// Re-exported so callers can type the action union without importing the parse module.
export type { BrandDecisionAction };
