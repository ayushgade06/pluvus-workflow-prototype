# Payment Setup — Creator Onboarding & Payout Flow

**Analysis date:** 2026-07-15
**Scope:** How the payment stage after creator acceptance/onboarding is designed **today**, across:

- **`Pluvus/`** — the parent application (`D:\internship\Pluvus`, sibling of this repo; Clerk + Drizzle + SendGrid + Replit stack). This is the **source of truth / reference implementation**.
- **`pluvus-workflow-proto/`** — this repo, whose workflow engine already implements a prototype payment stage that mirrors (and is planned to merge into) the parent.

This is a documentation-only analysis. Every claim below is backed by a `file:line` reference to the current code. Nothing here is a proposal.

---

## 1. High-Level Overview

There are **two payment-related creator touchpoints** in the parent Pluvus app, plus a third one in this proto:

| # | Touchpoint | Where | What the creator does |
|---|---|---|---|
| 1 | **Onboarding link** `/onboard/{token}` | Parent Pluvus | Confirms the negotiated deal and supplies **payout details (PayPal email only)**. This is the "payment setup" page. |
| 2 | **Payout confirmation link** `/payout/confirm` + `/payout/dispute` | Parent Pluvus | After the merchant later sends money, the creator clicks an emailed link to confirm receipt or dispute. |
| 3 | **Hosted payout form** `/payment/{token}` | This proto | The workflow's merged Content Brief node emails the brief PDF + a tokenized form where the creator picks PayPal / Wise / Bank Transfer (+ shipping address when the campaign ships a product). |

Key design facts of the parent (reference) implementation:

- **Payment collection = one field.** The only payment information the parent collects from a creator is a **PayPal email address**. `campaignInfluencers.paymentMethod` defaults to `"paypal"` and is explicitly commented *"PayPal only"* (`Pluvus/shared/schema.ts:627-628`); both the join and onboard POST endpoints reject any other method (`server/routes/api/join.ts:98-100`, `server/routes/api/partnerships.ts:445-447`).
- **No money moves through the platform.** There is no PayPal/Wise/Stripe **payout** API integration. The merchant pays manually (e.g. via the exported PayPal CSV, `server/routes/api/payouts.ts:257-303`) and records the result; the platform tracks the ledger and drives confirmation emails.
- **Money owed is tracked in two ledgers:** commission money via `conversions`/`commissions` → grouped into `payouts`, and fixed-fee/deal money via `paymentObligations` → converted into `payouts` when approved.
- **The onboarding link is not emailed by the parent.** It is returned to the merchant in API responses and surfaced in the dashboard; the merchant copy-pastes it to the creator (confirmed by `MERGE_READINESS.md:37,134`: *"merchant copy-pastes onboarding link"* → to be *"auto-sent"* after the merge).

---

## 2. End-to-End Sequence (Negotiation → Payment Complete)

### 2.1 Parent Pluvus (reference flow)

