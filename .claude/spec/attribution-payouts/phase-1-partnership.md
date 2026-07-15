# Phase 1 — Partnership Record & Referral Link

**Status:** BUILT
**Depends on:** nothing (first phase)
**Size:** S

## Goal

The moment a creator submits the hosted payout form (the workflow's completion step),
mint a durable **Partnership** row carrying a unique referral code and tracking link,
freeze the money terms (commission rate + agreed fee) onto it, and send the creator a
welcome email with their link. After this phase, every completed workflow run produces
an activated, linkable partner — even before any attribution or payout machinery exists.

## 1. Schema changes

### 1.1 `Campaign` — two new columns (`server/src/db/schema.ts:210-228`)

```ts
// inside campaigns pgTable
targetUrl: text("targetUrl"),                                    // product landing page; null = no tracking link (KOL-style flat-fee deal)
hiddenParamKey: text("hiddenParamKey").notNull().default("_from"), // ?_from=<code> — parent's tracking param convention
```

SQL (Neon):
```sql
ALTER TABLE "Campaign" ADD COLUMN "targetUrl" text;
ALTER TABLE "Campaign" ADD COLUMN "hiddenParamKey" text NOT NULL DEFAULT '_from';
```

### 1.2 New `Partnership` table

```ts
export const partnershipStatusEnum = pgEnum("PartnershipStatus", ["ACTIVE", "PAUSED"]);

export const partnerships = pgTable(
  "Partnership",
  {
    id: cuidId("id"),
    instanceId: text("instanceId").notNull().references(() => executionInstances.id),
    campaignId: text("campaignId").references(() => campaigns.id),   // denormalized for list queries
    creatorId: text("creatorId").notNull().references(() => creators.id),
    referralCode: text("referralCode").notNull(),
    trackingLink: text("trackingLink"),            // null when campaign has no targetUrl
    commissionRate: real("commissionRate"),        // percent (15 = 15%); null = fixed-fee-only deal
    agreedFeeCents: integer("agreedFeeCents"),     // I-1: cents; null = commission-only deal
    status: partnershipStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("Partnership_instanceId_key").on(table.instanceId),   // I-3: one partnership per run
    uniqueIndex("Partnership_referralCode_key").on(table.referralCode),
    index("Partnership_campaignId_idx").on(table.campaignId),
    index("Partnership_creatorId_idx").on(table.creatorId),
  ],
);
```

SQL (Neon):
```sql
CREATE TYPE "PartnershipStatus" AS ENUM ('ACTIVE', 'PAUSED');
CREATE TABLE "Partnership" (
  "id" text PRIMARY KEY,
  "instanceId" text NOT NULL REFERENCES "ExecutionInstance"("id"),
  "campaignId" text REFERENCES "Campaign"("id"),
  "creatorId" text NOT NULL REFERENCES "Creator"("id"),
  "referralCode" text NOT NULL,
  "trackingLink" text,
  "commissionRate" real,
  "agreedFeeCents" integer,
  "status" "PartnershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "Partnership_instanceId_key" ON "Partnership"("instanceId");
CREATE UNIQUE INDEX "Partnership_referralCode_key" ON "Partnership"("referralCode");
CREATE INDEX "Partnership_campaignId_idx" ON "Partnership"("campaignId");
CREATE INDEX "Partnership_creatorId_idx" ON "Partnership"("creatorId");
```
> Verify the actual FK target table names against `schema.ts` before running
> (`ExecutionInstance` / `Creator` are the pgTable names, e.g. `executionInstances`
> maps to `"ExecutionInstance"`). Adjust if the introspection references disagree.

### 1.3 New event type (I-7)

```sql
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'PARTNERSHIP_ACTIVATED';
```
Add `"PARTNERSHIP_ACTIVATED"` to `eventTypeEnum` in `schema.ts:141`.

## 2. DB helper module — `server/src/db/partnerships.ts` (re-export from `db/index.ts`)

```ts
createPartnership(data: { instanceId; campaignId?; creatorId; referralCode;
  trackingLink?; commissionRate?; agreedFeeCents? }): Promise<Partnership>
findPartnershipByInstance(instanceId): Promise<Partnership | null>
findPartnershipByReferralCode(code): Promise<Partnership | null>
listPartnerships(): Promise<PartnershipWithJoins[]>   // joins creator + campaign (Phase 4 uses)
```

**Referral code recipe** (parent's, `Pluvus/server/routes/api/join.ts:144-151`):
`slug = creator.name.toLowerCase().replace(/[^a-z0-9]/g,"").substring(0,12)` then
`code = `${slug}_${randomBytes(6).toString("hex")}``. Collision handling: 5 attempts,
retry on `isUniqueViolation` for the referralCode index, rethrow anything else —
byte-for-byte the parent's loop shape.

**Tracking link:** when `campaign.targetUrl` is set →
`new URL(targetUrl); url.searchParams.set(hiddenParamKey, code)` (parent:
`join.ts:355-358`). Null otherwise. (Phase 2's `/t/:code` redirect *also* resolves by
code; the emailed link stays the direct product URL — same model as the parent, where
attribution rides the param, not the hop.)

## 3. Minting logic — `resolvePartnership(ctx)` in a new `engine/executors/partnership.ts`

Called from **both** completion executors:

- `executeContentBriefSubmission` (`engine/executors/contentBrief.ts:218-256`) — merged flow.
- `executePaymentSubmission` (`engine/executors/paymentInfo.ts:136-174`) — legacy flow,
  only when it is terminal (`nextNodeId === null`).

Behavior (idempotent, mirrors `resolvePaymentToken`):

1. `findPartnershipByInstance` → exists? return it (BullMQ retry / re-submit safe).
2. Resolve money terms — **read, don't recompute**: the send phase already persisted
   `fixedFee` and `commission` in the `PAYMENT_INFO_SENT` event payload
   (`contentBrief.ts:186-190`). Read that event via `listEventsByInstance(instance.id,
   { type: "PAYMENT_INFO_SENT" })`; fall back to re-deriving with `resolveAgreedFee` +
   `firstNumber(config["commissionRate"], negotiationConfig["commissionRate"])` only if
   the event is missing (direct-created instances). `agreedFeeCents = Math.round(fixedFee * 100)`.
3. Mint code + link per §2, `createPartnership`, tolerate `23505` → re-read (I-3).
4. Append `PARTNERSHIP_ACTIVATED` event, payload `{ referralCode, trackingLink,
   commissionRate, agreedFeeCents }`.

Failure posture: partnership minting must **not** fail the payout submission. Wrap the
call in the executor with try/catch → log loudly; the reconciliation-safe recovery is
the welcome-email path re-running on the next harness/manual poke, and Phase 4's list
view will surface terminal instances without partnerships as a "needs backfill" row.
(Same "record first, notify best-effort" posture as `routes/payment.ts:298-327`.)

## 4. Welcome email

New pure template `engine/executors/partnershipWelcomeEmail.ts`:

- Subject: `You're all set — here's your tracking link` (link variant) /
  `You're all set — next steps for your collaboration` (no-link variant).
- Body: confirmation the payout info was received; the tracking link (when present) with
  one line on how attribution works ("share this exact link"); agreed terms recap
  (fee $X — rendered from cents — and/or commission Y%); brand sign-off using the same
  `resolveBrandName(config, ctx.campaign)` + `senderName` fallbacks as the other
  templates (`paymentInfo.ts:84-92`).
- Sent from the same completion executors after the state transition is prepared, via
  `sendOnce(email, instance.id, creator, draft, `partnership:welcome:${instance.id}`)` (I-6).
  Note: `executeContentBriefSubmission` currently ignores its `_email` param — rename to
  `email` and use it.

## 5. Thank-you page polish (optional, small)

`renderPaymentThankYouPage` (`routes/paymentPage.ts`) gains an optional
`trackingLink?: string` — the POST handler in `routes/payment.ts:329` looks up the
partnership after `handlePaymentSubmission` succeeds and passes the link so the creator
sees it immediately (with copy button), not only in email.

## 6. Builder UI (`web/`)

- `CampaignWizard.tsx` / campaign form: add **Product URL** (`targetUrl`, URL-validated,
  optional with helper text "leave empty for flat-fee collaborations without link
  tracking") and **Tracking parameter** (`hiddenParamKey`, default `_from`, advanced/
  collapsed). Thread through `web/src/api/types.ts` + campaigns route zod schema
  (`routes/campaigns.ts`).
- No other UI in this phase (Partners tab is Phase 4).

## 7. Tests & exit criteria

Unit (vitest, colocated):
- Code recipe: shape, collision-retry loop retries exactly on unique violation, rethrows others.
- `resolvePartnership`: idempotent on second call; reads terms from event payload; falls
  back to recompute when event absent; cents rounding (`149.995` → `15000`? no —
  `Math.round(149.995*100) = 15000` — assert the documented rule on 2-decimal inputs).
- Welcome template: link vs no-link variants; cents→dollars rendering; snapshot both.
- Tracking link: param appended correctly to URLs that already carry a query string.

Harness (`engine/partnership.harness.ts`, pattern of `contentBrief.harness.ts`): drive a
real instance through ACCEPTED → form submit against a local DB; assert Partnership row,
event, single welcome email after a forced duplicate submission.

**Exit criteria:**
- [ ] Completing the payment form on a fresh run produces exactly one Partnership with
      a unique code, frozen terms in cents, and one welcome email.
- [ ] Re-submitting the form / retrying the job creates nothing new (row count stable).
- [ ] Campaign without `targetUrl` → partnership with null link, no-link email variant.
- [ ] `tsc` clean, server suite green, DDL applied to Neon + `npm run db:pull` refreshed.
