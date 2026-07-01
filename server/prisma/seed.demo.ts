/**
 * Phase 9 demo seed — a realistic, idempotent observability dataset.
 *
 * Goal (Phase 9, Part 11): immediately demonstrate workflow progression. This
 * seeds creators spread across EVERY InstanceState, each with a faithful
 * history — backdated STATE_TRANSITION events (carrying `source`), outbound /
 * inbound Message rows, classification + negotiation AI-decision events — so
 * the dashboard's canvas, timeline, message thread, agent-decision panel, and
 * transition logs all have something real to show.
 *
 * It does NOT run the engine (no Redis needed). Instead it writes the exact
 * event/message shape the engine produces, with explicit timestamps and
 * `source` attribution, so end-to-end traceability (Part 10) is visible.
 *
 * Idempotent: re-running wipes only the demo creators (email domain
 * @demo.pluvus.com) and their instances/messages/events, then recreates them.
 * The original Phase-2 seed (example.com creators) is left untouched.
 *
 * Run with:  npm run db:seed:demo   (from server/)
 */

import { PrismaClient, Prisma } from "@prisma/client";
import type { EventType, InstanceState, MessageDirection } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });

const DEMO_DOMAIN = "@demo.pluvus.com";

// ---------------------------------------------------------------------------
// Node graph — mirrors the Phase-2 seed so currentNodeId values line up.
// ---------------------------------------------------------------------------

const NODE_GRAPH = [
  { id: "node_import", type: "IMPORT_CREATOR_LIST", order: 0, config: { dedupStrategy: "email" } },
  {
    id: "node_outreach",
    type: "INITIAL_OUTREACH",
    order: 1,
    config: { senderName: "Pluvus Partnerships", aiDraftEnabled: true },
  },
  {
    id: "node_followup",
    type: "FOLLOW_UP",
    order: 2,
    config: { enabled: true, intervals: [3, 5, 7], maxCount: 3 },
  },
  { id: "node_reply_detection", type: "REPLY_DETECTION", order: 3, config: { classifyEnabled: true } },
  {
    id: "node_negotiation",
    type: "NEGOTIATION",
    order: 4,
    config: { maxRounds: 5, termFloor: { rate: 500 }, termCeiling: { rate: 2000 } },
  },
  { id: "node_end", type: "END", order: 5, config: {} },
];

// ---------------------------------------------------------------------------
// Time helpers — backdate everything off a fixed "now" so the demo has a
// believable spread of ages.
// ---------------------------------------------------------------------------

const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW - ms);

// ---------------------------------------------------------------------------
// Scenario model — declarative description of one creator's journey.
// ---------------------------------------------------------------------------
// `steps` are applied in order. The builder turns each into the right
// Event / Message rows with backdated timestamps and `source` attribution.

type Source =
  | "node-execution-worker"
  | "inbound-email"
  | "classification-agent"
  | "negotiation-agent"
  | "scheduler"
  | "manual";

interface TransitionStep {
  kind: "transition";
  from: InstanceState;
  to: InstanceState;
  nodeId: string;
  source: Source;
  worker?: string;
  queueJobId?: string;
  /** ms-ago the transition occurred. */
  at: number;
}
interface OutboundStep {
  kind: "outbound";
  subject: string;
  body: string;
  at: number;
  round?: number;
}
interface InboundStep {
  kind: "inbound";
  subject: string;
  body: string;
  intent?: "POSITIVE" | "NEGATIVE" | "QUESTION" | "OPT_OUT" | "UNKNOWN";
  confidence?: number;
  at: number;
}
interface DomainStep {
  kind: "domain";
  type: EventType;
  nodeId: string;
  payload: Record<string, unknown>;
  at: number;
}
type Step = TransitionStep | OutboundStep | InboundStep | DomainStep;

interface Scenario {
  creator: { name: string; email: string; handle: string; niche: string; platform: string };
  finalState: InstanceState;
  currentNodeId: string | null;
  negotiationRound: number;
  followUpCount: number;
  dueAt: number | null; // ms-ago (negative = future) or null
  enrolledAgo: number;
  steps: Step[];
}

// ---------------------------------------------------------------------------
// Reusable journey fragments
// ---------------------------------------------------------------------------

const outreachSubject = (name: string) => `Collaboration opportunity — ${name}`;
const outreachBody = (name: string, platform: string) =>
  `Hi ${name},\n\nWe love your content on ${platform} and think you'd be a great fit for our upcoming campaign. Would you be open to a quick chat?\n\nBest,\nPluvus Team`;