```
Merchant negotiates off-platform (mailto:, Google Sheet)          [manual today]
        │
        ▼
POST /api/partnerships/finalize  (or /create-deal)                 merchant-authed (Clerk)
  • creates a dedicated campaign (finalize path only)              partnerships.ts:267-295
  • creates negotiatedDeals row, status "finalized",
    with onboardingLinkToken = nameSlug + "-" + 6 random bytes hex partnerships.ts:300-319
  • auto-creates paymentObligations from fixed_payment +
    payment_terms (full_upfront / half_upfront / pay_after_post)   partnerships.ts:322-351
  • responds { onboarding_url: "{APP_URL}/onboard/{token}", deal } partnerships.ts:367-370
        │
        ▼
Merchant delivers the link to the creator (copy-paste today)
        │
        ▼
Creator opens /onboard/{token}  (public page, OnboardCreator.tsx)
  GET /api/onboard/:token → deal + campaign + branding             partnerships.ts:381-431
  Creator fills: name, PayPal email (+confirm), agrees to terms
  POST /api/onboard/:token {email, name, paymentMethod, paymentInfo}
        │
        ├─ campaign.requiresApproval → influencer status "pending",
        │    merchant emailed "Action Required", creator emailed
        │    "Application received"                                 partnerships.ts:490-534
        │    Merchant later POSTs /api/affiliates/:id/approve →
        │    status "active", deal backfilled, welcome email        affiliates.ts:403-655
        │
        ├─ campaign.requiresContract && ENABLE_CONTRACTS → Firma
        │    e-signature step (CURRENTLY DISABLED, see §10)         partnerships.ts:538-597
        │
        └─ otherwise instant activation:
             • campaignInfluencers row created, status "active",
               paymentMethod/paymentInfo stored                     partnerships.ts:706-718
             • negotiatedDeals.status → "activated",
               creatorId backfilled                                 partnerships.ts:734-737
             • paymentObligations.creatorId backfilled              partnerships.ts:740
             • welcome email to creator + notification to merchant  partnerships.ts:754-788
        │
        ▼
Payment setup is now COMPLETE (the platform has the PayPal email).
        │
        ▼  … later, when money is owed …
Merchant approves obligation  POST /api/obligations/:id/approve    obligations.ts:316-356
Merchant creates payout       POST /api/payouts/create-obligation/:obligationId
  • copies creator.paymentMethod/paymentInfo into the payout row   payouts.ts:188-213
  • obligation → status "paid"                                     payouts.ts:216-220
Merchant pays out-of-band (PayPal), then
POST /api/payouts/:id/send
  • payout status "pending" → "sent", 32-byte confirm token minted
    (SHA-256 hash stored), 7-day expiry                             payouts.ts:588-614
  • creator emailed "{merchant} sent you {amount}!" with
    /payout/confirm and /payout/dispute links                       payouts.ts:616-626
Creator clicks confirm → status "settled"                          payouts.ts:686-740
Creator clicks dispute → status "disputed" + admin email           payouts.ts:743-819
(sent payouts auto-settle after 7 days of silence)                 payouts.ts:352-373
```

### 2.2 This proto (workflow engine)

Current **merged** graph (what a newly published workflow runs):

```
NEGOTIATION reaches ACCEPTED
        │  auto-advance (ACCEPTED is not terminal)                 engine/stateMachine.ts:32-38
        ▼
CONTENT_BRIEF node — SEND phase (executeContentBrief)              engine/executors/contentBrief.ts:47-205
  • resolves the genuinely agreed fee from NEGOTIATION_TURN events
    (escalates to MANUAL_REVIEW if none — never invents a fee)     contentBrief.ts:116-131
  • mints/reuses the payout token (UUID) + PaymentInfo row         paymentInfo.ts:39-56 (resolvePaymentToken)
  • loads the campaign-brief PDF from local storage, attaches it   contentBrief.ts:83-89
  • sends ONE "Your Campaign Brief" email: finalized terms +
    payout-form link + PDF (idempotent, output-guard scanned)      contentBrief.ts:142-177
  • ACCEPTED → PAYMENT_PENDING, waits                              contentBrief.ts:181-192
        │
        ▼
Creator opens GET /payment/{token}  (hosted server-rendered form)  routes/payment.ts:115-152
Creator submits POST /payment/{token}
  • validation, then runtime.handlePaymentSubmission persists the
    payout fields and steps the node                               routes/payment.ts:158-296
  • PAYMENT_PENDING → CONTENT_BRIEF_SENT  (success terminal)       contentBrief.ts:218-256
```

Legacy graphs (published before the merge) still run the three-node chain
`Reward Setup (ACCEPTED→REWARD_PENDING→REWARD_CONFIRMED)` → `Payment Info (→PAYMENT_PENDING→PAYMENT_RECEIVED)` → `Content Brief (→CONTENT_BRIEF_SENT)`; the payment route auto-enqueues the Content Brief step after a legacy submission (`routes/payment.ts:298-327`, `engine/executors/paymentInfo.ts`).

---

## 3. The Creator Payment Link

### 3.1 Parent Pluvus — onboarding link

