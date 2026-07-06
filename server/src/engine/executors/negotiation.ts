import {
  listMessagesByInstance,
  listEventsByInstance,
} from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { buildPriorContextFromEvents } from "./negotiationHistory.js";
import { scanOutboundDraft, guardConstraintsFromConfig, type GuardHit } from "../guards/outputGuard.js";
import { sendOnce } from "./idempotentSend.js";
import { describeDeal } from "../dealDescription.js";
import { extractReplyText } from "./replyText.js";
import { mergeCampaignFallback } from "../campaignContext.js";
import { openBrandDecision } from "./brandDecision.js";
import { resolveBand } from "../band.js";

// FIX-11: outbound AI sends use the shared reserve-before-send helper
// (idempotentSend.sendOnce), keyed on negotiation:<purpose>:<instance>:<round>,
// so a crash between email.send() and the row write cannot double-send a turn on
// a BullMQ retry.

// Build the MANUAL_REVIEW NodeResult emitted when the output guard blocks a
// draft. The email is NOT sent — a human reviews before anything reaches the
// creator (FIX-4). The leaked tokens are recorded for audit, but the offending
// draft body is deliberately not persisted as an outbound message.
function blockedByGuard(round: number, hits: GuardHit[]): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "output_guard_blocked",
      round,
      leaks: hits.map((h) => `${h.kind}:${h.value}`),
    },
  };
}

// Build the MANUAL_REVIEW NodeResult emitted when AI copy generation for an
// OFFER turn (present_offer / accept / counter) fails after retries. These turns
// PRESENT concrete terms (fee, commission, deliverables) and must read as a
// proper, well-formatted reply. The old behavior silently fell back to the
// sparse `negotiate` responseDraft — a one-line "$350.0" note that ignored the
// creator's questions. Rather than send that, route the turn to a human (the
// draftEmail path already retried before returning null). No email is sent.
function draftUnavailable(round: number, purpose: string): NodeResult {
  return {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "draft_generation_failed",
      purpose,
      round,
    },
  };
}

// The creator's most recent inbound message, EXCLUDING any inbound rows that are
// actually brand replies to an escalation email (A1/A2 low_confidence_reply: the
// brand answered "approve", which is persisted INBOUND on the same instance). If
// we didn't skip those, resuming negotiation after an A1/A2 approval would make
// the agent reason about the brand's word ("approve") as if the creator wrote it.
//
// Brand-decision replies are tagged on the INBOUND_REPLY_RECEIVED event with
// `brandDecisionReply: true` + the message's externalMessageId; we collect those
// ids and drop the matching messages. (Normal creator replies have no such tag.)
async function latestCreatorInbound(
  instanceId: string,
): Promise<{ body: string } | undefined> {
  const messages = await listMessagesByInstance(instanceId);
  const events = await listEventsByInstance(instanceId, { type: "INBOUND_REPLY_RECEIVED" });
  const brandReplyMsgIds = new Set(
    events
      .filter((e) => (e.payload as Record<string, unknown> | null)?.["brandDecisionReply"] === true)
      .map((e) => (e.payload as Record<string, unknown> | null)?.["externalMessageId"])
      .filter((id): id is string => typeof id === "string"),
  );
  return messages
    .filter((m) => m.direction === "INBOUND")
    .filter((m) => !(m.externalMessageId && brandReplyMsgIds.has(m.externalMessageId)))
    .at(-1);
}

