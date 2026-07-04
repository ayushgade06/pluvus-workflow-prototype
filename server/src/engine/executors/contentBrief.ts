import type { Prisma } from "@prisma/client";
import type { ExecutionContext, NodeResult, EmailAttachment } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import { readStoredFile } from "../../storage/localFileStorage.js";
import { sendOnce } from "./idempotentSend.js";
import { renderContentBriefEmail } from "./contentBriefEmail.js";
import { resolveBrandName } from "../campaignContext.js";
import { openMissingBrandDecision } from "./brandDecision.js";

// ---------------------------------------------------------------------------
// Content Brief executor
// ---------------------------------------------------------------------------
// Runs immediately after the creator's payout information is collected (state
// PAYMENT_RECEIVED). Its single responsibility is to send the campaign brief:
//   1. Read the brand-configured settings (brief PDF reference, referral link,
//      optional creator notes) from the node config.
//   2. Load the uploaded PDF from local storage and attach it.
//   3. Send the "Your Campaign Brief" email through the existing email provider,
//      idempotently (a worker retry never sends a duplicate).
//   4. Transition PAYMENT_RECEIVED → CONTENT_BRIEF_SENT and complete.
//
// It has NO waiting state: there is no creator acknowledgement, no approval, and
// no follow-up. On a successful send the node is done and hands control back to
// the workflow engine (Content Brief is the terminal node, so completedAt is
// stamped and nextNodeId is null).

/** First non-empty string among the candidates, else "". */
function str(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v.trim() : "";
}

export async function executeContentBrief(
  ctx: ExecutionContext,
  email: IEmailProvider,
  _agent: IAgentProvider,
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;
  const config = node.config;

  if (instance.currentState !== "PAYMENT_RECEIVED") {
    throw new Error(
      `CONTENT_BRIEF expects PAYMENT_RECEIVED state, got ${instance.currentState}`,
    );
  }

  // 1. Read the brand-supplied configuration.
  const briefFileRef = str(config, "briefFileRef");
  const briefFileName = str(config, "briefFileName") || "campaign-brief.pdf";
  const referralLink = str(config, "referralLink");
  const creatorNotes = str(config, "creatorNotes");
  const rewardDescription = str(config, "rewardDescription");

  // The Campaign Brief PDF is required (enforced at publish/launch validation);
  // fail loudly if it's somehow missing at runtime rather than sending a brief
  // email with no brief. A thrown error preserves the engine's retry/error
  // handling — the same behavior every other executor relies on.
  if (!briefFileRef) {
    throw new Error(
      `CONTENT_BRIEF for ${instance.id} has no campaign brief PDF configured (briefFileRef)`,
    );
  }

  // 2. Load the uploaded PDF from local storage and build the attachment.
  const content = await readStoredFile(briefFileRef);
  const attachment: EmailAttachment = {
    filename: briefFileName,
    contentType: "application/pdf",
    content,
  };

  // 3. Draft the deterministic "Your Campaign Brief" email. Brand name is stamped
  //    into node config (restampBrand). L4: resolve from config → campaign; if
  //    neither has it, fail loud to MANUAL_REVIEW rather than email "your brand".
  const brandName = resolveBrandName(config, ctx.campaign);
  if (brandName === undefined) {
    // L4 config-fix: ask the brand for the missing name by email and re-run this
    // node once it's supplied, instead of dead-ending in MANUAL_REVIEW.
    return openMissingBrandDecision(ctx, email);
  }
  const draft = {
    ...renderContentBriefEmail({
      creatorName: creator.name,
      brandName,
      referralLink,
      creatorNotes,
      rewardDescription,
    }),
    attachments: [attachment],
  };

  // 4. Idempotent send keyed on (instance, content_brief) — a re-run of the
  //    PAYMENT_RECEIVED auto-chain (e.g. a BullMQ retry) won't double-send the
  //    brief or re-attach the PDF.
  await sendOnce(
    email,
    instance.id,
    creator,
    draft,
    `content-brief:${instance.id}`,
  );

  // Complete. Content Brief is the terminal node in the linear graph, so there is
  // no next node — stamp completedAt and finish.
  return {
    nextState: "CONTENT_BRIEF_SENT",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "CONTENT_BRIEF_SENT",
    eventPayload: {
      briefFileName,
      ...(referralLink ? { referralLink } : {}),
    } as Prisma.JsonObject,
  };
}