| Aspect | Implementation |
|---|---|
| **URL** | `{APP_URL}/onboard/{onboardingLinkToken}` (`partnerships.ts:153,368`; APP_URL falls back to `REPLIT_DEV_DOMAIN`, then `https://pluvus.com`) |
| **Token generation** | `` `${nameSlug}-${randomBytes(6).toString("hex")}` `` — first 12 chars of the lowercased creator name + 6 random bytes (12 hex chars). Generated in `partnerships.ts:80-82` (create-deal), `partnerships.ts:300-305` (finalize), `affiliates.ts:448-465` (approve-with-negotiated-terms), and `join.ts:392` (`auto-` prefixed, for self-signup KOL/hybrid deals). |
| **Storage** | `negotiatedDeals.onboardingLinkToken`, `text NOT NULL UNIQUE` (`shared/schema.ts:935`). |
| **Expiry** | **None.** There is no expiry column or check — see §12. |
| **Single-use** | Effectively yes: both GET and POST reject unless `deal.status === "finalized"`; an `"activated"` deal returns *"This onboarding link has already been used"* (`partnerships.ts:392-394,474-476`). |
| **Who receives it** | The **merchant** (API response `onboarding_url`), also surfaced in the dashboard: Campaign Detail builds `${origin}/onboard/${token}` for deal campaigns (`client/src/pages/CampaignDetail.tsx:103-104`) and the sheets prospect enrichment attaches `onboardingUrl` for finalized deals (`server/routes/api/sheets.ts:86-88`). **No Pluvus email template sends this link to the creator** (verified against all `send*` functions in `server/services/email.ts:98-1769`). |
| **Frontend route** | `/onboard/:token` → `OnboardCreator.tsx`, registered as a **public** route (`client/src/App.tsx:333,384`). |
| **Backend** | Public `GET /api/onboard/:token` and `POST /api/onboard/:token` (no auth middleware; the token *is* the credential) in `partnerships.ts:381-820`. |

### 3.2 This proto — payout-form link

| Aspect | Implementation |
|---|---|
| **URL** | `{PAYMENT_PUBLIC_URL or http://localhost:{port}}/payment/{token}` (`engine/executors/paymentEmail.ts:37-39`). |
| **Token** | `randomUUID()` (`db/paymentInfo.ts:27-29`), unique per instance (`PaymentInfo_token_key`, `db/schema.ts:431`). Minted idempotently — retries reuse the existing row (`executors/paymentInfo.ts:39-56`). |
| **Expiry** | 30 days by default, tunable via `PAYMENT_TOKEN_TTL_DAYS`, stamped on the row at mint (`db/paymentInfo.ts:31-41,63`). Expiry only blocks **unsubmitted** tokens; the "already submitted" notice stays reachable (`routes/payment.ts:60-76`). |
| **Delivery** | **Emailed automatically** to the creator inside the "Your Campaign Brief" email (merged flow) or the "Payment Information Required" email (legacy Payment Info node). |

---

## 4. Fields Collected from Creators

### 4.1 Parent Pluvus — `/onboard/:token` page (`OnboardCreator.tsx:941-1073`)

| Field | Input | Required | Notes |
|---|---|---|---|
| Email address | read-only | — | Pre-filled from `deal.creatorEmail`; *"set by the merchant and cannot be changed"* (`OnboardCreator.tsx:976-985`). Server ignores UI anyway and validates the posted email. |
| Name | text | yes | "Your name or handle". |
| PayPal Email | email | yes | The **only** payout method. Server normalizes via `sanitizedEmail` zod schema (`partnerships.ts:460-465`). |
| Confirm PayPal Email | email | yes | Client-side match check only (`OnboardCreator.tsx:963-970,1026-1037`); the confirm value is never posted. |
| Terms consent | implicit | — | "By joining, you agree to the affiliate terms and conditions" text + `/terms` link (`OnboardCreator.tsx:1060-1071`). **No checkbox** — consent is implied by submitting. |

**Not collected anywhere in the parent:** Wise, bank transfer, tax information (W-9/W-8), postal address, identity verification, phone. The separate `agreementAcceptances` table (`shared/schema.ts:364-374`) records **merchant** ToS acceptance, not creator consent. The public self-signup page `/join/:slug` (`JoinCampaign.tsx`) collects the same set (name, email, PayPal email) with the same PayPal-only rule; a headless external form may omit payment info entirely (`join.ts:96-104`).

