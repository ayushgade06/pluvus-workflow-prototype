/**
 * One-shot: create a fresh UI-style live-test instance for Alex Rivera.
 *
 * The NEGOTIATION node uses minBudget:200 / maxBudget:500 — the EXACT config
 * shape the Workflow Builder UI + templates produce — so this exercises the
 * band fix (resolveBand: minBudget/maxBudget -> termFloor/termCeiling) end to
 * end through the real engine, real Nylas, and the real agent.
 *
 * Idempotent: re-running upserts the same workflow/version and creates ONE
 * fresh ENROLLED instance (a new id each run is fine — we print it).
 *
 * Run: tsx prisma/setup-live-test.ts
 */

import { PrismaClient, WorkflowStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

const adapter = new PrismaPg({ connectionString: process.env["DATABASE_URL"] });
const prisma = new PrismaClient({ adapter });

const CREATOR_EMAIL = "ayushgade23@gmail.com"; // Alex Rivera
const BRAND = "Pluvus Partnerships";

const NODE_GRAPH = [
  {
    id: "node-outreach",
    type: "INITIAL_OUTREACH",
    order: 0,
    config: {
      senderName: BRAND,
      brandName: BRAND,
      subjectTemplate: "Collaboration opportunity — {{creatorName}}",
      // No bodyTemplate -> the draft agent / MockEmailProvider generic body is used.
      aiDraftEnabled: true,
    },
  },
  {
    id: "node-followup",
    type: "FOLLOW_UP",
    order: 1,
    config: { enabled: true, intervals: [3, 5, 7], intervalUnit: "days", maxCount: 3 },
  },
  {
    id: "node-reply-detection",
    type: "REPLY_DETECTION",
    order: 2,
    config: { classifyEnabled: true, lowConfidenceThreshold: 0.7, manualReviewOnLowConfidence: true },
  },
  {
    id: "node-negotiation",
    type: "NEGOTIATION",
    order: 3,
    config: {
      // === UI shape — the band fix must translate these to termFloor/termCeiling ===
      minBudget: 200,
      maxBudget: 500,
      // ============================================================================
      maxRounds: 5,
      senderName: BRAND,
      brandName: BRAND,
      approvalMode: "auto",
    },
  },
  { id: "node-end", type: "END", order: 4, config: {} },
];

async function main() {
  const workflow = await prisma.workflow.upsert({
    where: { id: "workflow_live_test_ui" },
    update: { status: WorkflowStatus.PUBLISHED },
    create: {
      id: "workflow_live_test_ui",
      name: "Live Test — UI band 200/500",
      description: "Fresh UI-style workflow (minBudget/maxBudget) for live Nylas negotiation testing.",
      status: WorkflowStatus.PUBLISHED,
    },
  });

  const version = await prisma.workflowVersion.upsert({
    where: { workflowId_version: { workflowId: workflow.id, version: 1 } },
    update: { nodeGraph: NODE_GRAPH },
    create: {
      id: "wfv_live_test_ui_v1",
      workflowId: workflow.id,
      version: 1,
      nodeGraph: NODE_GRAPH,
    },
  });

  const creator = await prisma.creator.findUnique({ where: { email: CREATOR_EMAIL } });
  if (!creator) throw new Error(`Creator ${CREATOR_EMAIL} not found — run db:seed first.`);

  // Fresh ENROLLED instance. upsert on (version, creator) so re-runs reset it to
  // ENROLLED at the import node rather than piling up duplicates.
  const instance = await prisma.executionInstance.upsert({
    where: {
      workflowVersionId_creatorId: { workflowVersionId: version.id, creatorId: creator.id },
    },
    update: {
      currentState: "ENROLLED",
      currentNodeId: "node-outreach",
      negotiationRound: 0,
    },
    create: {
      workflowVersionId: version.id,
      creatorId: creator.id,
      currentState: "ENROLLED",
      currentNodeId: "node-outreach",
    },
  });

  console.log(JSON.stringify({
    creator: `${creator.name} <${creator.email}>`,
    creatorId: creator.id,
    workflowVersionId: version.id,
    instanceId: instance.id,
    state: instance.currentState,
    node: instance.currentNodeId,
    band: { minBudget: 200, maxBudget: 500, recommended: 350 },
  }, null, 2));
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
