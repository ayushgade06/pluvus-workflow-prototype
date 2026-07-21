/**
 * Optional one-shot backfill (Gmail Campaign Labels — spec §11).
 *
 * Walks every ExecutionInstance that has an outbound thread (a Message.threadId),
 * resolves its campaign name OFFLINE via a per-thread join (fine here — this is a
 * batch job, NOT the hot send path), and applies the `Pluvus/<Campaign name>`
 * label to the thread. This makes EXISTING conversations show up under their Gmail
 * label immediately, rather than only after their next send self-heals the label.
 *
 * Properties (spec §11):
 *   - Idempotent / re-runnable: applyThreadLabel skips an already-present label
 *     (a Gmail no-op), so running twice is safe.
 *   - Rate-limit-aware: reuses the provider's per-process find-or-create cache
 *     (§6.5), so folders.list/create is hit at most once per distinct label; the
 *     apply loop is sequential (one thread at a time) rather than a burst.
 *   - Guarded: dry-run by DEFAULT — pass --apply to actually label. Also requires
 *     EMAIL_PROVIDER=nylas + GMAIL_LABELS_ENABLED=true (the same gate as live
 *     sends), and a labeler-capable provider; otherwise it refuses to run.
 *   - Logs a summary: threads considered / labeled / skipped / errored.
 *
 * Run from server/:
 *   npx tsx scripts/backfill-gmail-labels.ts               (DRY RUN — report only)
 *   npx tsx scripts/backfill-gmail-labels.ts --apply       (apply the labels)
 *
 * Env required for --apply:
 *   EMAIL_PROVIDER=nylas, GMAIL_LABELS_ENABLED=true, NYLAS_API_KEY, NYLAS_GRANT_ID
 *   (the grant must have Gmail mail-modify scope — see readme_docs/ops/SECRETS.md).
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
import { emailProvider } from "../src/engine/providerFactory.js";
import { isThreadLabeler } from "../src/engine/providers.js";
import {
  campaignLabelName,
  DEFAULT_LABEL_PREFIX,
} from "../src/providers/nylas/campaignLabel.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const prefix = process.env["GMAIL_LABEL_PREFIX"]?.trim() || DEFAULT_LABEL_PREFIX;

  console.log(
    `\n[backfill-gmail-labels] scanning threaded conversations${
      apply ? "" : " (DRY RUN — no labels applied; pass --apply to write)"
    }\n`,
  );

  // Resolve the provider. In --apply mode it MUST be a labeler (Nylas with the
  // flag on); otherwise there is nothing to do and we bail loudly rather than
  // silently no-op every thread. The isThreadLabeler guard narrows the type so
  // the apply loop below calls applyThreadLabel without a cast.
  const provider = emailProvider();
  const labeler = isThreadLabeler(provider) ? provider : null;
  if (apply && !labeler) {
    throw new Error(
      "The active email provider does not support labeling. For --apply, set " +
        "EMAIL_PROVIDER=nylas with a Gmail modify-scope grant. (The label apply " +
        "additionally requires GMAIL_LABELS_ENABLED=true, or every apply no-ops.)",
    );
  }
  if (apply && process.env["GMAIL_LABELS_ENABLED"] !== "true") {
    // The provider's applyThreadLabel early-returns unless the flag is on; without
    // it every apply would no-op and the run would falsely report "labeled".
    throw new Error(
      "GMAIL_LABELS_ENABLED is not 'true'. Set it (and confirm the grant's " +
        "mail-modify scope) before running the backfill with --apply.",
    );
  }

  // One row per (threadId, campaign name): the join messages → instance → version
  // → workflow → campaign. DISTINCT collapses a thread's many messages to a single
  // label apply. threadId not-null filters out reserved-but-unsent rows.
  const rows = await db
    .selectDistinct({
      threadId: messages.threadId,
      campaignName: campaigns.name,
    })
    .from(messages)
    .innerJoin(executionInstances, eq(messages.instanceId, executionInstances.id))
    .innerJoin(
      workflowVersions,
      eq(executionInstances.workflowVersionId, workflowVersions.id),
    )
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .innerJoin(campaigns, eq(workflows.campaignId, campaigns.id))
    .where(isNotNull(messages.threadId));

  let labeled = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of rows) {
    // threadId is non-null by the WHERE; campaignName is notNull on the column.
    const threadId = row.threadId as string;
    const label = campaignLabelName(row.campaignName, prefix);

    if (!apply) {
      console.log(`  would label thread ${threadId} → ${label}`);
      skipped++;
      continue;
    }

    try {
      // applyThreadLabel is best-effort + idempotent: it find-or-creates the label
      // (reusing the per-process cache) and skips an already-present label. It
      // never throws, but we still count outcomes for the summary. `labeler` is
      // non-null here — the --apply guard above bailed otherwise.
      await labeler!.applyThreadLabel(threadId, label);
      labeled++;
      console.log(`  labeled thread ${threadId} → ${label}`);
    } catch (err) {
      // Defensive — applyThreadLabel swallows internally, but never let one thread
      // abort the whole batch.
      errored++;
      console.warn(
        `  ERROR labeling thread ${threadId} (${label}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  console.log(
    `\n[backfill-gmail-labels] done. threads=${rows.length} ` +
      `labeled=${labeled} skipped=${skipped} errored=${errored}` +
      `${apply ? "" : " (dry run — re-run with --apply to write)"}\n`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-gmail-labels] failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