// enrolled → outreach_sent → awaiting_reply baseline (used by most scenarios)
function outreachFragment(
  name: string,
  platform: string,
  base: number,
): Step[] {
  return [
    { kind: "transition", from: "ENROLLED", to: "OUTREACH_SENT", nodeId: "node_outreach", source: "node-execution-worker", worker: "node-execution", queueJobId: `demo-${base}-1`, at: base },
    { kind: "domain", type: "OUTREACH_DRAFTED", nodeId: "node_outreach", payload: { aiDraft: true }, at: base + 1 },
    { kind: "outbound", subject: outreachSubject(name), body: outreachBody(name, platform), at: base + 1 },
    { kind: "transition", from: "OUTREACH_SENT", to: "AWAITING_REPLY", nodeId: "node_followup", source: "node-execution-worker", worker: "node-execution", queueJobId: `demo-${base}-2`, at: base - 5 * MIN },
  ];
}

// ---------------------------------------------------------------------------
// Scenarios — at least one per state.
// ---------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  // 1. ENROLLED — just imported, nothing sent yet.
  {
    creator: { name: "Nina Foster", email: `nina.foster${DEMO_DOMAIN}`, handle: "@ninafoster", niche: "wellness", platform: "instagram" },
    finalState: "ENROLLED",
    currentNodeId: "node_import",
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 10 * MIN,
    steps: [
      { kind: "domain", type: "NODE_ENTERED", nodeId: "node_import", payload: {}, at: 10 * MIN },
    ],
  },

  // 2. OUTREACH_SENT — email sent, not yet flipped to awaiting.
  {
    creator: { name: "Leo Marsh", email: `leo.marsh${DEMO_DOMAIN}`, handle: "@leomarsh", niche: "tech", platform: "youtube" },
    finalState: "OUTREACH_SENT",
    currentNodeId: "node_outreach",
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 2 * HOUR,
    steps: [
      { kind: "transition", from: "ENROLLED", to: "OUTREACH_SENT", nodeId: "node_outreach", source: "node-execution-worker", worker: "node-execution", queueJobId: "demo-2-1", at: 90 * MIN },
      { kind: "domain", type: "OUTREACH_DRAFTED", nodeId: "node_outreach", payload: { aiDraft: true }, at: 90 * MIN },
      { kind: "outbound", subject: outreachSubject("Leo Marsh"), body: outreachBody("Leo Marsh", "youtube"), at: 90 * MIN },
    ],
  },

  // 3. AWAITING_REPLY — waiting, dueAt in the future (healthy).
  {
    creator: { name: "Priya Raman", email: `priya.raman${DEMO_DOMAIN}`, handle: "@priyaraman", niche: "finance", platform: "youtube" },
    finalState: "AWAITING_REPLY",
    currentNodeId: "node_followup",
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: -2 * DAY, // 2 days in the future
    enrolledAgo: 6 * HOUR,
    steps: outreachFragment("Priya Raman", "youtube", 5 * HOUR),
  },

  // 4. AWAITING_REPLY (STUCK) — dueAt long past, scheduler hasn't advanced it.
  {
    creator: { name: "Owen Blake", email: `owen.blake${DEMO_DOMAIN}`, handle: "@owenblake", niche: "gaming", platform: "twitch" },
    finalState: "AWAITING_REPLY",
    currentNodeId: "node_followup",
    negotiationRound: 0,
    followUpCount: 1,
    dueAt: 3 * HOUR, // 3 hours PAST → stuck (> 1h threshold)
    enrolledAgo: 4 * DAY,
    steps: [
      ...outreachFragment("Owen Blake", "twitch", 4 * DAY - HOUR),
      { kind: "domain", type: "FOLLOW_UP_DUE", nodeId: "node_followup", payload: { followUpCount: 1 }, at: 2 * DAY },
      { kind: "outbound", subject: "Re: Collaboration opportunity — Owen Blake", body: "Hi Owen,\n\nJust following up on my previous message — still very interested in collaborating!\n\nBest,\nPluvus Team", at: 2 * DAY },
    ],
  },

  // 5. FOLLOWED_UP — a follow-up was just sent, awaiting the next window.
  {
    creator: { name: "Maya Cohen", email: `maya.cohen${DEMO_DOMAIN}`, handle: "@mayacohen", niche: "beauty", platform: "tiktok" },
    finalState: "FOLLOWED_UP",
    currentNodeId: "node_followup",
    negotiationRound: 0,
    followUpCount: 2,
    dueAt: -1 * DAY,
    enrolledAgo: 8 * DAY,
    steps: [
      ...outreachFragment("Maya Cohen", "tiktok", 8 * DAY - HOUR),
      { kind: "transition", from: "AWAITING_REPLY", to: "FOLLOWED_UP", nodeId: "node_followup", source: "scheduler", worker: "node-execution", queueJobId: "demo-5-3", at: 3 * DAY },
      { kind: "domain", type: "FOLLOW_UP_DUE", nodeId: "node_followup", payload: { followUpCount: 2 }, at: 3 * DAY },
      { kind: "outbound", subject: "Re: Collaboration opportunity — Maya Cohen", body: "Hi Maya,\n\nCircling back once more — we'd genuinely love to work with you.\n\nBest,\nPluvus Team", at: 3 * DAY },
    ],
  },

  // 6. REPLY_RECEIVED — reply landed, classification pending (transient).
  {
    creator: { name: "Dev Anand", email: `dev.anand${DEMO_DOMAIN}`, handle: "@devanand", niche: "food", platform: "instagram" },
    finalState: "REPLY_RECEIVED",
    currentNodeId: "node_reply_detection",
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 1 * DAY,
    steps: [
      ...outreachFragment("Dev Anand", "instagram", 20 * HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "Hi! This sounds interesting, can you tell me more about the rates?", at: 2 * HOUR },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 2 * HOUR },
    ],
  },

  // 7. NEGOTIATING — positive reply, classified, one counter sent, mid-flight.
  {
    creator: { name: "Sofia Reyes", email: `sofia.reyes${DEMO_DOMAIN}`, handle: "@sofiareyes", niche: "travel", platform: "youtube" },
    finalState: "NEGOTIATING",
    currentNodeId: "node_negotiation",
    negotiationRound: 2,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 3 * DAY,
    steps: [
      ...outreachFragment("Sofia Reyes", "youtube", 3 * DAY - HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "I'm interested! I usually charge $1,200 per sponsored video.", intent: "POSITIVE", confidence: 0.93, at: 2 * DAY },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 2 * DAY },
      { kind: "domain", type: "REPLY_CLASSIFIED", nodeId: "node_reply_detection", payload: { intent: "POSITIVE", confidence: 0.93 }, at: 2 * DAY - MIN },
      { kind: "transition", from: "REPLY_RECEIVED", to: "NEGOTIATING", nodeId: "node_negotiation", source: "classification-agent", worker: "inbound-email", queueJobId: "demo-7-cls", at: 2 * DAY - MIN },
      { kind: "domain", type: "NEGOTIATION_TURN", nodeId: "node_negotiation", payload: { outcome: "counter", round: 1, message: "We appreciate the counter. We can do $900 for the first video.", reason: "Within allowed budget range" }, at: 2 * DAY - 2 * MIN },
      { kind: "outbound", subject: "Re: Collaboration — let's find a fit", body: "We appreciate the counter. We can do $900 for the first video.", round: 1, at: 2 * DAY - 2 * MIN },
      { kind: "inbound", subject: "Re: Collaboration — let's find a fit", body: "Can we meet at $1,050?", intent: "POSITIVE", confidence: 0.88, at: 1 * DAY },
      { kind: "transition", from: "NEGOTIATING", to: "NEGOTIATING", nodeId: "node_negotiation", source: "negotiation-agent", worker: "inbound-email", queueJobId: "demo-7-r2", at: 1 * DAY },
      { kind: "domain", type: "NEGOTIATION_TURN", nodeId: "node_negotiation", payload: { outcome: "counter", round: 2, message: "We can stretch to $1,000 — final offer.", reason: "Approaching ceiling" }, at: 1 * DAY - MIN },
      { kind: "outbound", subject: "Re: Collaboration — our best offer", body: "We can stretch to $1,000 — final offer.", round: 2, at: 1 * DAY - MIN },
    ],
  },

  // 8. ACCEPTED — full happy path through negotiation to a deal.
  {
    creator: { name: "Jonah Pierce", email: `jonah.pierce${DEMO_DOMAIN}`, handle: "@jonahpierce", niche: "fitness", platform: "instagram" },
    finalState: "ACCEPTED",
    currentNodeId: null,
    negotiationRound: 1,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 5 * DAY,
    steps: [
      ...outreachFragment("Jonah Pierce", "instagram", 5 * DAY - HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "Yes! I'd love to. $800 works for me.", intent: "POSITIVE", confidence: 0.97, at: 4 * DAY },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 4 * DAY },
      { kind: "domain", type: "REPLY_CLASSIFIED", nodeId: "node_reply_detection", payload: { intent: "POSITIVE", confidence: 0.97 }, at: 4 * DAY - MIN },
      { kind: "transition", from: "REPLY_RECEIVED", to: "NEGOTIATING", nodeId: "node_negotiation", source: "classification-agent", worker: "inbound-email", queueJobId: "demo-8-cls", at: 4 * DAY - MIN },
      { kind: "domain", type: "NEGOTIATION_TURN", nodeId: "node_negotiation", payload: { outcome: "accept", round: 1, message: "Wonderful — $800 it is. Sending the contract now!" }, at: 4 * DAY - 2 * MIN },
      { kind: "outbound", subject: "Re: Collaboration — we're thrilled!", body: "Wonderful — $800 it is. Sending the contract now!", round: 1, at: 4 * DAY - 2 * MIN },
      { kind: "transition", from: "NEGOTIATING", to: "ACCEPTED", nodeId: "node_negotiation", source: "negotiation-agent", worker: "inbound-email", queueJobId: "demo-8-acc", at: 4 * DAY - 2 * MIN },
    ],
  },

  // 9. ACCEPTED — second, shorter happy path.
  {
    creator: { name: "Hana Suzuki", email: `hana.suzuki${DEMO_DOMAIN}`, handle: "@hanasuzuki", niche: "lifestyle", platform: "tiktok" },
    finalState: "ACCEPTED",
    currentNodeId: null,
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 6 * DAY,
    steps: [
      ...outreachFragment("Hana Suzuki", "tiktok", 6 * DAY - HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "Sounds great, count me in!", intent: "POSITIVE", confidence: 0.95, at: 5 * DAY },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 5 * DAY },
      { kind: "domain", type: "REPLY_CLASSIFIED", nodeId: "node_reply_detection", payload: { intent: "POSITIVE", confidence: 0.95 }, at: 5 * DAY - MIN },
      { kind: "transition", from: "REPLY_RECEIVED", to: "NEGOTIATING", nodeId: "node_negotiation", source: "classification-agent", worker: "inbound-email", queueJobId: "demo-9-cls", at: 5 * DAY - MIN },
      { kind: "domain", type: "NEGOTIATION_TURN", nodeId: "node_negotiation", payload: { outcome: "accept", round: 0, message: "Amazing — welcome aboard!" }, at: 5 * DAY - 2 * MIN },
      { kind: "outbound", subject: "Re: Welcome aboard", body: "Amazing — welcome aboard!", round: 0, at: 5 * DAY - 2 * MIN },
      { kind: "transition", from: "NEGOTIATING", to: "ACCEPTED", nodeId: "node_negotiation", source: "negotiation-agent", worker: "inbound-email", queueJobId: "demo-9-acc", at: 5 * DAY - 2 * MIN },
    ],
  },

  // 10. REJECTED — negative reply, classified, ended.
  {
    creator: { name: "Caleb Stone", email: `caleb.stone${DEMO_DOMAIN}`, handle: "@calebstone", niche: "auto", platform: "youtube" },
    finalState: "REJECTED",
    currentNodeId: null,
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 4 * DAY,
    steps: [
      ...outreachFragment("Caleb Stone", "youtube", 4 * DAY - HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "Thanks, but I'm not interested in brand deals right now.", intent: "NEGATIVE", confidence: 0.91, at: 3 * DAY },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 3 * DAY },
      { kind: "domain", type: "REPLY_CLASSIFIED", nodeId: "node_reply_detection", payload: { intent: "NEGATIVE", confidence: 0.91 }, at: 3 * DAY - MIN },
      { kind: "transition", from: "REPLY_RECEIVED", to: "REJECTED", nodeId: "node_reply_detection", source: "classification-agent", worker: "inbound-email", queueJobId: "demo-10-cls", at: 3 * DAY - MIN },
    ],
  },

  // 11. OPTED_OUT — explicit unsubscribe.
  {
    creator: { name: "Ruth Adeyemi", email: `ruth.adeyemi${DEMO_DOMAIN}`, handle: "@ruthadeyemi", niche: "education", platform: "youtube" },
    finalState: "OPTED_OUT",
    currentNodeId: null,
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 7 * DAY,
    steps: [
      ...outreachFragment("Ruth Adeyemi", "youtube", 7 * DAY - HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "Please unsubscribe me and do not contact me again.", intent: "OPT_OUT", confidence: 0.99, at: 6 * DAY },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 6 * DAY },
      { kind: "domain", type: "REPLY_CLASSIFIED", nodeId: "node_reply_detection", payload: { intent: "OPT_OUT", confidence: 0.99 }, at: 6 * DAY - MIN },
      { kind: "transition", from: "REPLY_RECEIVED", to: "OPTED_OUT", nodeId: "node_reply_detection", source: "classification-agent", worker: "inbound-email", queueJobId: "demo-11-cls", at: 6 * DAY - MIN },
    ],
  },

  // 12. NO_RESPONSE — exhausted all follow-ups, never replied.
  {
    creator: { name: "Tomas Vidal", email: `tomas.vidal${DEMO_DOMAIN}`, handle: "@tomasvidal", niche: "music", platform: "instagram" },
    finalState: "NO_RESPONSE",
    currentNodeId: null,
    negotiationRound: 0,
    followUpCount: 3,
    dueAt: null,
    enrolledAgo: 20 * DAY,
    steps: [
      ...outreachFragment("Tomas Vidal", "instagram", 20 * DAY - HOUR),
      { kind: "transition", from: "AWAITING_REPLY", to: "FOLLOWED_UP", nodeId: "node_followup", source: "scheduler", worker: "node-execution", queueJobId: "demo-12-f1", at: 17 * DAY },
      { kind: "outbound", subject: "Re: Collaboration opportunity — Tomas Vidal", body: "Just following up — still keen to collaborate!", at: 17 * DAY },
      { kind: "transition", from: "FOLLOWED_UP", to: "AWAITING_REPLY", nodeId: "node_followup", source: "node-execution-worker", worker: "node-execution", queueJobId: "demo-12-f1b", at: 17 * DAY - MIN },
      { kind: "transition", from: "AWAITING_REPLY", to: "FOLLOWED_UP", nodeId: "node_followup", source: "scheduler", worker: "node-execution", queueJobId: "demo-12-f2", at: 12 * DAY },
      { kind: "outbound", subject: "Re: Collaboration opportunity — Tomas Vidal", body: "Following up again — would love to hear from you.", at: 12 * DAY },
      { kind: "transition", from: "FOLLOWED_UP", to: "AWAITING_REPLY", nodeId: "node_followup", source: "node-execution-worker", worker: "node-execution", queueJobId: "demo-12-f2b", at: 12 * DAY - MIN },
      { kind: "transition", from: "AWAITING_REPLY", to: "NO_RESPONSE", nodeId: "node_followup", source: "scheduler", worker: "node-execution", queueJobId: "demo-12-no", at: 5 * DAY },
    ],
  },

  // 13. MANUAL_REVIEW — low-confidence classification.
  {
    creator: { name: "Iris Lindqvist", email: `iris.lindqvist${DEMO_DOMAIN}`, handle: "@irislind", niche: "art", platform: "instagram" },
    finalState: "MANUAL_REVIEW",
    currentNodeId: null,
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 2 * DAY,
    steps: [
      ...outreachFragment("Iris Lindqvist", "instagram", 2 * DAY - HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "hmm maybe, depends. what's the vibe?", intent: "UNKNOWN", confidence: 0.42, at: 1 * DAY },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 1 * DAY },
      { kind: "domain", type: "MANUAL_REVIEW_FLAGGED", nodeId: "node_reply_detection", payload: { intent: "UNKNOWN", confidence: 0.42, reason: "low_confidence" }, at: 1 * DAY - MIN },
      { kind: "transition", from: "REPLY_RECEIVED", to: "MANUAL_REVIEW", nodeId: "node_reply_detection", source: "classification-agent", worker: "inbound-email", queueJobId: "demo-13-cls", at: 1 * DAY - MIN },
    ],
  },

  // 14. MANUAL_REVIEW — negotiation hit max rounds, escalated.
  {
    creator: { name: "Felix Brandt", email: `felix.brandt${DEMO_DOMAIN}`, handle: "@felixbrandt", niche: "tech", platform: "youtube" },
    finalState: "MANUAL_REVIEW",
    currentNodeId: null,
    negotiationRound: 5,
    followUpCount: 0,
    dueAt: null,
    enrolledAgo: 9 * DAY,
    steps: [
      ...outreachFragment("Felix Brandt", "youtube", 9 * DAY - HOUR),
      { kind: "inbound", subject: "Re: Collaboration opportunity", body: "Interested but my rate is $5,000, non-negotiable.", intent: "POSITIVE", confidence: 0.9, at: 8 * DAY },
      { kind: "transition", from: "AWAITING_REPLY", to: "REPLY_RECEIVED", nodeId: "node_reply_detection", source: "inbound-email", at: 8 * DAY },
      { kind: "domain", type: "REPLY_CLASSIFIED", nodeId: "node_reply_detection", payload: { intent: "POSITIVE", confidence: 0.9 }, at: 8 * DAY - MIN },
      { kind: "transition", from: "REPLY_RECEIVED", to: "NEGOTIATING", nodeId: "node_negotiation", source: "classification-agent", worker: "inbound-email", queueJobId: "demo-14-cls", at: 8 * DAY - MIN },
      { kind: "domain", type: "NEGOTIATION_TURN", nodeId: "node_negotiation", payload: { outcome: "ESCALATE", reason: "max_rounds_reached", round: 5, maxRounds: 5 }, at: 7 * DAY },
      { kind: "transition", from: "NEGOTIATING", to: "MANUAL_REVIEW", nodeId: "node_negotiation", source: "negotiation-agent", worker: "node-execution", queueJobId: "demo-14-esc", at: 7 * DAY },
    ],
  },

  // 15. AWAITING_REPLY — fresh, healthy, no follow-up yet (fills out the bucket).
  {
    creator: { name: "Grace Okoro", email: `grace.okoro${DEMO_DOMAIN}`, handle: "@graceokoro", niche: "parenting", platform: "instagram" },
    finalState: "AWAITING_REPLY",
    currentNodeId: "node_followup",
    negotiationRound: 0,
    followUpCount: 0,
    dueAt: -3 * DAY,
    enrolledAgo: 3 * HOUR,
    steps: outreachFragment("Grace Okoro", "instagram", 2 * HOUR),
  },
];

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

