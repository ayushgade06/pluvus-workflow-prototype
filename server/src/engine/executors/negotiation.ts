import { createMessage } from "../../db/index.js";
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
  const { outcome, message } = await agent.negotiate(instance.negotiationRound, config);

  switch (outcome) {
    case "accept": {
      // Send acceptance confirmation email
      const draft = await email.draft(creator, message, config);
      const { messageId, threadId } = await email.send(draft, creator);

      await createMessage({
        instance: { connect: { id: instance.id } },
        direction: "OUTBOUND",
        subject: draft.subject,
        body: message,
        threadId,
        externalMessageId: messageId,
        sentAt: new Date(),
      });

      return {
        nextState: "ACCEPTED",
        nextNodeId: null,
        completedAt: new Date(),
        eventType: "NEGOTIATION_TURN",
        eventPayload: { outcome, round: instance.negotiationRound, message },
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

    case "counter": {
      const newRound = instance.negotiationRound + 1;

      // If we've hit the max rounds ceiling, end in rejection
      if (newRound >= maxRounds) {
        return {
          nextState: "REJECTED",
          nextNodeId: null,
          completedAt: new Date(),
          negotiationRound: newRound,
          eventType: "NEGOTIATION_TURN",
          eventPayload: {
            outcome: "reject",
            reason: "max_rounds_reached",
            round: newRound,
            message,
          },
        };
      }

      // Send counter-offer email
      const draft = await email.draft(creator, message, config);
      const { messageId, threadId } = await email.send(draft, creator);

      await createMessage({
        instance: { connect: { id: instance.id } },
        direction: "OUTBOUND",
        subject: draft.subject,
        body: message,
        threadId,
        externalMessageId: messageId,
        sentAt: new Date(),
      });

      return {
        nextState: "NEGOTIATING",
        nextNodeId: node.id, // stay at negotiation node
        negotiationRound: newRound,
        eventType: "NEGOTIATION_TURN",
        eventPayload: { outcome, round: newRound, message },
      };
    }
  }
}
