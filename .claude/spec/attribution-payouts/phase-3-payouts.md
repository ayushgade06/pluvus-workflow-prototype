# Phase 3 — Payout Ledger: Owed → Paid → Confirmed

**Status:** BUILT (branch `feat/attribution-phase-3`)
**Depends on:** Phases 1–2 (Partnership, Conversion)
**Size:** M–L (the money phase — most invariants live here)

## Goal

Track everything owed to a creator (fixed fee + earned commission), let the **brand mark
a payout as paid** (with the PayPal transaction reference), and let the **creator confirm
or dispute receipt** through emailed magic links. Disputes notify the brand; silence
auto-settles. PayPal is the only method in practice for now — the ledger reads whatever
`PaymentInfo.method`/`accountIdentifier` the creator submitted, so nothing hard-codes it.

Status machine (ported from the parent, `Pluvus/shared/schema.ts:534`):

```
PENDING ──(brand: mark sent + txn ref)──▶ SENT ──(creator: confirm)──▶ SETTLED
                                            │──(creator: dispute)──▶ DISPUTED ──(brand: resolve/settle)──▶ SETTLED
                                            └──(7 days silence, scheduler)──▶ SETTLED
```

## 1. Schema

### 1.1 Enums + `Obligation` (fixed fee owed) + `Payout`

```ts
export const obligationStatusEnum = pgEnum("ObligationStatus", ["PENDING", "PAID", "CANCELLED"]);
export const payoutStatusEnum = pgEnum("PayoutStatus", ["PENDING", "SENT", "CONFIRMED", "DISPUTED", "SETTLED"]);
export const payoutTypeEnum = pgEnum("PayoutType", ["COMMISSION", "FIXED_FEE"]);

export const obligations = pgTable("Obligation", {
  id: cuidId("id"),
  partnershipId: text("partnershipId").notNull().references(() => partnerships.id),
  description: text("description").notNull(),        // "Agreed collaboration fee"
  amountCents: integer("amountCents").notNull(),
  status: obligationStatusEnum("status").notNull().default("PENDING"),
  payoutId: text("payoutId"),                        // set when converted to a payout
  createdAt: tsNow("createdAt"),
  paidAt: ts("paidAt"),
}, (t) => [index("Obligation_partnershipId_idx").on(t.partnershipId)]);

export const payouts = pgTable("Payout", {
  id: cuidId("id"),
  partnershipId: text("partnershipId").notNull().references(() => partnerships.id),
  payoutType: payoutTypeEnum("payoutType").notNull(),
  amountCents: integer("amountCents").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: payoutStatusEnum("status").notNull().default("PENDING"),
  method: payoutMethodEnum("method"),                // I-2: copied from PaymentInfo at creation
  destination: text("destination"),                  // I-2: copied accountIdentifier (PayPal email)
  reference: text("reference"),                      // PayPal txn id, set at mark-sent
  note: text("note"),
  conversionCount: integer("conversionCount").notNull().default(0),
  confirmTokenHash: text("confirmTokenHash"),        // sha256 hex — raw token never stored
  confirmTokenExpiresAt: ts("confirmTokenExpiresAt"),
  confirmIp: text("confirmIp"),
  confirmUserAgent: text("confirmUserAgent"),
  sentAt: ts("sentAt"),
  confirmedAt: ts("confirmedAt"),
  disputedAt: ts("disputedAt"),
  settledAt: ts("settledAt"),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
}, (t) => [
  index("Payout_partnershipId_idx").on(t.partnershipId),
  index("Payout_status_idx").on(t.status),
]);
```

SQL: matching `CREATE TYPE`/`CREATE TABLE`/indexes, plus:
```sql
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PAYOUT_CREATED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PAYOUT_SENT';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PAYOUT_CONFIRMED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PAYOUT_DISPUTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PAYOUT_SETTLED';
```

### 1.2 Obligation minting + backfill

- Extend Phase 1's `resolvePartnership`: when `agreedFeeCents` is non-null, also create
  the Obligation row (`description: "Agreed collaboration fee"`) in the same code path,
  idempotent by checking `listObligationsByPartnership` first (a partnership has at most
  one auto-minted fee obligation; manual extras are Phase-4+ future work).
- One-off script `server/scripts/backfill-obligations.ts` (tsx): for existing
  partnerships with `agreedFeeCents` and no obligation → create. Run once after deploy.

## 2. DB helpers — `server/src/db/obligations.ts`, `server/src/db/payouts.ts`

Usual CRUD plus the two transactional creators (below) and
`listPayoutsByPartnership`, `findPayoutById`, `listSentPayoutsOlderThan(date)`.

## 3. Brand-side routes — new `routes/payouts.ts`, mount `app.use("/payouts", …)`