async function buildInstance(
  versionId: string,
  s: Scenario,
): Promise<void> {
  const creator = await prisma.creator.upsert({
    where: { email: s.creator.email },
    update: { name: s.creator.name, handle: s.creator.handle, niche: s.creator.niche, platform: s.creator.platform },
    create: s.creator,
  });

  const enrolledAt = ago(s.enrolledAgo);
  const dueAt = s.dueAt === null ? null : ago(s.dueAt);

  // Most recent step timestamp → updatedAt (drives "time in state" + stuck).
  const lastStepAgo = Math.min(...s.steps.map((st) => st.at), s.enrolledAgo);
  const updatedAt = ago(lastStepAgo);

  const instance = await prisma.executionInstance.upsert({
    where: { workflowVersionId_creatorId: { workflowVersionId: versionId, creatorId: creator.id } },
    update: {
      currentState: s.finalState,
      currentNodeId: s.currentNodeId,
      negotiationRound: s.negotiationRound,
      followUpCount: s.followUpCount,
      dueAt,
      completedAt: isTerminal(s.finalState) ? updatedAt : null,
      updatedAt,
    },
    create: {
      workflowVersionId: versionId,
      creatorId: creator.id,
      currentState: s.finalState,
      currentNodeId: s.currentNodeId,
      negotiationRound: s.negotiationRound,
      followUpCount: s.followUpCount,
      dueAt,
      enrolledAt,
      completedAt: isTerminal(s.finalState) ? updatedAt : null,
    },
  });

  // Wipe prior demo events/messages for this instance so re-runs are clean.
  await prisma.event.deleteMany({ where: { instanceId: instance.id } });
  await prisma.message.deleteMany({ where: { instanceId: instance.id } });

  // Enrollment event always first.
  await prisma.event.create({
    data: {
      instanceId: instance.id,
      type: "NODE_ENTERED",
      nodeId: "node_import",
      payload: { enrolled: true },
      occurredAt: enrolledAt,
    },
  });

  const threadId = `demo-thread-${creator.id}`;
  let msgSeq = 0;

  // `at` is "ms ago": a larger value is further in the past. Sort descending so
  // steps are written in causal (chronological) order regardless of authoring
  // order. A stable sort preserves intra-moment ordering for equal timestamps.
  const orderedSteps = [...s.steps].sort((a, b) => b.at - a.at);

  for (const step of orderedSteps) {
    const at = ago(step.at);
    if (step.kind === "transition") {
      await prisma.event.create({
        data: {
          instanceId: instance.id,
          type: "STATE_TRANSITION",
          nodeId: step.nodeId,
          payload: {
            from: step.from,
            to: step.to,
            source: step.source,
            ...(step.worker ? { worker: step.worker } : {}),
            ...(step.queueJobId ? { queueJobId: step.queueJobId } : {}),
          } as Prisma.InputJsonValue,
          occurredAt: at,
        },
      });
    } else if (step.kind === "domain") {
      await prisma.event.create({
        data: {
          instanceId: instance.id,
          type: step.type,
          nodeId: step.nodeId,
          payload: step.payload as Prisma.InputJsonValue,
          occurredAt: at,
        },
      });
    } else if (step.kind === "outbound") {
      await prisma.message.create({
        data: {
          instanceId: instance.id,
          direction: "OUTBOUND" as MessageDirection,
          subject: step.subject,
          body: step.body,
          threadId,
          externalMessageId: `demo-out-${instance.id}-${msgSeq++}`,
          sentAt: at,
          createdAt: at,
        },
      });
    } else if (step.kind === "inbound") {
      await prisma.message.create({
        data: {
          instanceId: instance.id,
          direction: "INBOUND" as MessageDirection,
          subject: step.subject,
          body: step.body,
          threadId,
          externalMessageId: `demo-in-${instance.id}-${msgSeq++}`,
          replyIntent: step.intent ?? null,
          classifyConfidence: step.confidence ?? null,
          receivedAt: at,
          createdAt: at,
        },
      });
      await prisma.event.create({
        data: {
          instanceId: instance.id,
          type: "INBOUND_REPLY_RECEIVED",
          nodeId: "node_reply_detection",
          payload: { subject: step.subject, source: "inbound-email" },
          occurredAt: at,
        },
      });
    }
  }
}