### 4.2 This proto — `/payment/:token` hosted form (`routes/paymentPage.ts`, `routes/payment.ts:192-260`)

| Field | Input name | Required | Notes |
|---|---|---|---|
| Payout method | `method` | yes | `PAYPAL` \| `WISE` \| `BANK_TRANSFER` (`paymentPage.ts:15-17`, enum `db/schema.ts:186-190`). |
| Account identifier | `accountIdentifier` | yes | PayPal/Wise email or bank account reference (free text). |
| Country | `country` | no | |
| Notes | `notes` | no | |
| Shipping address | `shipName`, `shipLine1`, `shipLine2`, `shipCity`, `shipRegion`, `shipPostalCode`, `shipCountry` | name/line1/city/postalCode/country required | Rendered **only** when the campaign's `shipsPhysicalProduct` node-config flag is true, read from the immutable published version's nodeGraph (`routes/payment.ts:93-109`); submitted address fields are ignored when the flag is off (anti-spoof, `payment.ts:201-213`). Stored under `PaymentInfo.extra.shipping` (`payment.ts:276-279`). |

---

## 5. Database Models

### 5.1 Parent Pluvus (`Pluvus/shared/schema.ts`, Drizzle/Postgres)

- **`negotiatedDeals`** (`:915-940`) — per-creator deal that owns the onboarding link. Columns: `id`, `tenantId`, `campaignId`, `creatorId` (nullable; backfilled to `campaignInfluencers.id` after onboarding), `creatorName`, `creatorEmail`, `rewardType` (`percentage|tiered|one_time`), `rewardValue` (jsonb), `fixedPayment` (nullable real — hybrid deals), `rewardStructureName`, `deliverables` (jsonb), `status` **`pending | finalized | activated`**, `onboardingLinkToken` (unique), timestamps. Unique `(campaignId, creatorEmail)`.
- **`campaignInfluencers`** (`:620-637`) — the creator↔campaign record that **stores the payout details**: `paymentMethod` (default `"paypal"`, comment "PayPal only"), `paymentInfo` ("PayPal email (required for payouts)"), plus `referralCode` (unique), `trackingLink`, `negotiatedDealId`, `status` **`active | paused | rejected | expired | pending | contract_pending`**. Unique `(campaignId, influencerEmail)`.
- **`paymentObligations`** (`:970-989`) — non-commission money owed: `type` **`fixed_fee | deliverable_payment | milestone | bonus`**, `description`, `amount`, `currency` (default USD), `status` **`pending | approved | paid | cancelled`**, `dueType` **`immediate | on_deliverable_approval | on_date`** (+`dueDate`), `payoutId`, `approvedAt/approvedBy/paidAt`, FKs to tenant/campaign/creator/deal.
- **`payouts`** (`:527-551`) — the money-sent ledger: `affiliateId` (→ `campaignInfluencers.id`), `amount`, `period`, `currency`, `status` **`pending | sent | confirmed | disputed | settled`** (a deprecated `/complete` route also writes `"completed"`, `payouts.ts:522-550`), `payoutMethod`, `payoutDestination` (copied from the creator record at payout-creation time), `reference` (external TXN id), `note`, `conversionCount`, `sentAt/confirmedAt/disputedAt/settledAt/paidAt`, `confirmTokenHash` + `confirmTokenExpiresAt` + `confirmIpAddress/confirmUserAgent` (audit), `payoutType` **`commission | fixed_fee | mixed`**.
- **`affiliateContracts`** (`:943-967`) — Firma e-signature tracking: `firmaSigningRequestId` (unique), `status` **`pending | signed | declined | expired`**, `signedAt/ipAddress/userAgent`, **`pendingOnboardingData`** jsonb `{name, email, paymentMethod, paymentInfo, flowType: "join"|"onboard", flowIdentifier}` (payout details are parked here until the signature webhook lands), `campaignInfluencerId`, `negotiatedDealId`, `accessToken` (uuid, guards the contract endpoints).
- **`conversions`** (`:640-664`) / **`commissions`** (`:667-676`) — commission-side money source; `conversions.payoutId` locks a conversion into a payout.
- **Disambiguation:** the **`payments`** table (`:377-386`) is the **brand's own Stripe subscription** to Pluvus — unrelated to creator payouts.