// Best-effort extraction of a dollar amount the creator named in their reply
// (e.g. "I charge $480" / "480 dollars" / "my rate is 480" / "can you do 900").
// Used purely to let the counter/escalation copy ACKNOWLEDGE their ask — never to
// make the money decision (that stays deterministic in the agent). Returns
// undefined when no clear amount is present.
export function extractRequestedRate(text: string | undefined): number | undefined {
  if (!text) return undefined;
  // Priority 1: an explicit "$" amount. Priority 2: a number tagged "dollars"/
  // "usd". Priority 3: a BARE number adjacent to a rate-signalling word — this
  // catches the common "my rate is 900" / "I need 900" / "can you do 900" phrasing
  // that carries no currency marker, WITHOUT grabbing incidental counts like
  // "3 reels" (no rate word nearby → not matched).
  const dollar = text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  const worded = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:dollars|usd)\b/i);
  // An explicit "$" or "dollars" marker makes ANY number a rate (even "$3").
  const markedRaw = dollar?.[1] ?? worded?.[1];
  if (markedRaw) {
    const n = Number(markedRaw.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  // No currency marker: fall back to a BARE number adjacent to a rate-signalling
  // word — catches "my rate is 900" / "I need 900" / "can you do 900" WITHOUT a
  // "$". A rate word before the number ("rate is 900", "do 900") or after it
  // ("900 is my rate", "900 flat"). To avoid grabbing incidental counts that
  // happen to sit next to a generic word (e.g. "do 3 stories"), a bare number
  // must be money-plausible (>= MIN_BARE_RATE); real creator asks are never $3.
  const MIN_BARE_RATE = 50;
  const rateWord = "(?:rate|charge|charging|fee|price|priced|budget|ask(?:ing)?|need|want|pay|do|flat)";
  const bareBefore = text.match(
    new RegExp(`\\b${rateWord}\\b[^\\d]{0,12}(\\d[\\d,]*(?:\\.\\d+)?)`, "i"),
  );
  const bareAfter = text.match(
    new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)[^\\d]{0,12}\\b${rateWord}\\b`, "i"),
  );
  const bareRaw = bareBefore?.[1] ?? bareAfter?.[1];
  if (!bareRaw) return undefined;
  const bare = Number(bareRaw.replace(/,/g, ""));
  if (!Number.isFinite(bare) || bare < MIN_BARE_RATE) return undefined;
  return bare;
}

// Open the B9 max-rounds brand decision (§3 B9). Shared by BOTH callers that can
// reach the ceiling:
//   1. the hard stop at entry (instance re-enters already at negotiationRound >=
//      maxRounds), and
//   2. the counter path's secondary guard (a counter that WOULD push the round to
//      maxRounds — the round can't actually be sent, so instead of dead-ending in
//      MANUAL_REVIEW we page the brand for one final move).
// Both produce the identical actionable email (approve their number / final
// counter / reject / hand off) and park the run in AWAITING_BRAND_DECISION.
function openMaxRoundsBrandDecision(
  ctx: ExecutionContext,
  email: IEmailProvider,
  config: Record<string, unknown>,
  args: { creatorReply: string; maxRounds: number; round: number },
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;
  const { creatorReply, maxRounds, round } = args;
  const { floor, ceiling } = resolveBand(config);
  const creatorRate = extractRequestedRate(creatorReply);
  const band =
    floor !== undefined && ceiling !== undefined
      ? ` (your ceiling was ${ceiling}, floor ${floor})`
      : "";
  const rateClause =
    creatorRate !== undefined ? `Their latest ask is ${creatorRate}${band}.` : "";
  const question =
    `Negotiation with ${creator.name} reached the max of ${maxRounds} rounds ` +
    `without agreement. ${rateClause} Do you want to accept their number, or name ` +
    `one final counter? Any number you give is final — we won't negotiate further; ` +
    `the creator can only take it or leave it.`;

  return openBrandDecision(ctx, email, {
    reason: "max_rounds_reached",
    question,
    // Max-rounds offers all four actions: approve their number, counter (final),
    // reject, or hand off. (B10 over-ceiling, a later item, drops "counter".)
    actions: ["approve", "reject", "counter", "handoff"],
    context: {
      reason: "max_rounds_reached",
      actions: ["approve", "reject", "counter", "handoff"],
      negotiationNodeId: node.id,
      ...(creatorRate !== undefined ? { creatorRate } : {}),
      ...(floor !== undefined ? { floor } : {}),
      ...(ceiling !== undefined ? { ceiling } : {}),
      maxRounds,
      round,
    },
    ...(creatorReply ? { quotedReply: creatorReply } : {}),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "max_rounds_reached",
      round,
      maxRounds,
    },
  });
}

