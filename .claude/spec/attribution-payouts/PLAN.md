# Attribution & Payouts — Master Plan

**Spec date:** 2026-07-15
**Status:** Phase 1 BUILT · Phase 2 BUILT · Phase 3 BUILT
**Phase files:** `phase-1-partnership.md` · `phase-2-attribution.md` · `phase-3-payouts.md` · `phase-4-dashboard.md`

---

## 1. Goal

Today the workflow ends at `CONTENT_BRIEF_SENT`: the creator has agreed a fee, submitted
payout details (PayPal — the only method we use for now), and received the campaign brief.
Then nothing. This spec adds everything that happens **after** the workflow terminates:

1. **Referral link** — every completed creator gets a unique tracked link.
2. **Attribution** — clicks and conversions ("how many users came from this creator")
   are recorded and rolled up per creator.
3. **Payout ledger** — money owed (fixed fee + commission) is tracked; the **brand marks
   a payout as paid**, the **creator confirms (or disputes) receipt** via emailed magic
   links; disputes notify the brand.
4. **Brand dashboard** — a Partners view showing links, attribution counts, earnings,
   and payout actions.

The parent Pluvus app (`D:\internship\Pluvus`) already implements all four in production
form; this spec ports its **proven shapes** (tables, status machines, token patterns)
into this repo's conventions. Where the parent made a weak choice (float money columns,
GET links that mutate state, no token expiry) this spec deliberately upgrades — each
deviation is called out inline in the phase files.

## 2. Non-goals (explicitly out of scope)

