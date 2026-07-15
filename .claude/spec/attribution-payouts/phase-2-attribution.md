# Phase 2 — Click Tracking & Conversion Attribution

**Status:** BUILT
**Depends on:** Phase 1 (Partnership table, referral codes)
**Size:** M

## Goal

Answer "how many users came from this creator, and how much revenue" with real data:
count clicks on the tracked link, and ingest conversions from **our own product** via a
server-to-server webhook. Commission is computed and frozen in cents at ingest time.

## 1. The attribution contract with our product (decide first, it shapes everything)

The referral code travels: **link param → product session → conversion webhook.**

1. Creator shares `{targetUrl}?_from={referralCode}` (Phase 1 link) — or the `/t/{code}`
   short link below, which 302s to the same URL.
2. Our product, on landing, captures the `_from` param and persists it for the session
   (cookie / localStorage / signup record — product-side choice, out of this repo's scope).
3. On the conversion moment (signup or first payment — **product decision, pick one and
   write it in the runbook**), the product back-end POSTs `/attribution/conversion` with
   the stored code and its own stable id for the event (`externalId` = e.g. its order id
   or `signup:{userId}`).

This mirrors the parent exactly (param key convention `_from`, conversion idempotency on
an external id — `Pluvus/shared/schema.ts:578,647`), minus Stripe/Shopify adapters we
don't need because both sides are ours.

## 2. Schema

### 2.1 `Click`

```ts
export const clicks = pgTable(
  "Click",
  {
    id: cuidId("id"),
    partnershipId: text("partnershipId").notNull().references(() => partnerships.id),
    referralCode: text("referralCode").notNull(),   // denormalized (I-2-adjacent: survives partnership edits)
    ip: text("ip"),
    userAgent: text("userAgent"),
    referer: text("referer"),
    clickedAt: tsNow("clickedAt"),
  },
  (table) => [
    index("Click_partnershipId_idx").on(table.partnershipId),
    index("Click_clickedAt_idx").on(table.clickedAt),
  ],
);
```

### 2.2 `Conversion`

```ts
export const conversions = pgTable(
  "Conversion",
  {
    id: cuidId("id"),
    partnershipId: text("partnershipId").references(() => partnerships.id), // nullable: unknown code kept for audit
    referralCode: text("referralCode"),
    externalId: text("externalId").notNull(),        // I-3: idempotency key from our product
    valueCents: integer("valueCents").notNull(),     // I-1
    currency: text("currency").notNull().default("USD"),
    commissionCents: integer("commissionCents").notNull().default(0), // I-2: frozen at ingest
    customerEmail: text("customerEmail"),
    metadata: jsonb("metadata").$type<JsonValue>(),
    payoutId: text("payoutId"),                      // Phase 3 lock; null = unpaid
    refunded: boolean("refunded").notNull().default(false),
    attributedAt: tsNow("attributedAt"),
  },
  (table) => [
    uniqueIndex("Conversion_externalId_key").on(table.externalId),
    index("Conversion_partnershipId_idx").on(table.partnershipId),
    index("Conversion_payoutId_idx").on(table.payoutId),
  ],
);
```

SQL (Neon): corresponding `CREATE TABLE` statements (derive from the Drizzle exactly as
Phase 1 did), plus:
```sql
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'CONVERSION_RECORDED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'CONVERSION_REFUNDED';
```

Parent deviations, on purpose: money in cents not `real` (I-1); no tenant column
(single-tenant proto); no `clickId` FK chain (first-touch by code is enough — non-goal).

## 3. DB helpers

`server/src/db/clicks.ts`: `recordClick(data)`, `countClicksByPartnership(id)`.
`server/src/db/conversions.ts`: `createConversion(data)` (throws on duplicate),
`findConversionByExternalId`, `listConversionsByPartnership(id)`,
`unpaidCommissionConversions(partnershipId)` (where `payoutId IS NULL AND refunded =
false AND commissionCents > 0` — Phase 3's payout source), `markConversionRefunded(id)`,
`partnershipMetrics(partnershipId)` → `{ clicks, conversions, revenueCents,
earnedCents, unpaidCents, paidCents }` (single grouped query; paid = sum where
`payoutId IS NOT NULL`).

## 4. Routes

### 4.1 `GET /t/:referralCode` — public redirect (new router `routes/tracking.ts`, mount `app.use("/t", …)`)

1. `findPartnershipByReferralCode`. Unknown or `PAUSED` → minimal 404 HTML page
   (paymentPage style). Partnership found but campaign has no `targetUrl` → same 404
   (log loudly — a shared short link for a link-less campaign is a config bug).
2. Best-effort `recordClick` in try/catch — **the redirect must never fail because the
   insert did** (I-8). Capture `x-forwarded-for` first hop, `user-agent`, `referer`
   (same header handling as `Pluvus/server/routes/api/payouts.ts:725`).
3. `302` to `targetUrl` + `hiddenParamKey={code}`.

No rate limiting, no bot filtering (internal pilot; note as future work — parent doesn't
filter either).

### 4.2 `POST /attribution/conversion` — product webhook (new router `routes/attribution.ts`, mount `app.use("/attribution", …)` after `express.json()`)

Auth: if `ATTRIBUTION_WEBHOOK_SECRET` is set, require header `X-Attribution-Secret` to
match (constant-time compare) else 401. Unset → accept + one-time startup warning
(`AGENT_API_KEY` posture, `.env.example:41-46`).

Body (zod-validated):
```ts
{
  referralCode: string,          // required
  externalId: string,            // required, product's stable id for this event
  amountCents?: number,          // int ≥ 0 — preferred
  amount?: number,               // decimal dollars fallback → Math.round(amount * 100)
  currency?: string,             // default "USD"
  customerEmail?: string,
  metadata?: Record<string, unknown>,
}
```
Exactly one of `amountCents`/`amount` required. Free/`$0` conversions (signups) allowed —
`valueCents = 0`, commission 0, still counted.

Handler:
1. Resolve partnership by code. Found → `commissionCents = partnership.commissionRate
   ? Math.round(valueCents * partnership.commissionRate / 100) : 0`. Not found →
   persist with null `partnershipId`, commission 0 (audit row), respond
   `202 { attributed: false }`.
2. `createConversion`; on `isUniqueViolation` → `200 { duplicate: true }` (I-3, I-8 —
   the product may retry; both orders of arrival are safe).
3. Attributed → append `CONVERSION_RECORDED` event on the partnership's instance,
   payload `{ externalId, valueCents, commissionCents }` (I-7).
4. `201 { attributed: true, conversionId }`.

### 4.3 `POST /attribution/conversion/:externalId/refund`

Same auth. Guards: not found → 404; already refunded → 200 no-op; **`payoutId` set →
`409 { error: "locked into payout" }`** — money already staged/paid is a human problem,
not an automatic clawback (PLAN non-goal). Else flip `refunded = true`, append
`CONVERSION_REFUNDED` event.

## 5. Read API (consumed by Phase 4, useful immediately via curl)

`GET /partnerships` → list with `partnershipMetrics` merged per row.
`GET /partnerships/:id` → partnership + creator + campaign + metrics + recent
conversions/clicks (cap 100, newest first). New router `routes/partnerships.ts`,
mount `app.use("/partnerships", …)`. (Brand-side, unauthenticated — repo convention.)

## 6. Tests & exit criteria

Unit: webhook validation matrix (missing fields, both/neither amount forms, bad secret,
negative amount → 400); duplicate `externalId` → 200 no new row; unknown code → 202
audit row; commission rounding cases (`valueCents=999, rate=15` → `150`); refund guards
(locked → 409); redirect logs click + preserves existing query params on targetUrl;
redirect still 302s when click insert throws (mock DB failure — I-8); metrics query
returns correct buckets across paid/unpaid/refunded mixes.

Harness (`engine/attribution.harness.ts`): real stack — mint partnership (Phase 1
harness path), hit `/t/:code`, POST 3 conversions (one duplicate, one unknown code),
assert metrics `{clicks:1, conversions:2 attributed:1…}` and inspector events.

Runbook (`readme_docs/testing/`): the product-side integration steps — where the param
is captured, which event fires the webhook, the curl to simulate it.

**Exit criteria:**
- [ ] Click from a phone via tunnel lands on the product with the param; click counted.
- [ ] Product-fired (or curl-simulated) conversion appears under the right creator with
      correct cents; replaying it is a no-op.
- [ ] Unknown-code conversions are kept but unattributed; refunds respect the payout lock.
- [ ] `tsc` clean, suite green, harness green, DDL applied + `db:pull` refreshed.