// Open the B10 over-ceiling / agent-escalate brand decision (§3 B10). The agent
// escalated because the creator's ask is above the internal ceiling (or the rate
// was unreadable). Instead of dead-ending in MANUAL_REVIEW, page the brand:
// approve the creator's number (overspend), reject, or hand off to a human.
//
// This is APPROVE/REJECT/HANDOFF only — no `counter`. Per the locked spec (§3
// B10 Step 2) an over-ceiling escalation is the brand's call to overspend or
// walk; we do NOT re-open negotiation with a brand counter here (that would
// require the creator-facing final-offer sub-state, a follow-on item). A brand
// who wants to propose a different number can HANDOFF to a human.
function openOverCeilingBrandDecision(
  ctx: ExecutionContext,
  email: IEmailProvider,
  config: Record<string, unknown>,
  args: { creatorReply: string; round: number; message: string },
): Promise<NodeResult> {
  const { node, creator } = ctx;
  const { creatorReply, round, message } = args;
  const { floor, ceiling } = resolveBand(config);
  const creatorRate = extractRequestedRate(creatorReply);

  // Build the ask. When we could read the creator's number, quote it against the
  // ceiling; when we couldn't, ask the brand to read the reply and decide.
  const ceilingClause =
    ceiling !== undefined ? ` (above your ceiling of ${ceiling})` : "";
  const question =
    creatorRate !== undefined
      ? `${creator.name} is asking for ${creatorRate}${ceilingClause}, which is ` +
        `more than this campaign's budget allows. This is approve-or-reject only ` +
        `— we won't negotiate further. Approve at ${creatorRate}, reject, or hand ` +
        `off to a human.`
      : `${creator.name} replied but we couldn't read a clear rate from their ` +
        `message. How do you want to proceed — approve continuing, reject, or ` +
        `hand off to a human?`;

  return openBrandDecision(ctx, email, {
    reason: "escalated",
    question,
    // Over-ceiling: approve (overspend) / reject / handoff. No counter (see above).
    actions: ["approve", "reject", "handoff"],
    context: {
      reason: "escalated",
      actions: ["approve", "reject", "handoff"],
      negotiationNodeId: node.id,
      ...(creatorRate !== undefined ? { creatorRate } : {}),
      ...(floor !== undefined ? { floor } : {}),
      ...(ceiling !== undefined ? { ceiling } : {}),
      round,
    },
    ...(creatorReply ? { quotedReply: creatorReply } : {}),
    eventType: "NEGOTIATION_TURN",
    eventPayload: {
      outcome: "ESCALATE",
      reason: "escalated",
      round,
      message,
      ...(creatorRate !== undefined ? { creatorRate } : {}),
    },
  });
}