### 5.2 This proto (`server/src/db/schema.ts`)

- **`PaymentInfo`** (`:410-434`) — one row per instance: `id`, `instanceId` (unique, FK → `ExecutionInstance`), `token` (unique), `status` **`PAYMENT_PENDING | PAYMENT_RECEIVED`**, `method` (**`PAYPAL | WISE | BANK_TRANSFER`** enum), `accountIdentifier`, `country`, `notes`, `extra` jsonb (carries `shipping`), `expiresAt`, `createdAt/submittedAt/updatedAt`.

---

## 6. Backend APIs

### Parent Pluvus

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/partnerships/finalize` | Clerk (merchant) | Close a negotiated deal: creates dedicated campaign + deal + obligations, returns `onboarding_url` (`partnerships.ts:168-378`). |
| `POST /api/partnerships/create-deal` | Clerk | Same, against an existing campaign (`partnerships.ts:53-165`). |
| `GET /api/partnerships/deals` | Clerk | Lists deals incl. `onboardingLinkToken` (`partnerships.ts:16-50`). |
| `GET /api/onboard/:token` | **public** (token) | Deal + campaign + merchant branding for the onboarding page (`partnerships.ts:381-431`). |
| `POST /api/onboard/:token` | **public** (token) | Completes onboarding: validates PayPal-only payment info, creates the influencer, activates the deal, backfills obligations, sends emails (`partnerships.ts:434-820`). |
| `GET/POST /api/join/:slug` | **public** (slug) | Self-signup equivalent (CORS-open for tenant-hosted forms) (`join.ts:13-538`). |
| `POST /api/affiliates/:id/approve` / `:id/reject` | Clerk | Approval-gated activation; approve may create a deal from `negotiated_terms` (`affiliates.ts:403-660,663+`). |
| `GET /api/obligations`, `POST /api/obligations/:id/approve` / `:id/cancel` | Clerk | Obligation lifecycle (`obligations.ts`). |
| `GET /api/payouts`, `/pending`, `/summaries`, `/affiliate/:affiliateId`, `/:id` | Clerk | Payout listings; `/summaries` includes each creator's `payoutMethod`/`paymentInfo` and pending/available/paid buckets (`payouts.ts`). |
| `POST /api/payouts/create/:affiliateId`, `/create-obligation/:obligationId` | Clerk | Mint payout rows (commission grouping / approved obligation) (`payouts.ts:142-229`). |
| `POST /api/payouts/:id/send`, `/:id/settle`, `/:id/confirm` | Clerk | Send-confirmation-email / settle / mark-paid (`payouts.ts:232-683`). |
| `GET /api/payouts/paypal-csv` | Clerk | PayPal bulk-payment CSV of payable creators (`payouts.ts:257-303`). |
| `GET /payout/confirm`, `GET /payout/dispute` | **public** (hashed token, 7-day expiry) | Creator confirms/disputes receipt (`payouts.ts:686-819`). |
| `GET /api/contracts/:contractId/{signing-url,status,result,info}` | **public** (`?token=accessToken`) | Firma signing support (`contracts.ts:11-140`). |
| `POST /webhooks/firma` | HMAC signature | Completes deferred onboarding after signature (`webhooks/firma.ts`). |

### This proto

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /payment/:token` | **public** (token) | Renders the hosted payout form / already-submitted notice / 404 / 410-expired (`routes/payment.ts:115-152`). |
| `POST /payment/:token` | **public** (token) | Validates + persists payout fields, steps the workflow (`routes/payment.ts:158-334`). |

---

## 7. Frontend Pages / Components