| Cut | Why |
|---|---|
| Authentication / multi-tenancy on brand endpoints | Internal testing on our own product only; matches every existing brand route (`/campaigns`, `/workflows`, `/manual-queue` are unauthenticated too). Magic-link tokens still protect all **creator**-facing mutations. |
| PayPal Payouts API (automated money movement) | Parent doesn't have it either. Brand pays manually in PayPal, then records it. Phase 4 ships the parent's PayPal bulk-CSV export as the halfway automation. |
| Multi-currency | USD only. `currency` columns exist (default `USD`) so this is a data migration away, not a redesign. |
| Clearing/refund windows (parent's `clearingDays`) | "Available" = earned, not refunded, not already locked into a payout. Refunds can be flagged (Phase 2) but no automatic clawback from created payouts. |
| Recurring-customer attribution (parent's `customerAffiliateMappings`) | First-touch per `externalId` is enough for the pilot. |
| Retroactive attribution of conversions with unknown codes | Rows are kept (nullable `partnershipId`) for audit, but no backfill job. |

## 3. The architectural decision (read this before building)

**The workflow state machine does not grow.** `CONTENT_BRIEF_SENT` stays the success
terminal (`server/src/engine/stateMachine.ts:64,80`). Attribution and payouts are a
**post-terminal ledger** keyed off the completed `ExecutionInstance` — plain CRUD with
their own status columns, exactly how the parent models it (its `payouts`/`conversions`/
`paymentObligations` live outside any workflow).

Rationale: the partnership lives for months after the 2-week conversation ends; ledger
statuses (payout `SENT`, conversion `refunded`) are orthogonal to conversation states;
and the OCC/reconciliation machinery (HARD-R1) must not have to reason about states
that money hangs off.

The bridge object is a new **`Partnership`** row, minted at the moment the payout form
is submitted (the workflow's completion step). Everything in Phases 2–4 hangs off it.

```
ExecutionInstance ──1:1── Partnership ──1:N── Click
   (terminal)                 │  ──────1:N── Conversion ──N:1── Payout (payoutId lock)
                              │  ──────1:N── Obligation ──1:1── Payout
                              └─ referralCode / trackingLink / commissionRate / agreedFeeCents
```

## 4. Cross-phase invariants (every phase must preserve these)

- **I-1 Money is integer cents** in every new column (`*Cents integer`). Deliberate
  upgrade from the parent's `real` columns. Dollars↔cents conversion happens only at
  boundaries (webhook ingest, email/UI rendering, `agreedFee` from negotiation events).
  Rounding rule everywhere: `Math.round`.
- **I-2 Copy-at-creation.** Values that feed money math are **copied** onto the row when
  it is created, never re-derived later: `commissionRate`/`agreedFeeCents` onto
  Partnership at mint; `commissionCents` onto Conversion at ingest; `method`/`destination`
  onto Payout at creation (parent precedent: `Pluvus/server/routes/api/payouts.ts:208-209`).
  Editing a config later must never rewrite historical money.
- **I-3 Idempotency by unique constraint**, not by best-effort checks: `Partnership.instanceId`
  unique, `Partnership.referralCode` unique, `Conversion.externalId` unique. Handle
  `23505` via the existing `isUniqueViolation` (`server/src/db/errors.ts`) → re-read/no-op,
  the same pattern as `resolvePaymentToken` (`engine/executors/paymentInfo.ts:39-56`).
- **I-4 Never pay twice.** A conversion is locked into exactly one payout by setting
  `payoutId` inside the same DB transaction that creates the payout (`SELECT … FOR UPDATE`).
  An obligation is payable exactly once (status guard `PENDING → PAID` in the same
  transaction). No money row is ever deleted; cancellations are status flips.
- **I-5 Emailed links never mutate on GET.** Confirm/dispute links render an interstitial
  page whose button performs a `POST`. This repo already learned this lesson once — the
  brand-decision links were hardened to confirm-POST because mail-scanner prefetch fires
  GETs (batch-4 hardening). The parent's `/payout/confirm` GET-mutation is the anti-pattern;
  do not port it.
- **I-6 Emails are idempotent** via the existing `sendOnce(email, instanceId, creator,
  draft, key)` (`engine/executors/idempotentSend.ts`), with a documented key per template
  (`partnership:welcome:{instanceId}`, `payout:sent:{payoutId}`, `payout:disputed:{payoutId}`).
- **I-7 Every ledger action writes an instance event** (the `events` table) so the
  observability inspector timeline stays the single audit trail. ⚠ `eventType` is a
  **pgEnum** (`schema.ts:141`) — each phase's DDL includes its `ALTER TYPE "EventType"
  ADD VALUE` statements.
- **I-8 Attribution failures never break the product path.** The `/t/:code` redirect must
  302 even if the click insert fails; the conversion webhook must 200-ack duplicates;
  nothing in this system can block a customer's page load or the product's checkout.

## 5. Repo conventions to follow (established, do not re-decide)

| Concern | Convention | Reference |
|---|---|---|
| Schema | Hand-authored Drizzle in `server/src/db/schema.ts`, PascalCase table names, `cuidId()` / `tsNow()` / `tsUpdatedAt()` helpers, pgEnums | `schema.ts:410-434` (PaymentInfo) |
| Migrations | Apply DDL to Neon directly (SQL in each phase file), then `npm run db:pull` to refresh the introspection references | repo history (all prior phases) |
| DB access | One helper module per table under `server/src/db/`, re-exported from `db/index.ts` | `db/paymentInfo.ts` |
| Routes | One router file under `server/src/routes/`, mounted in `server/src/app.ts` | `app.ts:53-66` |
| Public pages | Server-rendered HTML template modules (no React) | `routes/paymentPage.ts` |
| Emails | Pure deterministic template builders (`render*Email`) + `sendOnce` | `engine/executors/paymentEmail.ts` |
| Public base URL | `paymentBaseUrl()` reads `PAYMENT_BASE_URL`, falls back to `http://localhost:{PORT}` — **reuse it** for tracking + payout links (one tunnel serves all) | `paymentEmail.ts:29-34` |
| Background jobs | Scheduler with Redis leader lease (W-8) — never lazy-compute in GET handlers | `scheduler/scheduler.ts` |
| Tests | Colocated vitest `*.test.ts` + a `*.harness.ts` per feature + live runbook in `readme_docs/testing/` | `routes/paymentPage.test.ts`, `engine/contentBrief.harness.ts` |
| Secrets | Optional in local dev with a logged warning; document in `.env.example` | `AGENT_API_KEY` pattern, `.env.example:41-51` |

## 6. Phase index

| Phase | Delivers | New tables | New routes | Size |
|---|---|---|---|---|
| **1 — Partnership & referral link** | Partnership minted on payout-form submit; campaign gets `targetUrl`; welcome email with tracking link; thank-you page shows link | `Partnership` | — | S |
| **2 — Attribution** | Click-counting redirect `/t/:code`; conversion webhook from our product; per-creator metrics | `Click`, `Conversion` | `GET /t/:code`, `POST /attribution/conversion` (+refund) | M |
| **3 — Payout ledger** | Obligations (fixed fee), payout creation with conversion locking, brand mark-paid, creator confirm/dispute magic links, auto-settle sweep | `Obligation`, `Payout` | `/payouts/*` (brand), `/payout/confirm|dispute` (creator) | M–L |
| **4 — Partners dashboard** | Web UI: partners list + detail, payout actions, PayPal CSV export | — | `GET /partnerships*`, CSV export | S–M |

Phases are strictly sequential (each builds on the previous schema), but each is
independently shippable and demoable. Build order within a phase: schema → db helpers →
engine/route logic → emails/pages → tests → harness → runbook entry.

## 7. New environment variables (all documented in `.env.example` when added)

| Var | Phase | Default | Purpose |
|---|---|---|---|
| `ATTRIBUTION_WEBHOOK_SECRET` | 2 | unset (warn) | Shared secret our product sends as `X-Attribution-Secret` on the conversion webhook. Optional locally, same posture as `AGENT_API_KEY`. |
| `PAYOUT_CONFIRM_TTL_DAYS` | 3 | `7` | Lifetime of the creator confirm/dispute token. |
| `PAYOUT_AUTO_SETTLE_DAYS` | 3 | `7` | SENT payouts with no creator response auto-settle after this many days (scheduler sweep). |

`PAYMENT_BASE_URL` (existing) is the single public-origin knob for **all** creator-facing
links: payment form, tracking redirect, confirm/dispute pages.

## 8. Definition of done (whole system)

- A creator completes the workflow → receives a working tracked link automatically.
- Clicking the link from another device lands on the product with the referral param;
  the click is counted.
- The product posts a conversion → it appears under the right creator with the right
  commission in cents; re-posting the same `externalId` changes nothing.
- Brand dashboard shows per-creator clicks / conversions / revenue / earned / unpaid / paid.
- Brand creates a payout (fee or commission), pays in PayPal, marks it sent with the
  transaction reference → creator receives the "you've been paid" email.
- Creator's **Confirm** settles the payout; **Dispute** flags it and emails the brand;
  silence auto-settles after 7 days; expired/reused links show a friendly error.
- Every step above is visible as events in the observability inspector.
- `tsc` clean; full server suite green (baseline 119 passing, no regressions); each
  phase's harness runs green against a real local stack; live runbook executed once
  end-to-end with a real inbox.