### 3.1 `POST /payouts/partnerships/:partnershipId/commission` — create commission payout

**Single DB transaction (I-4):**
```
SELECT … FROM "Conversion"
  WHERE "partnershipId" = $1 AND "payoutId" IS NULL AND refunded = false AND "commissionCents" > 0
  FOR UPDATE;
-- none → rollback, 400 { error: "no unpaid commission" }
INSERT Payout (COMMISSION, amountCents = SUM(commissionCents), conversionCount = COUNT,
               method/destination copied from the instance's PaymentInfo row);
UPDATE "Conversion" SET "payoutId" = <new id> WHERE id IN (…);
```
`method`/`destination` come from `findPaymentInfoByInstance(partnership.instanceId)` —
if the row is missing or has no `accountIdentifier`, 409 (`"creator has no payout
info"`) — cannot happen for Phase-1-minted partnerships but guard anyway.
Append `PAYOUT_CREATED` event. Drizzle transaction via the existing `db.transaction`;
`FOR UPDATE` via `sql` fragment — this lock is what makes concurrent double-create safe.

### 3.2 `POST /payouts/obligations/:obligationId/fixed-fee` — create fixed-fee payout

Transaction: re-read obligation `FOR UPDATE`; status must be `PENDING` (else 400 with
current status — parent's guard message shape, `payouts.ts:179-181`); insert Payout
(`FIXED_FEE`, amount = obligation.amountCents, copy method/destination as above);
update obligation `status='PAID', payoutId, paidAt=now()`.

### 3.3 `POST /payouts/:id/send` — brand marks it paid

Body `{ reference?: string, note?: string }`. Guard: status `PENDING` only (400 otherwise).

1. Mint confirm token: `rawToken = randomBytes(32).toString("hex")`; store only
   `sha256(rawToken)` hex + `confirmTokenExpiresAt = now + PAYOUT_CONFIRM_TTL_DAYS`
   (default 7). Exactly the parent's recipe (`payouts.ts:588-592`) — raw token exists
   only in the email.
2. Update: `status='SENT', sentAt, reference, note`.
3. Email the creator (see §5) with
   `{PAYMENT_BASE_URL}/payout/confirm/{payoutId}?token={rawToken}` and
   `…/payout/dispute/{payoutId}?token={rawToken}`.
4. Append `PAYOUT_SENT` event. Email failure does not roll back the status (parent
   posture, `payouts.ts:628-631`) — response carries `emailSent: false` and Phase 4
   shows a resend button (`POST /payouts/:id/resend`, re-mints token, only from SENT).

### 3.4 `POST /payouts/:id/settle` — brand resolves

Guard: status `CONFIRMED` or `DISPUTED` only (parent rule, `payouts.ts:663-665`).
→ `SETTLED`, `settledAt`, event.

## 4. Creator-side confirm/dispute — public, token-gated (extend `routes/payment.ts`'s sibling: new `routes/payoutConfirm.ts`, mount `app.use("/payout", …)`)

**I-5 applies: GET renders, POST mutates.** Do not port the parent's GET-mutation.

- `GET /payout/confirm/:payoutId?token=…` and `GET /payout/dispute/:payoutId?token=…`
  1. Load payout; hash the query token; compare to `confirmTokenHash`
     (`crypto.timingSafeEqual` on the hex buffers). Mismatch/absent → friendly invalid
     page (404 semantics, no detail).
  2. Expired (`confirmTokenExpiresAt < now`) → "link expired — contact {brand}" page.
  3. Status not `SENT` → "already {confirmed/disputed/settled}" idempotent notice
     (mail-prefetch of the *other* link after acting must be a safe no-op).
  4. Else render interstitial: amount (from cents), brand name, reference, one button
     (`Confirm I received this` / `I did not receive this`) POSTing to the same URL
     with the token in a hidden field. Server-rendered HTML, `paymentPage.ts` style.
- `POST /payout/confirm/:payoutId` → same guards, then `status='SETTLED'` (confirm
  short-circuits to settled — parent semantics, `payouts.ts:718-728`), stamp
  `confirmedAt`+`settledAt`, capture `confirmIp` (first `x-forwarded-for` hop) +
  `confirmUserAgent`, append `PAYOUT_CONFIRMED` + `PAYOUT_SETTLED` events, render
  thank-you page.
- `POST /payout/dispute/:payoutId` → `status='DISPUTED'`, `disputedAt`, audit fields,
  `PAYOUT_DISPUTED` event, **email the brand** (§5), render "we've flagged this" page.

## 5. Emails (pure templates + `sendOnce`, I-6)

| Template file | To | Subject | Key |
|---|---|---|---|
| `payoutSentEmail.ts` | creator | `{brand} sent you ${amount}` | `payout:sent:{payoutId}` (resend uses `payout:resent:{payoutId}:{n}`) |
| `payoutDisputedEmail.ts` | brand | `[DISPUTE] {creator} did not receive ${amount}` | `payout:disputed:{payoutId}` |

Brand recipient precedence — reuse the Phase-11 manual-queue chain verbatim:
`campaign.notifyEmail` → `BRAND_NOTIFY_EMAIL` → operator default. Amounts rendered from
cents with `Intl.NumberFormat("en-US", {style:"currency", currency})` (parent,
`payouts.ts:730-733`). The sent-email body includes: amount, reference (txn id), the two
links, expiry note ("links valid {N} days; no action needed if everything looks right —
we'll mark it settled automatically").

## 6. Auto-settle sweep (scheduler, not lazy GET)

Add to the existing scheduler (`scheduler/scheduler.ts`, runs under the W-8 Redis leader
lease — no duplicate-fire risk): every cycle,
`listSentPayoutsOlderThan(now - PAYOUT_AUTO_SETTLE_DAYS)` → set `SETTLED` + `settledAt`,
append `PAYOUT_SETTLED` event with payload `{ auto: true }`, log count. Deliberate
upgrade over the parent's settle-inside-GET (`payouts.ts:352-373`).

## 7. Tests & exit criteria

Unit: every status-guard rejection (send from SENT, settle from PENDING, confirm on
expired/reused/mismatched token, dispute after confirm); token hash round-trip +
timing-safe compare; commission-payout transaction — **two concurrent create calls
produce one payout** (drive with two parallel transactions against a real test DB);
refunded/locked conversions excluded; obligation double-pay blocked; interstitial GET
mutates nothing (assert row unchanged after GET); auto-settle picks only SENT older
than cutoff; cents rendering in both emails; recipient precedence chain.

Harness (`engine/payouts.harness.ts`): full loop on a real stack — partnership with
conversions (Phase 2 harness path) → create both payout types → send (capture raw token
from the mock email provider's outbox) → GET interstitial → POST confirm → assert
SETTLED + events; repeat with dispute → assert brand email.

Live runbook: real inbox, real PayPal reference string, both links exercised from a
phone, plus the prefetch check (curl the GET twice, then confirm — still works once).

**Exit criteria:**
- [x] Brand can pay the fixed fee and commission separately; each conversion is locked
      into exactly one payout, provably under concurrency. _(payouts.harness: two parallel
      commission creates → exactly one payout; conversions stamped with payoutId.)_
- [x] Creator confirm → SETTLED; dispute → brand notified; silence → auto-settled by the
      scheduler; every transition visible in the inspector timeline. _(harness drives the
      full confirm loop, the full dispute loop + brand email, and the auto-settle sweep with
      an `{ auto: true }` PAYOUT_SETTLED event; all transitions append instance events, I-7.)_
- [x] Expired/tampered/reused links all land on safe pages; GETs never mutate. _(payoutToken
      unit tests cover match/tamper/absent/expiry; harness asserts 4 GETs of both links leave
      the row SENT, a tampered token 404s, and a reused link after settle is a safe notice.)_
- [x] `tsc` clean, suite green (151 pass, +3 files), harness green, backfill script run
      (0 candidates on Neon — no pre-Phase-3 fees exist), DDL applied to Neon + a catch-up
      Prisma migration added (Phases 1–3) so the PGlite test path is complete, `.env.example`
      updated with `PAYOUT_CONFIRM_TTL_DAYS` + `PAYOUT_AUTO_SETTLE_DAYS`.
      _Note: `npm run db:pull` is broken in this environment by a pre-existing drizzle-kit /
      drizzle-orm version mismatch (`./gel-core` export error, unrelated to this change);
      the live Neon schema was instead verified directly (every Obligation/Payout column +
      the 5 PAYOUT_* enum values present) — a stronger check than the introspection refresh._

**Deviations from the parent (deliberate, per I-1/I-4/I-5):**
- Money in integer cents (parent uses `real`). Amounts rendered from cents with
  `Intl.NumberFormat`, with a safe fallback so a malformed currency never breaks a render.
- `SELECT … FOR UPDATE` (raw `sql` fragment) inside `db.transaction` for both payout
  creators — the true concurrency guarantee (proven against real Neon in the harness, since
  PGlite's single connection can't demonstrate cross-connection locking).
- Confirm/dispute are GET-interstitial + POST-mutate; the parent's GET-mutation is NOT
  ported. Token stored sha256-hashed only, timing-safe compared, TTL-bounded.
- Auto-settle runs in the scheduler sweep under the leader lease — never a lazy GET-time
  settle (the parent settles inside a list GET).
