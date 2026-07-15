# Attribution Phase 3 — Payout Ledger Testing Runbook

**Branch:** `feat/attribution-phase-3`
**Spec:** `.claude/spec/attribution-payouts/phase-3-payouts.md`

---

## What Phase 3 adds

The post-terminal money ledger keyed off a completed partnership:

- **Obligation** — the fixed collaboration fee owed (minted at partnership
  activation; backfilled for pre-Phase-3 partnerships).
- **Payout** — a concrete disbursement the brand records as paid, either a
  **commission** batch (sums the partnership's unpaid conversions and locks each
  into one payout) or a **fixed-fee** (pays one obligation).
- The brand marks a payout **sent** with the PayPal transaction reference; the
  creator **confirms** or **disputes** receipt via emailed magic links; disputes
  email the brand; silence **auto-settles** after `PAYOUT_AUTO_SETTLE_DAYS`.

Status machine: `PENDING → SENT → (CONFIRMED via short-circuit → )SETTLED`, or
`SENT → DISPUTED → (brand resolves) SETTLED`, or `SENT → (7-day sweep) SETTLED`.

---

## Automated coverage (run these first)

```bash
cd server
npm run typecheck            # tsc clean
npm test                     # full suite incl. payoutToken / payoutEmails / payouts.db
npm run harness:payouts      # full confirm + dispute + sweep loop vs the real Neon stack
```

The harness (`src/engine/payouts.harness.ts`) boots the real Express app on an
ephemeral port, seeds a throwaway partnership + conversions + obligation, and
proves: concurrency (two parallel commission creates → one payout), conversion
locking, fixed-fee pay + double-pay block, token mint (sha256-hash-only) + email,
GET-mutates-nothing, token tamper/reuse, confirm→SETTLED, dispute→brand email,
brand settle, and the auto-settle sweep. It cleans up all seeded rows.

---

## Env

```
PAYMENT_BASE_URL=<public tunnel origin>   # the one public origin for all creator links
EMAIL_PROVIDER=nylas                      # real email (mock for dry runs)
BRAND_NOTIFY_EMAIL=<you>                  # dispute notices land here (unless campaign.notifyEmail set)
PAYOUT_CONFIRM_TTL_DAYS=7                 # confirm/dispute link lifetime
PAYOUT_AUTO_SETTLE_DAYS=7                 # SENT→SETTLED sweep window
```

---

## Backfill (run once after deploy)

Mints the fixed-fee obligation for partnerships activated before Phase 3:

```bash
cd server
npx tsx scripts/backfill-obligations.ts --dry-run   # report only
npx tsx scripts/backfill-obligations.ts             # mint
```

Idempotent — safe to re-run (skips partnerships that already have an obligation
or no agreed fee).

---

## Live end-to-end (real inbox, real PayPal reference)

Assumes you have a partnership id `P` (from the Phase-1/2 flow) with unpaid
conversions and/or a pending obligation `O`.

1. **Create a commission payout** (locks the unpaid conversions):
   ```bash
   curl -sX POST $BASE/payouts/partnerships/$P/commission | jq
   ```
   → `201` with `{ amountCents, conversionCount, status: "PENDING", ... }`.
   A second call → `400 { "error": "no unpaid commission" }` (nothing double-paid).

2. **Create a fixed-fee payout**:
   ```bash
   curl -sX POST $BASE/payouts/obligations/$O/fixed-fee | jq
   ```
   → `201`. A second call → `400 … Current status: 'PAID'`.

3. **Pay in PayPal for real**, then **mark it sent** with the txn reference:
   ```bash
   curl -sX POST $BASE/payouts/<payoutId>/send \
     -H 'content-type: application/json' \
     -d '{"reference":"<paypal-txn-id>"}' | jq
   ```
   → `{ status: "SENT", emailSent: true }`. The creator receives the
   "you've been paid" email with **Confirm** and **Dispute** buttons.

4. **Prefetch check (I-5)** — simulate a mail scanner opening the links, then
   confirm still works once:
   ```bash
   curl -s "$BASE/payout/confirm/<payoutId>?token=<raw>" >/dev/null   # GET twice
   curl -s "$BASE/payout/confirm/<payoutId>?token=<raw>" >/dev/null
   # payout is still SENT — GET mutated nothing
   ```
   Then click **Confirm** from your phone → the payout settles once. A GET never
   settled it.

5. **Dispute path** — on a different payout, click **Dispute** from your phone →
   the payout flips `DISPUTED` and the brand (`BRAND_NOTIFY_EMAIL` or the
   campaign's `notifyEmail`) receives a `[DISPUTE] …` email. Resolve it:
   ```bash
   curl -sX POST $BASE/payouts/<payoutId>/settle | jq   # DISPUTED → SETTLED
   ```

6. **Auto-settle** — mark a payout sent and leave it. After
   `PAYOUT_AUTO_SETTLE_DAYS` the scheduler sweep flips it `SETTLED` and records a
   `PAYOUT_SETTLED { auto: true }` event. (To test faster, backdate its `sentAt`
   or lower the env var.)

Every transition above appears in the observability inspector timeline for the
partnership's instance (events `PAYOUT_CREATED / SENT / CONFIRMED / DISPUTED /
SETTLED`).

---

## Failure cases to eyeball

- Expired link → "link expired — contact your brand" page (410).
- Tampered token → "link not found" (404, no detail).
- Reused link after settle → safe "nothing to do" notice (not a 500).
- Commission create when the creator has no payout info → `409 creator has no
  payout info`.