const TERMINAL: InstanceState[] = ["ACCEPTED", "REJECTED", "OPTED_OUT", "NO_RESPONSE", "MANUAL_REVIEW"];
function isTerminal(s: InstanceState): boolean {
  return TERMINAL.includes(s);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Seeding Phase 9 demo dataset…");

  const workflow = await prisma.workflow.upsert({
    where: { id: "workflow_seed_v1" },
    update: {},
    create: {
      id: "workflow_seed_v1",
      name: "Creator Outreach Campaign",
      description: "Linear outreach workflow: import → outreach → follow-up → reply detection → negotiation → end.",
      status: "PUBLISHED",
    },
  });

  const version = await prisma.workflowVersion.upsert({
    where: { workflowId_version: { workflowId: workflow.id, version: 1 } },
    update: {},
    create: { id: "wfv_seed_v1", workflowId: workflow.id, version: 1, nodeGraph: NODE_GRAPH },
  });

  console.log(`  Workflow ${workflow.id} v${version.version}`);

  // Creator/instance seeding is intentionally disabled: the roster is populated
  // only via CSV upload (Enroll tab → Upload CSV). The demo scenarios below all
  // create creators + instances, so the whole loop is skipped. The scenario data
  // (SCENARIOS / buildInstance) is left in place so this can be re-enabled by
  // deleting this early return if the demo dataset is ever needed again.
  console.log(
    "  Demo creators/instances disabled — roster is CSV-only. Skipping scenarios.",
  );
  console.log("Done.");
  return;

  for (const s of SCENARIOS) {
    await buildInstance(version.id, s);
    console.log(`  ✓ ${s.creator.name.padEnd(18)} → ${s.finalState}`);
  }

  // Summary by state.
  const counts = await prisma.executionInstance.groupBy({ by: ["currentState"], _count: true });
  console.log("\n  State distribution (all instances):");
  for (const c of counts.sort((a, b) => b._count - a._count)) {
    console.log(`    ${c.currentState.padEnd(16)} ${c._count}`);
  }
  console.log(`\nDone. Seeded ${SCENARIOS.length} demo creators across every state.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
