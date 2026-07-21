/**
 * LIVE probe for the Gmail Campaign Labels feature (dev/ops diagnostic — NOT a
 * unit test). Talks to the REAL Nylas grant configured in .env to confirm the
 * feature's prerequisites and end-to-end behavior BEFORE flipping
 * GMAIL_LABELS_ENABLED in the app:
 *
 *   1. Reads the grant (GET /v3/grants/{id}) → prints provider + scopes, so we can
 *      confirm it's a GOOGLE/Gmail grant with mail-modify scope.
 *   2. Lists folders (labels) → confirms folders.list works on this grant.
 *   3. Picks one existing threaded conversation from the DB, resolves its campaign
 *      name, and (only with --apply) runs the real applyThreadLabel against it,
 *      then re-reads the thread to prove the label id is now present alongside the
 *      pre-existing folders (non-destructive union).
 *
 * Run from server/:
 *   npx tsx scripts/probe-gmail-labels.ts            (inspect only — grant + list)
 *   npx tsx scripts/probe-gmail-labels.ts --apply    (also label ONE real thread)
 *
 * This forces GMAIL_LABELS_ENABLED=true for the provider it constructs itself, so
 * it does NOT depend on the app's env flag being set.
 */

import { eq, isNotNull } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import {
  messages,
  executionInstances,
  workflowVersions,
  workflows,
  campaigns,
} from "../src/db/schema.js";
import { getNylasClient, nylasGrantId } from "../src/providers/nylas/client.js";
import { emailProvider } from "../src/engine/providerFactory.js";
import { isThreadLabeler } from "../src/engine/providers.js";
import { campaignLabelName, DEFAULT_LABEL_PREFIX } from "../src/providers/nylas/campaignLabel.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const grantId = nylasGrantId();
  const apiKey = process.env["NYLAS_API_KEY"];
  const apiBase = (process.env["NYLAS_API_URI"]?.trim() || "https://api.us.nylas.com").replace(/\/$/, "");
  const prefix = process.env["GMAIL_LABEL_PREFIX"]?.trim() || DEFAULT_LABEL_PREFIX;

  console.log(`\n[probe] grant=${grantId} apiBase=${apiBase} apply=${apply}\n`);

  // 1) Grant details — provider + scope. Uses fetch directly (the SDK client
  //    surface we type doesn't expose grants; this is a raw diagnostic call).
  try {
    const res = await fetch(`${apiBase}/v3/grants/${grantId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const json: any = await res.json();
    const g = json?.data ?? json;
    console.log("[probe] grant provider :", g?.provider);
    console.log("[probe] grant email    :", g?.email);
    console.log("[probe] grant status   :", g?.grantStatus ?? g?.grant_status);
    const scopes: string[] = g?.scope ?? g?.scopes ?? [];
    console.log("[probe] grant scopes   :", Array.isArray(scopes) ? scopes.join(", ") : scopes);
    const hasModify = (Array.isArray(scopes) ? scopes.join(" ") : String(scopes)).includes("gmail.modify");
    console.log(
      `[probe] mail-modify?   : ${hasModify ? "YES — labeling should work" : "NOT DETECTED — apply will likely 403"}`,
    );
  } catch (err) {
    console.warn("[probe] could not read grant:", err instanceof Error ? err.message : String(err));
  }

  // 2) List folders/labels via the typed SDK client — the same call the feature uses.
  const client = getNylasClient();
  if (!client.folders) {
    console.error("[probe] SDK client has no folders surface — cannot continue.");
    return;
  }
  try {
    const listed = await client.folders.list({ identifier: grantId });
    console.log(`\n[probe] folders.list OK — ${listed.data.length} folders/labels`);
    const pluvusLabels = listed.data.filter((f) => f.name.startsWith(`${prefix}/`));
    console.log(
      `[probe] existing "${prefix}/" labels: ${
        pluvusLabels.length ? pluvusLabels.map((f) => f.name).join(", ") : "(none yet)"
      }`,
    );
  } catch (err) {
    console.error("[probe] folders.list FAILED:", err instanceof Error ? err.message : String(err));
    return;
  }

  // 3) Pick one real threaded conversation and (optionally) label it live.
  const row = (
    await db
      .selectDistinct({ threadId: messages.threadId, campaignName: campaigns.name })
      .from(messages)
      .innerJoin(executionInstances, eq(messages.instanceId, executionInstances.id))
      .innerJoin(workflowVersions, eq(executionInstances.workflowVersionId, workflowVersions.id))
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .innerJoin(campaigns, eq(workflows.campaignId, campaigns.id))
      .where(isNotNull(messages.threadId))
  );
  // Prefer a thread whose campaign label does NOT already exist, so --apply
  // exercises a real (non-no-op) create+apply. Falls back to the first thread.
  const listedNow = await client.folders.list({ identifier: grantId });
  const existingNames = new Set(listedNow.data.map((f) => f.name));
  const rowResult = row.find((r) => !existingNames.has(campaignLabelName(r.campaignName, prefix))) ?? row[0];

  if (!rowResult?.threadId) {
    console.log("\n[probe] no threaded conversation found to label — done.");
    return;
  }
  const sampleThreadId = rowResult.threadId;
  const label = campaignLabelName(rowResult.campaignName, prefix);
  console.log(`\n[probe] sample thread=${sampleThreadId} → label=${label}`);

  if (!apply) {
    console.log("[probe] inspect-only (pass --apply to actually label this thread).");
    return;
  }

  // Resolve the provider through the REAL production factory (reads the app's
  // GMAIL_LABELS_ENABLED from .env) — this exercises the exact same code path a
  // live send uses, on ONE thread. If the flag is off, applyThreadLabel no-ops.
  const provider = emailProvider();
  if (!isThreadLabeler(provider)) {
    console.error("[probe] active provider is not a labeler (EMAIL_PROVIDER!=nylas?) — cannot apply.");
    return;
  }
  if (process.env["GMAIL_LABELS_ENABLED"] !== "true") {
    console.warn("[probe] GMAIL_LABELS_ENABLED is not 'true' — applyThreadLabel will no-op.");
  }
  console.log("[probe] applying label live via the production provider…");
  await provider.applyThreadLabel(sampleThreadId, label);

  // Re-read the thread to prove the label id is now present alongside the
  // pre-existing (Gmail-owned) folders — the real applyThreadLabel above did it.
  if (client.threads) {
    const after = await client.threads.find({ identifier: grantId, threadId: sampleThreadId });
    const listed = await client.folders!.list({ identifier: grantId });
    const labelId = listed.data.find((f) => f.name === label)?.id;
    const folders = after.data.folders ?? [];
    console.log("[probe] thread folders AFTER apply:", folders);
    console.log(
      labelId && folders.includes(labelId)
        ? `[probe] ✅ label ${labelId} is on the thread — SUCCESS`
        : "[probe] ⚠ label did NOT stick — check the [labels] log above",
    );
  }
  console.log("\n[probe] done. Open Gmail and confirm the label sits on the whole conversation.\n");
}

main()
  .catch((err) => {
    console.error("[probe] failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
