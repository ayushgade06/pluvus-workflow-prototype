/**
 * One-off DB-level verification that the Drizzle write path persisted a full
 * live campaign run correctly. Queries the live Neon DB through the Drizzle
 * client and prints row-level detail for the instance passed as argv[2]
 * (or the most recently updated instance if none given).
 *
 * Run: npx tsx prisma/verify-drizzle.ts [instanceId]
 */
import { and, count, desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import {
  brandNotifications,
  campaigns,
  creators,
  events,
  executionInstances,
  messages,
  paymentInfo,
  workflows,
  workflowVersions,
} from "../src/db/schema.js";

async function main() {
  const argId = process.argv[2];

  // Resolve the target instance.
  const inst = argId
    ? (await db.select().from(executionInstances).where(eq(executionInstances.id, argId)).limit(1))[0]
    : (await db.select().from(executionInstances).orderBy(desc(executionInstances.updatedAt)).limit(1))[0];
  if (!inst) throw new Error("no instance found");

  console.log("=".repeat(70));
  console.log("INSTANCE (ExecutionInstance table)");
  console.log("=".repeat(70));
  console.log(`  id            ${inst.id}`);
  console.log(`  state         ${inst.currentState}`);
  console.log(`  node          ${inst.currentNodeId}`);
  console.log(`  round         ${inst.negotiationRound}`);
  console.log(`  followUps     ${inst.followUpCount}`);
  console.log(`  enrolledAt    ${inst.enrolledAt?.toISOString()}`);
  console.log(`  completedAt   ${inst.completedAt?.toISOString() ?? "(null)"}`);
  console.log(`  createdAt     ${inst.createdAt?.toISOString()}   updatedAt ${inst.updatedAt?.toISOString()}`);
  console.log(`  (id is a cuid2 => created by the Drizzle code path)`);

  // Walk the FK chain up to the campaign — proves the joins resolve.
  const version = (await db.select().from(workflowVersions).where(eq(workflowVersions.id, inst.workflowVersionId)).limit(1))[0]!;
  const workflow = (await db.select().from(workflows).where(eq(workflows.id, version.workflowId)).limit(1))[0]!;
  const campaign = workflow.campaignId
    ? (await db.select().from(campaigns).where(eq(campaigns.id, workflow.campaignId)).limit(1))[0]
    : null;
  const creator = (await db.select().from(creators).where(eq(creators.id, inst.creatorId)).limit(1))[0]!;

  console.log("\nFK CHAIN (all resolve):");
  console.log(`  Creator         ${creator.name} <${creator.email}>  id=${creator.id}`);
  console.log(`  WorkflowVersion v${version.version}  id=${version.id}  nodeGraph=${Array.isArray(version.nodeGraph) ? version.nodeGraph.length + " nodes" : typeof version.nodeGraph}`);
  console.log(`  Workflow        "${workflow.name}"  status=${workflow.status}  id=${workflow.id}`);
  console.log(`  Campaign        "${campaign?.name}"  brand=${campaign?.brand}  notifyEmail=${campaign?.notifyEmail}  id=${campaign?.id}`);

  // Messages.
  const msgs = await db.select().from(messages).where(eq(messages.instanceId, inst.id)).orderBy(messages.createdAt);
  console.log("\n" + "=".repeat(70));
  console.log(`MESSAGES table — ${msgs.length} rows`);
  console.log("=".repeat(70));
  for (const m of msgs) {
    console.log(`  [${m.direction}] subj="${m.subject}"`);
    console.log(`       intent=${m.replyIntent ?? "-"} conf=${m.classifyConfidence ?? "-"} thread=${m.threadId ?? "-"} ext=${m.externalMessageId ?? "-"}`);
    console.log(`       idemKey=${m.idempotencyKey ?? "-"} sentAt=${m.sentAt?.toISOString() ?? "-"} recvAt=${m.receivedAt?.toISOString() ?? "-"} procAt=${m.processedAt?.toISOString() ?? "-"}`);
  }

  // Events (append-only audit log).
  const evts = await db.select().from(events).where(eq(events.instanceId, inst.id)).orderBy(events.occurredAt);
  const byType: Record<string, number> = {};
  for (const e of evts) byType[e.type] = (byType[e.type] ?? 0) + 1;
  console.log("\n" + "=".repeat(70));
  console.log(`EVENTS table — ${evts.length} rows (append-only audit log)`);
  console.log("=".repeat(70));
  for (const [t, n] of Object.entries(byType).sort()) console.log(`  ${t.padEnd(24)} ${n}`);
  const negTurns = evts.filter((e) => e.type === "NEGOTIATION_TURN");
  console.log("  --- NEGOTIATION_TURN payloads ---");
  for (const e of negTurns) {
    const p = e.payload as Record<string, unknown>;
    console.log(`    round=${p["round"]} rate=${p["rate"]} action=${p["action"] ?? p["outcome"] ?? "-"}`);
  }

  // PaymentInfo (JSON extra column + token lifecycle).
  const pay = (await db.select().from(paymentInfo).where(eq(paymentInfo.instanceId, inst.id)).limit(1))[0];
  console.log("\n" + "=".repeat(70));
  console.log("PAYMENTINFO table");
  console.log("=".repeat(70));
  if (pay) {
    console.log(`  status        ${pay.status}`);
    console.log(`  token         ${pay.token}`);
    console.log(`  method        ${pay.method ?? "(not submitted yet)"}`);
    console.log(`  account       ${pay.accountIdentifier ?? "-"}  country=${pay.country ?? "-"}`);
    console.log(`  extra (jsonb) ${pay.extra ? JSON.stringify(pay.extra) : "(null)"}`);
    console.log(`  expiresAt     ${pay.expiresAt?.toISOString() ?? "(null)"}`);
    console.log(`  submittedAt   ${pay.submittedAt?.toISOString() ?? "(null)"}`);
    console.log(`  createdAt     ${pay.createdAt?.toISOString()}   updatedAt ${pay.updatedAt?.toISOString()}`);
  } else {
    console.log("  (no PaymentInfo row)");
  }

  // BrandNotification (escalation surface — may be empty for a clean run).
  const bn = await db.select().from(brandNotifications).where(eq(brandNotifications.instanceId, inst.id));
  console.log("\n" + "=".repeat(70));
  console.log(`BRANDNOTIFICATION table — ${bn.length} rows (empty is expected for a clean run)`);
  console.log("=".repeat(70));
  for (const n of bn) console.log(`  status=${n.status} reason=${n.reason} recipient=${n.recipient}`);

  // Whole-DB row counts (sanity that the tables are live).
  console.log("\n" + "=".repeat(70));
  console.log("WHOLE-DB ROW COUNTS");
  console.log("=".repeat(70));
  const tables = [
    ["Campaign", campaigns], ["Workflow", workflows], ["WorkflowVersion", workflowVersions],
    ["Creator", creators], ["ExecutionInstance", executionInstances], ["Message", messages],
    ["Event", events], ["PaymentInfo", paymentInfo], ["BrandNotification", brandNotifications],
  ] as const;
  for (const [name, tbl] of tables) {
    const c = (await db.select({ n: count() }).from(tbl as never))[0]!.n;
    console.log(`  ${name.padEnd(20)} ${c}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
