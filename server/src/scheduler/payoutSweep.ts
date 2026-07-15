import {
  appendEvent,
  autoSettlePayout,
  listSentPayoutsOlderThanWithInstance,
} from "../db/index.js";

// ---------------------------------------------------------------------------
// Auto-settle sweep (Phase 3)
// ---------------------------------------------------------------------------
// Runs on the scheduler poll cadence, under the W-8 Redis leader lease (only the
// leader polls), so there is no duplicate-fire risk. A SENT payout the creator
// never confirmed or disputed auto-settles after PAYOUT_AUTO_SETTLE_DAYS: we
// flip it SETTLED, stamp settledAt, and append a PAYOUT_SETTLED event with
// { auto: true } (I-7). Deliberate upgrade over the parent's settle-inside-GET
// (Pluvus/server/routes/api/payouts.ts:352-373) — money never settles as a side
// effect of someone opening a list page.

const DEFAULT_AUTO_SETTLE_DAYS = 7;

function autoSettleDays(): number {
  const raw = Number(process.env["PAYOUT_AUTO_SETTLE_DAYS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTO_SETTLE_DAYS;
}

/** Cutoff instant: SENT payouts with sentAt before this auto-settle. */
export function autoSettleCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - autoSettleDays() * 24 * 60 * 60 * 1000);
}

/**
 * Settle every SENT payout older than the cutoff. Returns the count settled.
 * Best-effort per payout: a failed settle/event on one payout is logged and the
 * sweep continues; the whole function has its own try/catch at the caller so a
 * DB blip never disturbs the due-instance path.
 */
export async function sweepAutoSettlePayouts(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = autoSettleCutoff(now);
  const stale = await listSentPayoutsOlderThanWithInstance(cutoff);
  if (stale.length === 0) return 0;

  let settled = 0;
  for (const { payout, instanceId } of stale) {
    try {
      // autoSettlePayout's WHERE requires SENT, so a payout the creator just
      // confirmed in the same tick is a no-op (returns null) — never overwrites.
      const row = await autoSettlePayout(payout.id);
      if (!row) continue;
      settled++;
      try {
        await appendEvent({
          instanceId,
          type: "PAYOUT_SETTLED",
          payload: { payoutId: payout.id, auto: true },
        });
      } catch (err) {
        console.error(
          `[payoutSweep] PAYOUT_SETTLED event failed for payout ${payout.id} (non-fatal)`,
          err,
        );
      }
    } catch (err) {
      console.error(`[payoutSweep] auto-settle failed for payout ${payout.id}`, err);
    }
  }

  if (settled > 0) {
    console.log(`[payoutSweep] auto-settled ${settled} payout(s) (no response after ${autoSettleDays()} days)`);
  }
  return settled;
}