export async function executeNegotiation(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;
  // H5: overlay the parent campaign's brand context onto the node config for any
  // brand field the config is missing (unstamped/legacy nodes), so the
  // negotiation + offer-copy LLM gets the real sender/brand/scope instead of
  // signing as "Pluvus Partnerships" with no scope. Node config always wins.
  const config = mergeCampaignFallback(node.config, ctx.campaign);

  if (instance.currentState !== "NEGOTIATING") {
    throw new Error(
      `NEGOTIATION expects NEGOTIATING state, got ${instance.currentState}`,
    );
  }

  // When the workflow has a Reward Setup node, it owns the post-acceptance
  // confirmation email ("Campaign Agreement Confirmation" → asks the creator to
  // reply "I Agree"). In that case the negotiation ACCEPT must NOT also send its
  // own onboarding/acceptance email, or the creator gets two overlapping emails.
  // Legacy workflows (no REWARD_SETUP node) keep sending the onboarding email as
  // the final touch.
  const hasRewardSetup = nodeGraph.some((n) => n.type === "REWARD_SETUP");

  const maxRounds = typeof config["maxRounds"] === "number" ? config["maxRounds"] : 5;

  // Describe the deal structure (fixed fee / commission / both) from THIS
  // (NEGOTIATION) node's config, exactly as outreach/follow-up do. Threading it
  // into the offer/counter copy lets the email explain WHAT KIND of deal this is
  // (e.g. "hybrid — fixed fee plus commission") instead of only quoting a fee.
  const dealDescription = describeDeal(config);

  // Latest creator reply, skipping brand escalation replies (see helper). H1:
  // strip quoted thread + signature so the negotiation agent reasons about (and
  // the counter copy acknowledges) the creator's ACTUAL words, not our own quoted
  // outreach. Also feeds extractRequestedRate below — a "$500" in our quoted
  // history must not be mistaken for the creator's ask.
  const latestInbound = await latestCreatorInbound(instance.id);
  const creatorReply = latestInbound?.body ? extractReplyText(latestInbound.body) : "";

  // Hard stop — enforce maxRounds before calling the agent.
  // This prevents the agent from even being consulted past the ceiling.
  //
  // B9 (max_rounds_reached): instead of dead-ending in MANUAL_REVIEW, open a
  // brand-decision round-trip — the brand gets ONE more move (approve the
  // creator's number, name a final counter, reject, or hand off) and the run
  // auto-resumes on their reply. See MANUAL_ESCALATION_RESOLUTION.md §3 B9.
  if (instance.negotiationRound >= maxRounds) {
    return openMaxRoundsBrandDecision(ctx, email, config, {
      creatorReply,
      maxRounds,
      round: instance.negotiationRound,
    });
  }

  // FIX-1/FIX-2: assemble the conversation so far from persisted NEGOTIATION_TURN
  // events and thread it into the (stateless) agent so it can reason about the
  // trajectory and knows its own last offer.
  const priorEvents = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
  const priorContext = buildPriorContextFromEvents(priorEvents);

  const { outcome, message, proposedRate } = await agent.negotiate(
    instance.negotiationRound,
    config,
    creatorReply,
    priorContext,
  );

  switch (outcome) {
    case "present_offer": {
      // The creator ASKED about terms (no number proposed). Present the fee
      // (+ commission) as information and wait for their actual response —
      // WITHOUT consuming a negotiation round. A curious creator's questions
      // must not exhaust the negotiation budget. We reuse the offer-presenting
      // draft (counter_offer purpose) so the email states the fixed fee and, for
      // a hybrid deal, the commission.
      const aiDraft = await agent.draftEmail("counter_offer", creator, config, {
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(dealDescription ? { dealDescription } : {}),
      });
      // A present-offer email PRESENTS concrete terms. When the REAL AI copy
      // generator returns null it means generation failed after retries — escalate
      // to a human rather than send the sparse negotiate responseDraft that only
      // quotes a fee. (For the mock provider, null just means "use the template";
      // that path keeps the existing fallback so mock-mode dev/harnesses work.)
      if (aiDraft === null && agent.generatesDraftCopy) {
        return draftUnavailable(instance.negotiationRound, "present_offer");
      }
      const body = aiDraft?.body ?? message;
      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: the presented fee is allowlisted; still scan for floor/ceiling leak.
      const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, proposedRate));
      if (!guard.ok) {
        return blockedByGuard(instance.negotiationRound, guard.hits);
      }

      // Idempotent send keyed on (instance, present, round) — re-asking at the
      // same round (e.g. a duplicate webhook) won't double-send.
      await sendOnce(
        email,
        instance.id,
        creator,
        draft,
        `negotiation:present:${instance.id}:${instance.negotiationRound}`,
      );

      // Back to AWAITING_REPLY at the SAME node and the SAME round (no increment).
      return {
        nextState: "AWAITING_REPLY",
        nextNodeId: node.id,
        // negotiationRound intentionally omitted → unchanged.
        eventType: "NEGOTIATION_TURN",
        eventPayload: {
          outcome: "present_offer",
          round: instance.negotiationRound,
          message: body,
          ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
        },
      };
    }

    case "accept": {
      // Reward Setup present → it owns the post-acceptance email. Skip the
      // negotiation's own onboarding/acceptance send entirely and just transition
      // to ACCEPTED; the Reward Setup node then sends the single, properly
      // formatted "Campaign Agreement Confirmation" (bulleted terms + "I Agree").
      if (hasRewardSetup) {
        return {
          nextState: "ACCEPTED",
          nextNodeId: null,
          completedAt: new Date(),
          eventType: "NEGOTIATION_TURN",
          eventPayload: {
            outcome,
            round: instance.negotiationRound,
            message,
            ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
          },
        };
      }

      // An ACCEPT now always carries a real agreed rate (the agent only
      // returns accept when a concrete number is on the table — a bare "I'm
      // interested" with no number counters instead). On a genuine, money-
      // confirmed acceptance we send the ONBOARDING email — it confirms the
      // agreed rate and lays out next steps (contract, deliverables, timeline,
      // payment) — rather than a generic "we accept" note. proposedTerms.rate
      // gives the onboarding copy the exact agreed figure.
      // Defensive fallback: if (somehow) no rate is present, fall back to the
      // plain acceptance copy so we never send onboarding with a blank rate.
      const purpose = proposedRate !== undefined ? "onboarding" : "acceptance";
      const extra = {
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(dealDescription ? { dealDescription } : {}),
      };
      const aiDraft = await agent.draftEmail(purpose, creator, config, extra);
      // The acceptance/onboarding email confirms the agreed rate and lays out
      // next steps — too important to degrade to the sparse fallback. When the
      // REAL AI generator returns null (retries exhausted), escalate to a human.
      // (Mock null → keep the template fallback so harnesses still close deals.)
      if (aiDraft === null && agent.generatesDraftCopy) {
        return draftUnavailable(instance.negotiationRound, purpose);
      }
      const body = aiDraft?.body ?? message;

      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: scan the rendered draft for leaked floor/ceiling before sending.
      // The agreed rate is allowlisted (it is the offer we mean to present).
      const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, proposedRate));
      if (!guard.ok) {
        return blockedByGuard(instance.negotiationRound, guard.hits);
      }

      // FIX-11: idempotent send keyed on (instance, acceptance, round).
      await sendOnce(
        email,
        instance.id,
        creator,
        draft,
        `negotiation:acceptance:${instance.id}:${instance.negotiationRound}`,
      );

      return {
        nextState: "ACCEPTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        // Persist the agreed rate (FIX-2) so it is recoverable for audit and
        // for threading as currentOffer on any subsequent turn.
        eventPayload: {
          outcome,
          round: instance.negotiationRound,
          message: body,
          ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
        },
      };
    }

    case "reject": {
      return {
        nextState: "REJECTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        eventPayload: { outcome, round: instance.negotiationRound, message },
      };
    }

    case "escalate": {
      // B10 (§3): the agent escalated because the creator's ask is above the
      // internal ceiling (or the rate was unreadable). Instead of dead-ending in
      // MANUAL_REVIEW, page the brand for an approve/reject/handoff decision and
      // park in AWAITING_BRAND_DECISION; the run auto-resumes on the brand's reply.
      return openOverCeilingBrandDecision(ctx, email, config, {
        creatorReply,
        round: instance.negotiationRound,
        message,
      });
    }

    case "counter": {
      const newRound = instance.negotiationRound + 1;

      // Secondary guard: incrementing would hit or exceed maxRounds. We can't send
      // another counter that can't be replied to within the allowed window — so
      // instead of dead-ending in MANUAL_REVIEW, this IS the max-rounds moment (B9):
      // page the brand for one final move (approve their number / final counter /
      // reject / hand off) and park the run in AWAITING_BRAND_DECISION. Same
      // actionable email + resolution loop as the entry hard stop above; the run
      // auto-resumes on the brand's reply. Previously this was the unreachable-B9
      // gap — a straight counter→counter never entered the hard stop at >=maxRounds
      // because this guard bailed to a dashboard-only MANUAL_REVIEW first.
      if (newRound >= maxRounds) {
        return openMaxRoundsBrandDecision(ctx, email, config, {
          creatorReply,
          maxRounds,
          // Report the ceiling round we've reached, not a half-advanced counter.
          round: maxRounds,
        });
      }

      // Try AI-generated counter copy; fall back to agent-provided message.
      // Pass the concrete rate we're countering with so the draft anchors on
      // THAT number ($350) instead of reaching for the budget range — which the
      // output guard would (correctly) block as a floor/ceiling leak. Also
      // thread the creator's reply + the rate they asked for so the counter
      // acknowledges their request ("we considered your $480 …") and reads like
      // an ongoing conversation rather than a cold first contact.
      const creatorRequestedRate = extractRequestedRate(creatorReply);
      const counterExtra = {
        round: newRound,
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(creatorRequestedRate !== undefined ? { creatorRequestedRate } : {}),
        ...(dealDescription ? { dealDescription } : {}),
      };
      const aiDraft = await agent.draftEmail("counter_offer", creator, config, counterExtra);
      // The counter email presents the fee + commission + deliverables and
      // should answer the creator's questions. When the REAL AI generator returns
      // null (retries exhausted), escalate to a human — do NOT send the sparse
      // negotiate responseDraft (the "$350.0" one-liner that ignored the
      // creator's questions). The round was NOT yet advanced (that only happens
      // on a successful send below), so a human picks up at the same point.
      // (Mock null → keep the template fallback so mock-mode counters still send.)
      if (aiDraft === null && agent.generatesDraftCopy) {
        return draftUnavailable(newRound, "counter_offer");
      }
      const body = aiDraft?.body ?? message;

      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: scan the rendered counter draft for leaked floor/ceiling before
      // sending. The rate we are countering with is allowlisted.
      const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, proposedRate));
      if (!guard.ok) {
        return blockedByGuard(newRound, guard.hits);
      }

      // FIX-11: idempotent send keyed on (instance, counter_offer, newRound).
      await sendOnce(
        email,
        instance.id,
        creator,
        draft,
        `negotiation:counter_offer:${instance.id}:${newRound}`,
      );

      return {
        nextState: "AWAITING_REPLY",
        nextNodeId: node.id,
        negotiationRound: newRound,
        eventType: "NEGOTIATION_TURN",
        // Persist the rate we just countered with (FIX-2) so the next turn knows
        // its own last offer instead of falling back to the floor.
        eventPayload: {
          outcome,
          round: newRound,
          message: body,
          ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
        },
      };
    }
  }
}
