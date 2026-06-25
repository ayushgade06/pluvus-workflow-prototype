import { createMessage, listMessagesByInstance } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

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

  const { outcome, message } = await agent.negotiate(instance.negotiationRound, config, creatorReply);

  switch (outcome) {
    case "accept": {
      // Try AI-generated acceptance copy; fall back to agent-provided message.
      const aiDraft = await agent.draftEmail("acceptance", creator, config);
      const body = aiDraft?.body ?? message;

      const draft = aiDraft ?? await email.draft(creator, body, config);
      const { messageId, threadId } = await email.send(draft, creator);

      await createMessage({
        instance: { connect: { id: instance.id } },
        direction: "OUTBOUND",
        subject: draft.subject,
        body,
        threadId,
        externalMessageId: messageId,
        sentAt: new Date(),
      });

      return {
        nextState: "ACCEPTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        eventPayload: { outcome, round: instance.negotiationRound, message: body },
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
      const { messageId, threadId } = await email.send(draft, creator);

      await createMessage({
        instance: { connect: { id: instance.id } },
        direction: "OUTBOUND",
        subject: draft.subject,
        body,
        threadId,
        externalMessageId: messageId,
        sentAt: new Date(),
      });

      return {
        nextState: "AWAITING_REPLY",
        nextNodeId: node.id,
        negotiationRound: newRound,
        eventType: "NEGOTIATION_TURN",
        eventPayload: { outcome, round: newRound, message: body },
      };
    }
  }
}
