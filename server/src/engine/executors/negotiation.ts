import {
  listMessagesByInstance,
  listEventsByInstance,
} from "../../db/index.js";
import type { Message } from "@prisma/client";
import type { ExecutionContext, NodeResult, NegotiationHistoryEntryLite } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";
import {
  buildPriorContextFromEvents,
  buildDraftHistory,
  computeOpenQuestions,
} from "./negotiationHistory.js";
import { resolveBriefKnowledge } from "./briefKnowledge.js";
import { scanOutboundDraft, guardConstraintsFromConfig } from "../guards/outputGuard.js";
import { sendOnce } from "./idempotentSend.js";
import { describeDeal } from "../dealDescription.js";
import { extractReplyText } from "./replyText.js";
import { mergeCampaignFallback } from "../campaignContext.js";
import { openBrandDecision } from "./brandDecision.js";
import { resolveBand } from "../band.js";
// HARD-A2: the output-guard-blocked MANUAL_REVIEW result is the SAME shape used
// by other executors, so it lives in one place (guardEscalation.ts) rather than
// being duplicated inline here. Previously negotiation.ts and guardEscalation.ts
// each carried a byte-identical copy — a drift hazard on a safety path.
import { blockedByGuard } from "./guardEscalation.js";

// FIX-11: outbound AI sends use the shared reserve-before-send helper
// (idempotentSend.sendOnce), keyed on negotiation:<purpose>:<instance>:<round>,
// so a crash between email.send() and the row write cannot double-send a turn on
// a BullMQ retry.

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
//
// Returns the full Message row (MED-W2 needs its id to key the present-offer
// send per-reply, not per-round).
// HARD-N2: the executor needs not just the LATEST creator message but the whole
// set (to thread the conversation into /draft), plus the brand-reply id set (to
// exclude A1/A2 brand approvals from the creator transcript). This loads all
// three in one place so the latest-reply read and the draft-history builder
// agree on exactly which inbound rows count as "the creator".
async function loadCreatorInbounds(instanceId: string): Promise<{
  messages: Message[];
  brandReplyMsgIds: Set<string>;
  latest: Message | undefined;
}> {
  const messages = await listMessagesByInstance(instanceId);
  const events = await listEventsByInstance(instanceId, { type: "INBOUND_REPLY_RECEIVED" });
  const brandReplyMsgIds = new Set(
    events
      .filter((e) => (e.payload as Record<string, unknown> | null)?.["brandDecisionReply"] === true)
      .map((e) => (e.payload as Record<string, unknown> | null)?.["externalMessageId"])
      .filter((id): id is string => typeof id === "string"),
  );
  const latest = messages
    .filter((m) => m.direction === "INBOUND")
    .filter((m) => !(m.externalMessageId && brandReplyMsgIds.has(m.externalMessageId)))
    .at(-1);
  return { messages, brandReplyMsgIds, latest };
}

// Best-effort REGEX extraction of a dollar amount the creator named in their
// reply (e.g. "I charge $480" / "480 dollars" / "my rate is 480").
//
// MED-N3 role note: the comprehension source of truth for the creator's ask is
// the /negotiate LLM's `creatorRequestedRate` (validated in the agent so its
// digits provably appear in the reply). This regex remains for two narrower
// jobs: (a) acknowledgment copy / guard allowlisting when the agent didn't
// return a rate, and (b) the pre-agent max-rounds entry stop, which by design
// never calls the model. By construction every number it returns appears
// verbatim in the reply; a RANGE ("480-500") is rejected below rather than
// half-read.
export function extractRequestedRate(text: string | undefined): number | undefined {
  if (!text) return undefined;
  // MED-N3: blank out RANGE expressions ("480-500", "400 to 500", "between 400
  // and 500") before scanning. A range is not a single ask — matching one side
  // of it would record a price the creator never named alone. Stripping (rather
  // than bailing) keeps a genuine single ask elsewhere in the reply readable.
  text = text
    .replace(/\bbetween\s+\$?\s*\d[\d,]*(?:\.\d+)?\s+and\s+\$?\s*\d[\d,]*(?:\.\d+)?/gi, " ")
    .replace(/\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:[-–—]|\bto\b)\s*\$?\s*\d[\d,]*(?:\.\d+)?/gi, " ");
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

