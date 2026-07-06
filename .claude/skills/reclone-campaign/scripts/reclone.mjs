#!/usr/bin/env node
// Reclone the latest campaign in the local Pluvus dev DB.
//
// Flow: GET /campaigns -> clone latest campaign's fields via POST -> DELETE the
// original -> attach a hybrid workflow -> verify. Talks only to the running dev
// server's REST API (no DB access), so the server's validation and
// cascade-delete logic applies.
//
// Usage:
//   node reclone.mjs [templateKey] [--keep] [--no-workflow]
//     templateKey   affiliate | hybrid | fixed_fee   (default: hybrid)
//     --keep        do not delete the original campaign
//     --no-workflow clone (and delete) only; skip workflow creation
//   PORT env var overrides the server port (default 3001).

const PORT = process.env.PORT || "3001";
const BASE = `http://localhost:${PORT}`;

// Default escalation / brand-decision notify address. Forced onto every clone so
// manual-escalation emails (AWAITING_BRAND_DECISION) land in an inbox we watch —
// deliberately DIFFERENT from the creator inbox and the Nylas sender mailbox
// (notbaka2303@gmail.com) so self-addressed mail doesn't skip the Inbox.
// Override per-run with ESCALATION_EMAIL.
const ESCALATION_EMAIL = process.env.ESCALATION_EMAIL || "gadeayush23@gmail.com";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const templateKey = args.find((a) => !a.startsWith("--")) || "hybrid";
const keepOriginal = flags.has("--keep");
const skipWorkflow = flags.has("--no-workflow");

// Fields the campaign POST endpoint accepts / that define a campaign.
const CAMPAIGN_FIELDS = [
  "name",
  "brand",
  "objective",
  "notes",
  "notifyEmail",
  "brandDescription",
  "deliverables",
  "timeline",
  "rewardDescription",
  "shipsPhysicalProduct",
];

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `Cannot reach dev server at ${BASE} (${err.code || err.message}). ` +
        `Start it with \`npm run dev\` in server/, or set PORT.`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
  return out;
}

async function main() {
  console.log(`> Using server ${BASE}`);

  // 1. Latest campaign = first item (server orders by createdAt desc).
  const campaigns = await req("GET", "/campaigns");
  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    console.error("No campaigns found — nothing to reclone.");
    process.exit(1);
  }
  const original = campaigns[0];
  console.log(`> Latest campaign: "${original.name}" (${original.id})`);

  // 2. Clone the campaign fields. Force notifyEmail to the escalation inbox so
  //    manual-escalation / brand-decision emails always reach an inbox we watch,
  //    regardless of what the source campaign carried.
  const cloneFields = { ...pick(original, CAMPAIGN_FIELDS), notifyEmail: ESCALATION_EMAIL };
  const clone = await req("POST", "/campaigns", cloneFields);
  console.log(`> Cloned -> new campaign id ${clone.id} (notifyEmail=${ESCALATION_EMAIL})`);

  // 3. Delete the original (unless --keep).
  if (keepOriginal) {
    console.log("> Skipping delete (--keep): original left in place.");
  } else {
    await req("DELETE", `/campaigns/${original.id}`);
    console.log(`> Deleted original ${original.id}`);
  }

  // 4. Attach a workflow.
  let workflow = null;
  if (skipWorkflow) {
    console.log("> Skipping workflow creation (--no-workflow).");
  } else {
    workflow = await req("POST", `/campaigns/${clone.id}/workflows`, {
      name: `${clone.name} Outreach`,
      templateKey,
    });
    const nodes = Array.isArray(workflow.draftNodes) ? workflow.draftNodes.length : "?";
    console.log(
      `> Created ${templateKey} workflow "${workflow.name}" (${workflow.id}), ` +
        `status ${workflow.status}, ${nodes} nodes`,
    );
  }

  // 5. Verify.
  const after = await req("GET", "/campaigns");
  console.log(`> Campaigns now: ${after.length}`);

  console.log("\nDone.");
  console.log(JSON.stringify(
    {
      originalId: original.id,
      cloneId: clone.id,
      originalDeleted: !keepOriginal,
      workflowId: workflow ? workflow.id : null,
      workflowStatus: workflow ? workflow.status : null,
      templateKey: skipWorkflow ? null : templateKey,
    },
    null,
    2,
  ));
}

main().catch((err) => {
  console.error("\nReclone failed:", err.message);
  process.exit(1);
});