**Parent Pluvus (creator-facing, public routes in `client/src/App.tsx:332-335,383-385`):**
- `/onboard/:token` → `pages/OnboardCreator.tsx` — branded (tenant logo/colors/gradient) single-page form; shows negotiated terms (commission + fixed fee badges), "How It Works", product-access teaser; success screen shows the tracking link (affiliate) or "Collaboration Confirmed" (KOL); pending-approval screen when `requiresApproval`.
- `/join/:slug` → `pages/JoinCampaign.tsx` — self-signup twin of the above.
- `/sign/:contractId` → `SignContract` — Firma signing fallback page (link emailed by `sendContractSigningEmail`); OnboardCreator also embeds the Firma iframe inline (`OnboardCreator.tsx:347-455`, currently gated off).
- `/payout-result` → `PayoutResult` — landing page after confirm/dispute redirects.

**Parent Pluvus (merchant-facing):** `/payouts` → `pages/Payouts.tsx` (route `App.tsx:409`) — summaries incl. each creator's PayPal email, payout statuses, PayPal CSV export; obligations UI fed by `/api/obligations`; `pages/CampaignDetail.tsx:103-104` shows the copyable onboarding URL; `pages/Affiliates.tsx` lists creators (payment info also lands in merchant notification emails). The `PostPaymentOnboarding*` components and `/onboarding` wizard are the **brand's** subscription onboarding — unrelated to creator payments.

**This proto:** the payout form is **server-rendered HTML** (`routes/paymentPage.ts`), not React. The builder UI (`web/`) exposes the `shipsPhysicalProduct` toggle and brief-PDF upload in node config, and the Monitor tab shows instances parked in `PAYMENT_PENDING` (`web/src/components/builder/MonitorTab.tsx:24-35`).

---

## 8. Workflow Integration

- **State machine** (`server/src/engine/stateMachine.ts:32-80`): `ACCEPTED → [PAYMENT_PENDING | REWARD_PENDING | MANUAL_REVIEW]`; `PAYMENT_PENDING → [PAYMENT_PENDING, PAYMENT_RECEIVED, CONTENT_BRIEF_SENT, OPTED_OUT, MANUAL_REVIEW]`; `PAYMENT_RECEIVED → [CONTENT_BRIEF_SENT, MANUAL_REVIEW]`; **`CONTENT_BRIEF_SENT` is the success terminal**.
- **Merged Content Brief node** owns the whole payment stage (see §2.2). Guards: no-agreed-fee → `MANUAL_REVIEW` (`contentBrief.ts:123-131`); missing brand name → `MANUAL_REVIEW` (`:95-98`); outbound draft scanned for leaked floor/ceiling numbers (`:161-166`); idempotent send + token mint.
- **Emails during PAYMENT_PENDING** don't advance state: an unambiguous opt-out → `OPTED_OUT`; anything else (typically re-opening price) gets a deterministic "the rate is finalized, here's your payout link again" auto-reply and stays waiting (`executors/paymentReply.ts`). Only the **form submission** moves the instance forward.
- **Completion detection:** `POST /payment/:token` → `runtime.handlePaymentSubmission` persists the row as `PAYMENT_RECEIVED`, then steps the node under optimistic concurrency; "truly finalized" requires **both** row `PAYMENT_RECEIVED` **and** instance past `PAYMENT_PENDING` (`routes/payment.ts:36-58`), which makes a stuck instance self-recoverable by re-submitting.
- **Reconciliation:** `PAYMENT_PENDING` is a deliberate waiting state the sweep does **not** re-enqueue (`routes/payment.ts:50`).
- **Parent-merge mapping** (`MERGE_READINESS.md:43,133-135`): on ACCEPT the engine is to call the parent's `create-deal`/`finalize` logic (deal + obligations + token created programmatically), the agreement-confirmation step **auto-sends** the `/onboard/{token}` link the merchant copy-pastes today, and the parent's onboarding flow (approval / Firma / PayPal / tracking link) is kept **unchanged**.

---

## 9. Email Integration

**Parent Pluvus (`server/services/email.ts`, SendGrid/Resend via `dispatchEmail`):**

