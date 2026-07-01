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

// Best-effort extraction of a dollar amount the creator named in their reply
// (e.g. "I charge $480" / "480 dollars" / "my rate is 480"). Used purely to let
// the counter copy ACKNOWLEDGE their ask — never to make the money decision
// (that stays deterministic in the agent). Returns undefined when no clear
// amount is present.
export function extractRequestedRate(text: string | undefined): number | undefined {
  if (!text) return undefined;
  // Prefer an explicit "$" amount; fall back to a number near "dollars"/"rate".
  const dollar = text.match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  const worded = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:dollars|usd)\b/i);
  const raw = dollar?.[1] ?? worded?.[1];
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export async function executeNegotiation(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;
  const config = node.config;

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

  // Hard stop — enforce maxRounds before calling the agent.
  // This prevents the agent from even being consulted past the ceiling.
  if (instance.negotiationRound >= maxRounds) {
    return {
      nextState: "MANUAL_REVIEW",
      nextNodeId: null,
      completedAt: new Date(),
      negotiationRound: instance.negotiationRound,
      eventType: "NEGOTIATION_TURN",
      eventPayload: {
        outcome: "ESCALATE",
        reason: "max_rounds_reached",
        round: instance.negotiationRound,
        maxRounds,
      },
    };
  }

  const messages = await listMessagesByInstance(instance.id);
  const latestInbound = messages.filter((m) => m.direction === "INBOUND").at(-1);
  const creatorReply = latestInbound?.body ?? "";

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
      return {
        nextState: "MANUAL_REVIEW",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        eventPayload: { outcome, reason: "escalated", round: instance.negotiationRound, message },
      };
    }

    case "counter": {
      const newRound = instance.negotiationRound + 1;

      // Secondary guard: if incrementing would hit or exceed maxRounds, escalate
      // to MANUAL_REVIEW instead of sending another counter that can't be
      // replied to within the allowed window.
      if (newRound >= maxRounds) {
        return {
          nextState: "MANUAL_REVIEW",
          nextNodeId: null,
          completedAt: new Date(),
          negotiationRound: newRound,
          eventType: "NEGOTIATION_TURN",
          eventPayload: {
            outcome: "ESCALATE",
            reason: "max_rounds_reached_on_counter",
            round: newRound,
            maxRounds,
          },
        };
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
