/**
 * One-off backfill: mint the fixed-fee Obligation for partnerships that were
 * activated BEFORE Phase 3 shipped (so they carry an `agreedFeeCents` but have
 * no Obligation row). Phase-3-activated partnerships already mint their
 * obligation in resolvePartnership, so this only touches the historical gap.
 *
 * Idempotent: it reuses mintFeeObligation, which no-ops when an obligation
 * already exists or the partnership has no agreed fee. Safe to run more than once.
 *
 * Run once after deploy, from server/:
 *   npx tsx scripts/backfill-obligations.ts
 *   npx tsx scripts/backfill-obligations.ts --dry-run   (report only, no writes)
 */

import { isNotNull } from "drizzle-orm";
import { db, pool } from "../src/db/drizzle.js";
import { partnerships } from "../src/db/schema.js";
import { mintFeeObligation } from "../src/engine/executors/partnership.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(
    `\n[backfill-obligations] scanning partnerships with an agreed fee${
      dryRun ? " (DRY RUN — no writes)" : ""
    }\n`,
  );

  // Every partnership that carries a fixed fee is a candidate; mintFeeObligation
  // skips the ones that already have an obligation.
  const candidates = await db
    .select({ id: partnerships.id, agreedFeeCents: partnerships.agreedFeeCents })
    .from(partnerships)
    .where(isNotNull(partnerships.agreedFeeCents));

  let minted = 0;
  let skipped = 0;
  for (const p of candidates) {
    if (dryRun) {
      // Report intent without writing: replicate the "already has one?" check via
      // the real mint only when not dry-running.
      console.log(
        `  would consider ${p.id} (agreedFeeCents=${p.agreedFeeCents})`,
      );
      continue;
    }
    const didMint = await mintFeeObligation(p.id, p.agreedFeeCents);
    if (didMint) {
      minted++;
      console.log(`  minted obligation for partnership ${p.id} (${p.agreedFeeCents}¢)`);
    } else {
      skipped++;
    }
  }

  console.log(
    `\n[backfill-obligations] done. candidates=${candidates.length} minted=${minted} skipped=${skipped}\n`,
  );
}

main()
  .catch((err) => {
    console.error("[backfill-obligations] failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
