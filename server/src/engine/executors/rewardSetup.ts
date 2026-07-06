import { listEventsByInstance } from "../../db/index.js";
import type { ExecutionContext, NodeResult } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { resolveAgreedFee, firstNumber, firstString } from "./agreedFee.js";
import { scanOutboundDraft, guardConstraintsFromConfig } from "../guards/outputGuard.js";
import { sendOnce } from "./idempotentSend.js";
import { blockedByGuard } from "./guardEscalation.js";
import { openMissingBrandDecision } from "./brandDecision.js";
import { renderRewardConfirmationEmail } from "./rewardEmail.js";
import { resolveBrandName } from "../campaignContext.js";

// ---------------------------------------------------------------------------
// Reward Setup executor
// ---------------------------------------------------------------------------
// Runs immediately after a successful negotiation (state ACCEPTED). It
// finalizes the commercial agreement:
//   1. Resolves the final agreed fee (the rate the negotiation closed on),
//      the commission %, and the deliverables — all from the node config +
//      the persisted NEGOTIATION_TURN history.
//   2. Sends the "Campaign Agreement Confirmation" email asking the creator to
//      reply "I Agree".
//   3. Transitions ACCEPTED → REWARD_PENDING and WAITS there.
//
// It does NOT negotiate. The creator's agreement reply is handled separately by
// executeRewardReply (driven by the inbound-email worker) which advances the
// instance to REWARD_CONFIRMED on a positive reply.

// resolveAgreedFee (plus firstNumber/firstString) now live in ./agreedFee.ts so
// the Content Brief executor can share the finalized-terms resolution. Re-exported
// here to keep existing importers (rewardReply, paymentReply, tests) unchanged.
export { resolveAgreedFee };

export async function executeRewardSetup(
  ctx: ExecutionContext,
  email: IEmailProvider,
  agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, nodeGraph, creator } = ctx;
  const config = node.config;

  if (instance.currentState !== "ACCEPTED") {
    throw new Error(
      `REWARD_SETUP expects ACCEPTED state, got ${instance.currentState}`,
    );
  }

  // The brand's negotiation commission is stamped onto THIS node's config at
  // save/publish (stampRewardFromNegotiation in routes/workflows.ts), so the
  // reward node's own config is the finalized value the builder also displays.
  // We read the NEGOTIATION node as a defensive fallback for versions published
  // before the stamp (or instances created directly, e.g. in tests/harnesses).
  const negotiationConfig =
    nodeGraph.find((n) => n.type === "NEGOTIATION")?.config ?? {};

  // Assemble the finalized terms from persisted negotiation history + config.
  const events = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
  const agreedFee = resolveAgreedFee(events, negotiationConfig, config);
  const commissionRate = firstNumber(
    config["commissionRate"],
    negotiationConfig["commissionRate"],
  );
  // Deliverables are a campaign-level field stamped into every node's config
  // (see campaigns.ts / restampBrand). Prefer this node's stamped copy, then the
  // negotiation node's value.
  const deliverables = firstString(
    config["deliverables"],
    negotiationConfig["deliverables"],
  );
  // Timeline is likewise a campaign-level field stamped into node config; state
  // it in the confirmation only when present.
  const timeline = firstString(
    config["timeline"],
    negotiationConfig["timeline"],
  );
  // Product/sample reward blurb — also a campaign-level stamped field; rendered
  // as its own bullet in the confirmation only when present.
  const rewardDescription = firstString(
    config["rewardDescription"],
    negotiationConfig["rewardDescription"],
  );

  // Draft the "Campaign Agreement Confirmation" email. The confirmation copy is
  // a fixed template (renderRewardConfirmationEmail); we still offer the AI draft
  // path (reward_confirmation purpose) so a real provider can enrich the copy,
  // but the template is the authoritative fallback — unlike the other executors
  // this never degrades to a generic body, since the confirmation must always
  // state the terms and ask for "I Agree".
  // L4: resolve the brand from config → parent campaign. If neither has it, fail
  // loud to MANUAL_REVIEW rather than email the creator "your brand".
  const brandName = resolveBrandName(config, ctx.campaign);
  if (brandName === undefined) {
    // L4 config-fix: instead of dead-ending in MANUAL_REVIEW, ask the brand for
    // the missing name by email and re-run this node once it's supplied.
    return openMissingBrandDecision(ctx, email);
  }
  const senderName =
    typeof config["senderName"] === "string" ? (config["senderName"] as string) : brandName;
  const templateDraft = renderRewardConfirmationEmail({
    creatorName: creator.name,
    brandName,
    senderName,
    fixedFee: agreedFee,
    commissionRate,
    deliverables,
    timeline,
    rewardDescription,
  });
  const aiDraft = await agent.draftEmail("reward_confirmation", creator, config, {
    ...(agreedFee !== undefined ? { proposedTerms: { rate: agreedFee } } : {}),
  });
  const draft = aiDraft ?? templateDraft;

  // FIX-4 parity: scan the rendered draft for a leaked floor/ceiling before
  // sending. The agreed fee is the number we mean to present, so it's allowlisted.
  const guard = scanOutboundDraft(draft, guardConstraintsFromConfig(config, agreedFee));
  if (!guard.ok) {
    return blockedByGuard(instance.negotiationRound, guard.hits);
  }

  // Idempotent send keyed on (instance, reward_confirmation) — a re-run of the
  // ACCEPTED auto-chain (e.g. a BullMQ retry) won't double-send the email.
  await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `reward:confirmation:${instance.id}`,
  );

  // Enter the waiting state. Stay on THIS node so an inbound reply is handled by
  // the reward-reply path, and expose the normal output connection (nextNodeId
  // points at whatever node follows — Payment Info, once it exists) for later.
  return {
    nextState: "REWARD_PENDING",
    nextNodeId: node.id,
    eventType: "REWARD_SETUP_SENT",
    eventPayload: {
      ...(agreedFee !== undefined ? { fixedFee: agreedFee } : {}),
      ...(commissionRate !== undefined ? { commission: commissionRate } : {}),
      ...(deliverables ? { deliverables } : {}),
    },
  };
}