// MED-W3: how many CONSECUTIVE present-offer turns are "free" (don't consume a
// negotiation round). PRESENT_OFFER deliberately doesn't burn the round budget —
// a curious creator's questions shouldn't exhaust it — but with no cap a
// persistently curious creator (or a model mislabeling proposals) loops forever,
// each turn an LLM call. Past this many consecutive presents without progress,
// each further present COUNTS as a round, so the max-rounds machinery (B9 brand
// decision) bounds the loop.
const MAX_FREE_PRESENT_OFFERS = 3;

// Trailing run of PRESENT_OFFER turns at the end of the (chronological) history.
// Any other action (counter/accept/…) is "progress" and resets the run.
function countTrailingPresentOffers(history: NegotiationHistoryEntryLite[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.action !== "PRESENT_OFFER") break;
    n++;
  }
  return n;
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
  args: {
    creatorReply: string;
    maxRounds: number;
    round: number;
    /** The creator's stated ask for the MONEY path (context.creatorRate → the
     *  recorded deal rate on a brand APPROVE). MED-N3: post-agent callers pass
     *  the /negotiate LLM's validated extraction; only the pre-agent entry stop
     *  falls back to the deterministic regex read. */
    creatorRate: number | undefined;
  },
): Promise<NodeResult> {
  const { instance, node, creator } = ctx;
  const { creatorReply, maxRounds, round, creatorRate } = args;
  const { floor, ceiling } = resolveBand(config);
  const band =
    floor !== undefined && ceiling !== undefined
      ? ` (your ceiling was ${ceiling}, floor ${floor})`
      : "";
  const rateClause =
    creatorRate !== undefined ? `Their latest ask is ${creatorRate}${band}.` : "";
  const question =
    `Negotiation with ${creator.name} reached the max of ${maxRounds} rounds ` +
    `without agreement. ${rateClause} Do you want to accept their number, reject, ` +
    `or hand this off to a human?`;

  // MED-W4: the COUNTER option is REMOVED from the max-rounds escalation until the
  // final-offer delivery sub-state exists. A brand COUNTER here parks in
  // MANUAL_REVIEW pending MANUAL delivery — the counter is never actually sent to
  // the creator — so offering it told the brand a counter went out when it
  // didn't. Approve / reject / handoff only; a brand who wants to propose a
  // different number hands off to a human, who sends it. (brandDecision.ts still
  // defensively handles a free-text "COUNTER <n>" the same safe way.)
  return openBrandDecision(ctx, email, {
    reason: "max_rounds_reached",
    question,
    actions: ["approve", "reject", "handoff"],
    context: {
      reason: "max_rounds_reached",
      actions: ["approve", "reject", "handoff"],
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
  args: {
    creatorReply: string;
    round: number;
    message: string;
    /** MED-N3: the /negotiate LLM's validated extraction of the creator's ask —
     *  this is the number a brand APPROVE records as the deal rate, so it must
     *  come from comprehension (substring-validated in the agent), not a regex. */
    creatorRate: number | undefined;
  },
): Promise<NodeResult> {
  const { node, creator } = ctx;
  const { creatorReply, round, message, creatorRate } = args;
  const { floor, ceiling } = resolveBand(config);

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

  // When a downstream node owns the post-acceptance email, the negotiation ACCEPT
  // must NOT also send its own onboarding/acceptance email, or the creator gets
  // two overlapping emails. In the merged flow the CONTENT_BRIEF node sends the
  // single "Your Campaign Brief" email (finalized terms + payout link + PDF);
  // legacy graphs let the REWARD_SETUP node send the "Campaign Agreement
  // Confirmation" ("I Agree") email. Legacy workflows with neither node keep
  // sending the onboarding email here as the final touch.
  const hasPostAcceptEmailNode = nodeGraph.some(
    (n) => n.type === "REWARD_SETUP" || n.type === "CONTENT_BRIEF",
  );

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
  const { messages: allInboundSource, brandReplyMsgIds, latest: latestInbound } =
    await loadCreatorInbounds(instance.id);
  const creatorReply = latestInbound?.body ? extractReplyText(latestInbound.body) : "";

  // Hard stop — enforce maxRounds before calling the agent.
  // This prevents the agent from even being consulted past the ceiling.
  //
  // B9 (max_rounds_reached): instead of dead-ending in MANUAL_REVIEW, open a
  // brand-decision round-trip — the brand gets ONE more move (approve the
  // creator's number, name a final counter, reject, or hand off) and the run
  // auto-resumes on their reply. See MANUAL_ESCALATION_RESOLUTION.md §3 B9.
  //
  // EASY-W1: `maxRounds <= 0` means UNLIMITED — the same semantic the agent uses
  // (_rounds_exhausted / is_final_round in negotiate.py). Without the `> 0` guard
  // a `maxRounds: 0` config would open a brand decision on round 0 here while the
  // agent treats 0 as unlimited — the split semantic this fix removes.
  if (maxRounds > 0 && instance.negotiationRound >= maxRounds) {
    return openMaxRoundsBrandDecision(ctx, email, config, {
      creatorReply,
      maxRounds,
      round: instance.negotiationRound,
      // Pre-agent by design (never consult the model past the round ceiling), so
      // the LLM extraction isn't available here — the deterministic regex read
      // (range-rejecting; digits provably in the reply) is the documented
      // fallback for this one money-path caller (MED-N3).
      creatorRate: extractRequestedRate(creatorReply),
    });
  }

  // FIX-1/FIX-2: assemble the conversation so far from persisted NEGOTIATION_TURN
  // events and thread it into the (stateless) agent so it can reason about the
  // trajectory and knows its own last offer.
  const priorEvents = await listEventsByInstance(instance.id, { type: "NEGOTIATION_TURN" });
  const priorContext = buildPriorContextFromEvents(priorEvents);

  // HARD-N2: the full conversation transcript (both sides) + the answered-
  // questions ledger, threaded into /draft so the SENT email stays consistent
  // with prior emails, doesn't repeat wording, and re-surfaces any earlier
  // unanswered question. `draftHistory` interleaves our sent turns and the
  // creator's inbound messages chronologically. Empty on the first negotiation
  // turn, so first-contact copy is unchanged.
  const draftHistory = buildDraftHistory(priorEvents, allInboundSource, brandReplyMsgIds);

  // creatorQuestions / pushedFixedTerms: the comprehension /negotiate already did
  // (the creator's questions + which fixed terms they pushed), threaded across
  // the seam so /draft answers an explicit checklist instead of re-parsing the
  // raw reply (spec §6.1). Undefined in rules mode → the `?? []` spreads below
  // become no-ops, preserving current behavior.
  //
  // creatorRequestedRate (MED-N3): the creator's own stated ask as COMPREHENDED
  // by the /negotiate model and substring-validated in the agent (digits must
  // appear in the reply; ranges rejected). This — not the local regex — is what
  // feeds the MONEY path (context.creatorRate on a brand decision, which a brand
  // APPROVE records as the deal rate). The regex remains a fallback for copy
  // acknowledgment and guard allowlisting only.
  const { outcome, message, proposedRate, creatorQuestions, pushedFixedTerms, creatorRequestedRate } =
    await agent.negotiate(instance.negotiationRound, config, creatorReply, priorContext);

  // For acknowledgment copy + the output-guard allowlist (NOT the money path):
  // prefer the agent's validated comprehension, fall back to the regex read.
  const ackRequestedRate = creatorRequestedRate ?? extractRequestedRate(creatorReply);

  // HARD-K1: parse the campaign brief PDF (once per run, cached by ref) into text
  // the copy can consult to answer a creator's question from real campaign data
  // instead of inventing it. Threaded into the draft's campaignContext as
  // `briefKnowledge`; "" when there's no brief or it can't be read (soft-degrade).
  const briefKnowledge = await resolveBriefKnowledge(nodeGraph);
  const draftConfig = briefKnowledge ? { ...config, briefKnowledge } : config;

  // HARD-N2: questions the creator raised in EARLIER rounds that we never carried
  // forward — re-surfaced so a round-1 question dropped by round 3 isn't lost.
  // Computed from the creatorQuestions persisted on prior NEGOTIATION_TURN events
  // (see the eventPayload writes below), minus this turn's questions.
  const openQuestions = computeOpenQuestions(priorEvents, creatorQuestions);
  // Shared HARD-N2 draft context threaded into every draftEmail call this turn.
  const draftHistoryExtra = {
    ...(draftHistory.length ? { history: draftHistory } : {}),
    ...(openQuestions.length ? { openQuestions } : {}),
  };

  switch (outcome) {
    case "present_offer": {
      // The creator ASKED about terms (no number proposed). Present the fee
      // (+ commission) as information and wait for their actual response —
      // normally WITHOUT consuming a negotiation round. A curious creator's
      // questions must not exhaust the negotiation budget. We reuse the
      // offer-presenting draft (counter_offer purpose) so the email states the
      // fixed fee and, for a hybrid deal, the commission.
      //
      // MED-W3: but "free" present_offers cannot be UNBOUNDED — a persistently
      // curious creator (or a model mislabeling proposals) would loop forever,
      // each turn an LLM call (cost + abuse vector). After
      // MAX_FREE_PRESENT_OFFERS consecutive present-offer turns without
      // progress, each further one COUNTS toward the round budget, so the
      // existing max-rounds machinery (B9 brand decision) bounds the loop.
      const trailingPresents = countTrailingPresentOffers(priorContext.history);
      const presentConsumesRound = trailingPresents >= MAX_FREE_PRESENT_OFFERS;
      const presentRound = presentConsumesRound
        ? instance.negotiationRound + 1
        : instance.negotiationRound;
      const aiDraft = await agent.draftEmail("counter_offer", creator, draftConfig, {
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(ackRequestedRate !== undefined ? { creatorRequestedRate: ackRequestedRate } : {}),
        ...(dealDescription ? { dealDescription } : {}),
        // §6.2: thread the comprehension into /draft so the SENT email answers
        // every question and acknowledges any pushed fixed term.
        ...(creatorQuestions?.length ? { creatorQuestions } : {}),
        ...(pushedFixedTerms?.length ? { pushedFixedTerms } : {}),
        // HARD-N2: conversation transcript + earlier-round unanswered questions.
        ...draftHistoryExtra,
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
      // The creator's own stated ask is allowlisted too (echoing their number is
      // not a leak even if it coincides with a bound).
      const guard = scanOutboundDraft(
        draft,
        guardConstraintsFromConfig(config, proposedRate, ackRequestedRate),
      );
      if (!guard.ok) {
        return blockedByGuard(instance.negotiationRound, guard.hits);
      }

      // Idempotent send keyed on (instance, present, round, inbound message id).
      // MED-W2: PRESENT_OFFER deliberately doesn't consume a round, so a
      // creator's SECOND question at the same round is a distinct reply that
      // must get its own email — keying on the round alone deduped it into
      // silence. The message id is unique per reply, so each question gets an
      // answer while a worker retry of the SAME reply still cannot double-send.
      const presentKey = latestInbound
        ? `negotiation:present:${instance.id}:${instance.negotiationRound}:${latestInbound.id}`
        : `negotiation:present:${instance.id}:${instance.negotiationRound}`;
      await sendOnce(email, instance.id, creator, draft, presentKey);

      // Back to AWAITING_REPLY at the SAME node. The round is unchanged on a
      // "free" present turn; past the MED-W3 cap it advances so the loop is
      // bounded by max-rounds.
      return {
        nextState: "AWAITING_REPLY",
        nextNodeId: node.id,
        ...(presentConsumesRound ? { negotiationRound: presentRound } : {}),
        eventType: "NEGOTIATION_TURN",
        eventPayload: {
          outcome: "present_offer",
          round: presentRound,
          message: body,
          ...(proposedRate !== undefined ? { rate: proposedRate } : {}),
          // HARD-N2: persist this turn's creator questions so a future turn's
          // answered-questions ledger can tell what was asked earlier.
          ...(creatorQuestions?.length ? { creatorQuestions } : {}),
          ...(presentConsumesRound
            ? { consumedRound: true, consecutivePresentOffers: trailingPresents + 1 }
            : {}),
        },
      };
    }

    case "accept": {
      // A post-acceptance email node (Content Brief in the merged flow, or legacy
      // Reward Setup) owns the post-acceptance email. Skip the negotiation's own
      // onboarding/acceptance send entirely and just transition to ACCEPTED; the
      // downstream node then sends the single, properly formatted email (merged
      // brief, or the "Campaign Agreement Confirmation" for legacy graphs). The
      // agreed rate is persisted on the NEGOTIATION_TURN payload so resolveAgreedFee
      // can recover it as the finalized offer.
      if (hasPostAcceptEmailNode) {
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
      // §6.3 parity: same creatorRequestedRate the counter branch has (also used
      // by the guard below), so an acceptance can acknowledge the creator's own
      // number where relevant.
      const extra = {
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(ackRequestedRate !== undefined ? { creatorRequestedRate: ackRequestedRate } : {}),
        ...(dealDescription ? { dealDescription } : {}),
        // §6.2: thread the comprehension into /draft (this branch runs only on
        // legacy graphs without a post-accept email node; on merged flows the
        // downstream Content Brief node owns the email and this is skipped).
        ...(creatorQuestions?.length ? { creatorQuestions } : {}),
        ...(pushedFixedTerms?.length ? { pushedFixedTerms } : {}),
        // HARD-N2: conversation transcript + earlier-round unanswered questions.
        ...draftHistoryExtra,
      };
      const aiDraft = await agent.draftEmail(purpose, creator, draftConfig, extra);
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
      // The agreed rate is allowlisted (it is the offer we mean to present), and
      // so is the creator's own stated ask — an acceptance at the ceiling/floor
      // (their number == a bound) must be able to state that number.
      const guard = scanOutboundDraft(
        draft,
        guardConstraintsFromConfig(config, proposedRate, ackRequestedRate),
      );
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
      // MED-N3: the ask quoted to the brand — and recorded as the deal rate on a
      // brand APPROVE — is the model's validated extraction, never the regex.
      return openOverCeilingBrandDecision(ctx, email, config, {
        creatorReply,
        round: instance.negotiationRound,
        message,
        creatorRate: creatorRequestedRate,
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
      // EASY-W1: `maxRounds <= 0` = unlimited (consistent with the entry hard stop).
      if (maxRounds > 0 && newRound >= maxRounds) {
        return openMaxRoundsBrandDecision(ctx, email, config, {
          creatorReply,
          maxRounds,
          // Report the ceiling round we've reached, not a half-advanced counter.
          round: maxRounds,
          // MED-N3: post-agent, so the money path gets the model's validated
          // extraction of the creator's ask (never the regex).
          creatorRate: creatorRequestedRate,
        });
      }

      // Try AI-generated counter copy; fall back to agent-provided message.
      // Pass the concrete rate we're countering with so the draft anchors on
      // THAT number ($350) instead of reaching for the budget range — which the
      // output guard would (correctly) block as a floor/ceiling leak. Also
      // thread the creator's reply + the rate they asked for so the counter
      // acknowledges their request ("we considered your $480 …") and reads like
      // an ongoing conversation rather than a cold first contact.
      const counterExtra = {
        round: newRound,
        ...(proposedRate !== undefined ? { proposedTerms: { rate: proposedRate } } : {}),
        ...(creatorReply ? { creatorReply } : {}),
        ...(ackRequestedRate !== undefined ? { creatorRequestedRate: ackRequestedRate } : {}),
        ...(dealDescription ? { dealDescription } : {}),
        // §6.2: thread the comprehension into /draft so the counter email answers
        // every question and acknowledges any pushed fixed term (Case-10 gap).
        ...(creatorQuestions?.length ? { creatorQuestions } : {}),
        ...(pushedFixedTerms?.length ? { pushedFixedTerms } : {}),
        // HARD-N2: conversation transcript + earlier-round unanswered questions.
        ...draftHistoryExtra,
      };
      const aiDraft = await agent.draftEmail("counter_offer", creator, draftConfig, counterExtra);
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
      // sending. The rate we are countering with is allowlisted, AND so is the
      // creator's own stated ask — echoing a number they gave us (even one that
      // coincides with a bound, e.g. their $500 ask == the $500 ceiling) is not
      // a leak, so a legitimate at-bound negotiation isn't forced to MANUAL_REVIEW.
      const guard = scanOutboundDraft(
        draft,
        guardConstraintsFromConfig(config, proposedRate, ackRequestedRate),
      );
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
          // HARD-N2: persist this turn's creator questions for the answered-
          // questions ledger on any subsequent turn.
          ...(creatorQuestions?.length ? { creatorQuestions } : {}),
        },
      };
    }
  }
}
