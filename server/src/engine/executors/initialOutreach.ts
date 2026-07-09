import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { sendOnce } from "./idempotentSend.js";
import { describeDeal } from "../dealDescription.js";
import {
  scanOutboundDraft,
  guardConstraintsFromConfig,
  maskGuardHits,
  type GuardHit,
} from "../guards/outputGuard.js";
import { mergeCampaignFallback } from "../campaignContext.js";

// H4: the output guard is documented as a MANDATORY net before ANY AI-generated
// email is sent, but outreach/follow-up sent unguarded. Outreach quotes NO money
// (rates are negotiated on reply), so any floor/ceiling number in the body is a
// leak. On a hit we route to MANUAL_REVIEW and do NOT send — a human reviews.
function outreachBlockedByGuard(hits: GuardHit[]): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "OUTREACH_DRAFTED",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "output_guard_blocked",
      // EASY-S2: mask the band VALUE — record only which KIND leaked.
      leaks: maskGuardHits(hits),
    },
  };
}

export async function executeInitialOutreach(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;

  if (instance.currentState !== "ENROLLED") {
    throw new Error(
      `INITIAL_OUTREACH expects ENROLLED state, got ${instance.currentState}`,
    );
  }

  // H5: fill missing brand context from the parent campaign (node config wins).
  const config = mergeCampaignFallback(node.config, ctx.campaign);
  const bodyTemplate = typeof config["bodyTemplate"] === "string" ? config["bodyTemplate"] : "";

  // Describe the deal structure (fixed fee / commission / both) from the
  // NEGOTIATION node so the outreach email explains the real offer instead of
  // vague filler. No dollar figures — those are negotiated on reply.
  const negotiationConfig = nodeGraph.find((n) => n.type === "NEGOTIATION")?.config;
  const dealDescription = describeDeal(negotiationConfig);

  // Try AI-generated draft first; fall back to template-based email.draft().
  const aiDraft = await agent.draftEmail("initial_outreach", creator, config, {
    ...(dealDescription ? { dealDescription } : {}),
  });
  const draft = aiDraft ?? await email.draft(creator, bodyTemplate, config);

  // H4: scan the rendered draft for a leaked floor/ceiling before sending. The
  // band lives on the NEGOTIATION node; outreach presents no rate, so nothing is
  // allowlisted. A hit routes to MANUAL_REVIEW instead of emailing the creator.
  const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(negotiationConfig ?? {}));
  if (!guard.ok) {
    return outreachBlockedByGuard(guard.hits);
  }

  // FIX-11: reserve-before-send so a crash between send and the row write can't
  // double-send the outreach on a BullMQ retry. One outreach per instance.
  const { messageId, threadId } = await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `outreach:${instance.id}`,
  );

  const nextNode = nodeGraph.find((n) => n.order === node.order + 1) ?? null;

  return {
    nextState: "OUTREACH_SENT",
    nextNodeId: nextNode?.id ?? null,
    eventType: "OUTREACH_DRAFTED",
    eventPayload: {
      subject: draft.subject,
      messageId,
      threadId,
      aiGenerated: aiDraft !== null,
    },
  };
}