| Trigger | Function | To | Subject |
|---|---|---|---|
| Onboarding complete (instant/approved/signed) | `sendAffiliateWelcomeEmail` (`:361`) | creator | `Welcome to {campaign} - Here's Your Tracking Link` / `…- Collaboration Confirmed` (KOL) (`:590-592`) |
| New affiliate | `sendNewAffiliateNotificationEmail` (`:687`) | merchant | `New Affiliate: {name} joined {campaign}` — **includes the creator's PayPal email** |
| Application needs approval | `sendApprovalRequiredEmail` (`:781`) | merchant | `Action Required: {name} applied to {campaign}` — includes PayPal email |
| Application received / rejected | `sendApplicationReceivedEmail` / `sendApplicationRejectedEmail` (`:1039/:1107`) | creator | `Application received — {campaign}` / `Update on your application — {campaign}` |
| Contract to sign (Firma, disabled) | `sendContractSigningEmail` (`:958`) | creator | `You're approved! Sign your agreement for {campaign}` — carries `/sign/{contractId}?token={accessToken}` |
| Payout sent | `sendPayoutConfirmationEmail` (`:149`) | creator | `{merchant} sent you {amount}!` — carries `/payout/confirm` + `/payout/dispute` token links |
| Payout disputed | `sendDisputeNotificationEmail` (`:252`) | Pluvus admin + merchant | `[DISPUTE] {creator} did not receive {amount} from {merchant}` |

There is **no** parent email carrying the `/onboard/{token}` link (§3.1).

**This proto:** merged flow sends one `Your Campaign Brief` email (terms + payout link + PDF attachment, `contentBriefEmail.ts:102`); legacy Payment Info node sends `Payment Information Required` (`paymentEmail.ts:66`); shipping expectation is mentioned when `shipsPhysicalProduct` (`executors/paymentInfo.ts:93-102`).

---

## 10. Authentication & Security of the Payment Link

**Parent Pluvus:**
- The onboarding link is a **bearer capability**: possession of the token is the only credential; endpoints are public. Entropy is 6 random bytes (48 bits) plus a guessable name slug.
- **Replay protection** via deal status: only `finalized` deals accept GET/POST; used links say so. **No expiry.**
- Server-side validation regardless of UI: email + PayPal email through `sanitizedEmail` zod parsing; PayPal-only enforcement; duplicate-join rejection via the `(campaignId, influencerEmail)` unique constraint.
- **Payout confirmation links** are stronger: 32 random bytes, only the **SHA-256 hash** stored (`confirmTokenHash`), 7-day expiry, single-state (`sent` only), and IP/user-agent audit capture (`payouts.ts:588-614,686-819`).
- **Firma webhook** verified by HMAC (`X-Firma-Signature`) + idempotency via `webhookEvents` unique key; contract endpoints require the per-contract `accessToken`. **Note: the whole contract path is currently off** — `ENABLE_CONTRACTS = false` (`server/config/features.ts:11`), mirrored in the client (`OnboardCreator.tsx:16`), so `requiresContract` campaigns fall through to approval-only/instant activation.
- Tenant isolation on every merchant route via `getAuthWithTenant` (Clerk).

**This proto:** token is a full `randomUUID()` (122 bits), 30-day TTL on unsubmitted tokens, idempotent re-submits, optimistic-concurrency stepping, and an anti-spoof gate that drops shipping fields unless the published version says the campaign ships product. Comments state the scope plainly: *"no auth, no payment integration, no verification"* (`routes/payment.ts:25-26`).

---

## 11. Important Implementation Observations

