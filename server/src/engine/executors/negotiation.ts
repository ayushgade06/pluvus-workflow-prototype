import {
  createMessage,
  listMessagesByInstance,
  listEventsByInstance,
  updateMessageSent,
} from "../../db/index.js";
import type { Creator } from "@prisma/client";
import type { ExecutionContext, NodeResult, EmailDraft } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { buildPriorContextFromEvents } from "./negotiationHistory.js";
import { scanOutboundDraft, guardConstraintsFromConfig, type GuardHit } from "../guards/outputGuard.js";

// FIX-11: send an outbound AI email at most once per (instance, purpose, round).
//
// The risk being closed: a crash *between* email.send() and the message-row
// write would, on BullMQ retry, re-run the executor and send a SECOND email to
// the creator. To prevent that we RESERVE a deterministic idempotency key
// BEFORE sending, using the row's unique constraint as the lock:
//
//   1. Insert the message row with idempotencyKey (no provider id yet).
//      - If this throws a unique-violation, a prior attempt already reserved
//        (and almost certainly sent) this exact turn → skip the send.
//   2. Send the email.
//   3. Update the reserved row with the provider's messageId/threadId.
//
// This means the send is guarded by a committed DB reservation, so a crash
// after step 1 leaves a detectable reserved-but-unsent row (a missed send, which
// is safe) rather than causing a duplicate send.
async function sendOnce(
  email: IEmailProvider,
  instanceId: string,
  creator: Creator,
  draft: EmailDraft,
  body: string,
  purpose: "acceptance" | "counter_offer",
  round: number,
): Promise<void> {
  const idempotencyKey = `negotiation:${purpose}:${instanceId}:${round}`;

  // Step 1 — reserve. createMessage relies on the unique constraint on
  // idempotencyKey to reject a concurrent/retry attempt.
  let reserved;
  try {
    reserved = await createMessage({
      instance: { connect: { id: instanceId } },
      direction: "OUTBOUND",
      subject: draft.subject,
      body,
      idempotencyKey,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Already reserved/sent on a prior attempt — do not send again.
      return;
    }
    throw err;
  }

  // Step 2 — send (now guarded by the committed reservation).
  const { messageId, threadId } = await email.send(draft, creator);

  // Step 3 — finalize the reserved row with the provider's identifiers.
  await updateMessageSent(reserved.id, { externalMessageId: messageId, threadId });
}

// Prisma unique-constraint violation is error code P2002.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

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
      // Try AI-generated acceptance copy; fall back to agent-provided message.
      const aiDraft = await agent.draftEmail("acceptance", creator, config);
      const body = aiDraft?.body ?? message;

      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: scan the rendered draft for leaked floor/ceiling before sending.
      // The agreed rate is allowlisted (it is the offer we mean to present).
      const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, proposedRate));
      if (!guard.ok) {
        return blockedByGuard(instance.negotiationRound, guard.hits);
      }

      // FIX-11: idempotent send keyed on (instance, acceptance, round).
      await sendOnce(email, instance.id, creator, draft, body, "acceptance", instance.negotiationRound);

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
      const aiDraft = await agent.draftEmail("counter_offer", creator, config, { round: newRound });
      const body = aiDraft?.body ?? message;

      const draft = aiDraft ?? await email.draft(creator, body, config);

      // FIX-4: scan the rendered counter draft for leaked floor/ceiling before
      // sending. The rate we are countering with is allowlisted.
      const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, proposedRate));
      if (!guard.ok) {
        return blockedByGuard(newRound, guard.hits);
      }

      // FIX-11: idempotent send keyed on (instance, counter_offer, newRound).
      await sendOnce(email, instance.id, creator, draft, body, "counter_offer", newRound);

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
