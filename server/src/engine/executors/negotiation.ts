import {
  listMessagesByInstance,
  listEventsByInstance,
} from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { buildPriorContextFromEvents } from "./negotiationHistory.js";
import { scanOutboundDraft, guardConstraintsFromConfig, type GuardHit } from "../guards/outputGuard.js";
import { sendOnce } from "./idempotentSend.js";

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
  const { instance, node, creator } = ctx;
  const config = node.config;

  if (instance.currentState !== "NEGOTIATING") {
    throw new Error(
      `NEGOTIATION expects NEGOTIATING state, got ${instance.currentState}`,
    );
  }

  const maxRounds = typeof config["maxRounds"] === "number" ? config["maxRounds"] : 5;

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
    case "accept": {
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
      };
      const aiDraft = await agent.draftEmail(purpose, creator, config, extra);
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
      };
      const aiDraft = await agent.draftEmail("counter_offer", creator, config, counterExtra);
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