1. **"Payment setup" in the parent is onboarding.** There is no separate payment page: the PayPal email is captured **on the onboarding page itself**, and everything downstream (obligations → payouts) reads it from `campaignInfluencers.paymentInfo`, copied into `payouts.payoutDestination` at payout-creation time (`payouts.ts:208-209`) — so later edits to the creator record don't rewrite historical payouts.
2. **Link delivery is the manual gap.** The parent generates but never emails the onboarding link; `MERGE_READINESS.md` marks auto-sending it as this workflow's job (row 8 of the mapping table).
3. **The proto deliberately collects more than the parent** (Wise/bank transfer, country, notes, shipping address). The parent's ingestion path is PayPal-only, so only `PAYPAL` + `accountIdentifier` map 1:1 onto `campaignInfluencers.paymentMethod/paymentInfo`; the extra proto fields have **no landing column** in the parent schema today.
4. **Fixed-fee money is created at deal time, not onboarding time.** `paymentObligations` rows are minted when the deal is finalized (per `payment_terms`: full_upfront → one `immediate`; half_upfront → `immediate` + `on_deliverable_approval` halves; pay_after_post → one `on_deliverable_approval`), with `creatorId` null until onboarding backfills it; `create-obligation` payouts are blocked until then (`payouts.ts:183-185`).
5. **Two flows share one implementation.** `/join/{slug}` (self-signup) and `/onboard/{token}` (negotiated) run near-identical logic and gating (`requiresApproval` → `pending`; `requiresContract` → Firma when enabled; else instant activation). The Firma failure path activates directly rather than blocking the creator.
6. **`payouts.affiliateId` references `campaignInfluencers.id`**, not the legacy `affiliates` table (`schema.ts:530`); the older `affiliates`/`performance` tables are a legacy prospect-portal path (`affiliates.ts:380-395`).
7. **Auto-settle:** payouts marked `sent` settle automatically after 7 silent days, computed lazily inside `GET /api/payouts` (`payouts.ts:352-373`) — not a cron.
8. **Demo-account fixtures** are hardcoded inside the payout/obligation routes for `founder@pluvus.com` (`payouts.ts:36-131,379-505`; `obligations.ts:17-261`) — useful as intended data-shape documentation.
9. **In the proto's merged flow the brief PDF is sent *before* payout info is collected** (one email up-front), whereas the phased legacy chain collected payout info first and sent the brief last. The task description ("brief + follow-up link") matches the merged flow.
10. **Consent is implicit** on both parent creator pages — a terms link under the submit button, no checkbox, no acceptance record for creators (unlike merchants' `agreementAcceptances`).

---

## 12. Open Questions / Unclear Areas

1. **Onboarding-token lifetime.** `negotiatedDeals.onboardingLinkToken` never expires and is only ~48 bits of entropy plus a guessable name slug. Deliberate (links may sit in inboxes for weeks) or an oversight? The proto's payment token (UUID + 30-day TTL) sets a stricter precedent.
2. **Who emails the onboarding link after the merge?** `MERGE_READINESS.md:134` says the agreement-confirmation step auto-sends it, but no parent template exists yet; the proto's equivalent email today carries the *proto's* `/payment/{token}` link, not the parent's `/onboard/{token}`.
3. **Field mismatch on merge.** Where do the proto's `WISE`/`BANK_TRANSFER`, `country`, `notes`, and `extra.shipping` land, given the parent is PayPal-only with a single `paymentInfo` text column? Extend the parent schema, or restrict the merged form to PayPal?
4. **Double collection risk.** Merged flow: the proto form collects payout info, then the parent's `/onboard/{token}` page collects a PayPal email again. Which one is authoritative post-merge? (`MERGE_READINESS.md:135` keeps the parent flow "unchanged", implying the creator could be asked twice.)
5. **`payouts.status` drift.** The deprecated `/api/payouts/:id/complete` writes `"completed"`, which is not in the documented `pending|sent|confirmed|disputed|settled` set (`payouts.ts:536-539` vs `schema.ts:534`).
6. **`half_upfront` rounding inconsistency:** `partnerships.ts:109/332` compute `Math.round(amount * 0.5 * 100) / 100` while `join.ts:419` and `affiliates.ts:480` compute `Math.round(amount * 50) / 100` — the same value, but duplicated logic in four places.
7. **`finalize` bug:** `partnerships.ts:242` references `reward_type` (snake_case) inside the campaign-type derivation, but the destructured variable is `rewardType` — as written, `hasCommission` would throw a `ReferenceError` at runtime when that line executes. Deal-type derivation for hybrid/KOL via `/finalize` deserves a runtime check.
8. **Firma re-enable checklist** exists (`config/features.ts:1-10`) but the contract flow is untested-in-production as of this analysis; `requiresContract` on deal campaigns (`partnerships.ts:288`) currently has no effect.
9. **Payout execution is fully manual.** No PayPal Payouts/Wise API integration exists in either codebase; the PayPal CSV export is the closest automation. Any "payment stage" the workflow drives ends at *collecting* payout details and *tracking* the ledger, not at moving money.
