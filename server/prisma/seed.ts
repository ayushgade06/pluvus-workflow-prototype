/**
 * Seed script for Phase 2.
 *
 * Creates:
 *   - 1 Workflow (the in-scope linear path)
 *   - 1 WorkflowVersion (published snapshot with nodeGraph)
 *
 * Creators are intentionally NOT seeded: the roster starts empty and is
 * populated only via CSV upload (Enroll tab → Upload CSV). Because there are no
 * creators, no ExecutionInstances are seeded either.
 *
 * Run with: npm run db:seed  (from server/)
 */

import { db, pool } from "../src/db/drizzle.js";
import { workflows, workflowVersions } from "../src/db/schema.js";
import type { InputJsonValue } from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Node graph snapshot
// The nodeGraph is the immutable config captured at publish time.
// Shape: NodeSnapshot[]
// ---------------------------------------------------------------------------

interface NodeSnapshot {
  id: string;
  type: string;
  order: number;
  config: Record<string, unknown>;
}

const NODE_GRAPH: NodeSnapshot[] = [
  {
    id: "node_import",
    type: "IMPORT_CREATOR_LIST",
    order: 0,
    config: {
      dedupStrategy: "email",
    },
  },
  {
    id: "node_outreach",
    type: "INITIAL_OUTREACH",
    order: 1,
    config: {
      senderName: "Pluvus Partnerships",
      subjectTemplate: "Collaboration opportunity — {{creatorName}}",
      bodyTemplate:
        "Hi {{creatorName}},\n\nWe love your content on {{platform}} and think you'd be a great fit for our upcoming campaign.\n\nWould you be open to a quick chat?\n\nBest,\nPluvus Team",
      personalizationDepth: "standard",
      aiDraftEnabled: true,
    },
  },
  {
    id: "node_followup",
    type: "FOLLOW_UP",
    order: 2,
    config: {
      enabled: true,
      intervals: [3, 5, 7],
      intervalUnit: "days",
      maxCount: 3,
      bodyTemplate:
        "Hi {{creatorName}},\n\nJust following up on my previous message — still very interested in collaborating!\n\nBest,\nPluvus Team",
    },
  },
  {
    id: "node_reply_detection",
    type: "REPLY_DETECTION",
    order: 3,
    config: {
      classifyEnabled: true,
      lowConfidenceThreshold: 0.6,
      lowConfidenceFallback: "manual_review",
    },
  },
  {
    id: "node_negotiation",
    type: "NEGOTIATION",
    order: 4,
    config: {
      maxRounds: 5,
      tone: "professional",
      termFloor: { rate: 500 },
      termCeiling: { rate: 2000 },
      // H5: brand context the negotiation/offer LLM needs. Without these the
      // agent falls back to "Pluvus Partnerships" / "a brand partnership" and
      // signs blind. The seed IS a Pluvus demo, so senderName/brandName match the
      // outreach node above; brandDescription lets the agent answer "what does
      // your brand do?" instead of hallucinating. deliverables/timeline are left
      // unset on purpose (the demo has none) — the prompt then keeps them open
      // rather than inventing scope.
      senderName: "Pluvus Partnerships",
      brandName: "Pluvus Partnerships",
      brandDescription:
        "Pluvus is a creator-partnerships platform that connects brands with " +
        "the right creators and manages the collaboration end to end.",
      stageTemplates: {
        opening: "Thanks for getting back to us! Here are the campaign details and our initial offer.",
        counter: "We appreciate the counter. Here's what we can do:",
        final: "This is our best offer. Let us know if you'd like to move forward.",
      },
    },
  },
  {
    id: "node_end",
    type: "END",
    order: 5,
    config: {},
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main() {
  console.log("Seeding database…");

  // Upsert the workflow so seed is idempotent (empty Prisma `update` → no-op
  // write on the unique key so the row still returns).
  const workflow = (
    await db
      .insert(workflows)
      .values({
        id: "workflow_seed_v1",
        name: "Creator Outreach Campaign",
        description:
          "Linear outreach workflow: import → outreach → follow-up → reply detection → negotiation → end.",
        status: "PUBLISHED",
      })
      .onConflictDoUpdate({
        target: workflows.id,
        set: { id: "workflow_seed_v1" },
      })
      .returning()
  )[0]!;

  console.log(`  Workflow: ${workflow.id} — "${workflow.name}"`);

  // Upsert the workflow version
  const workflowVersion = (
    await db
      .insert(workflowVersions)
      .values({
        id: "wfv_seed_v1",
        workflowId: workflow.id,
        version: 1,
        nodeGraph: NODE_GRAPH as unknown as InputJsonValue,
      })
      .onConflictDoUpdate({
        target: [workflowVersions.workflowId, workflowVersions.version],
        set: { workflowId: workflow.id },
      })
      .returning()
  )[0]!;

  console.log(`  WorkflowVersion: ${workflowVersion.id} (v${workflowVersion.version})`);

  console.log("  Creators: none seeded — populate the roster via CSV upload.");
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
