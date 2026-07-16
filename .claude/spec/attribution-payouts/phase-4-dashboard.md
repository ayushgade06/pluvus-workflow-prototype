# Phase 4 — Partners Dashboard & Brand Visibility

**Status:** BUILT — 5d33a27 feat/attribution-phase-4
**Depends on:** Phases 1–3 (all read surfaces + payout actions exist server-side)
**Size:** S–M (mostly UI; the APIs largely exist by now)

## Goal

Give the brand one place to see and act on everything post-workflow: every activated
partner, their link, attribution numbers, money owed/paid, and the payout actions
(create → mark paid → resolve dispute). Plus the PayPal bulk-CSV export for paying
several creators in one PayPal session.

## 1. API completion (small additions to Phase 2/3 routers)

- `GET /partnerships` (exists from Phase 2) — extend each row with payout rollups:
  `{ unpaidFeeCents (PENDING obligations), unpaidCommissionCents, inFlightCents (payouts
  PENDING/SENT/DISPUTED), settledCents }` and `hasDispute: boolean`. One grouped query
  join, no N+1 (the parent's `getAffiliatePayoutSummaries` shape).
- `GET /partnerships/:id` (exists) — extend with `obligations[]`, `payouts[]` (newest
  first), and the instance's `PaymentInfo` **destination summary**: method +
  `accountIdentifier` + `extra.shipping` when present. This is where the brand reads the
  PayPal email to actually send money.
- `GET /payouts/export/paypal-csv` — port of the parent (`Pluvus/server/routes/api/
  payouts.ts:257-303`): rows = partnerships with `unpaid > 0` and a destination; columns
  `creator_name, creator_email, paypal_email, amount, currency, note, partnership_id`;
  amounts rendered as dollars with 2 decimals from cents; same CSV-escape helper
  (quote-doubling); `Content-Disposition: attachment; filename=paypal-payouts-{date}.csv`.
  NOTE: the export is informational — creating/locking payouts still goes through the
  Phase 3 transactional endpoints, one per creator, after the brand actually pays.

## 2. Web UI (`web/`)

New top-level **Partners** view alongside the builder (routing consistent with how
Monitor/Launch tabs are wired in `web/src/components/builder/`; if a standalone page fits
the router better than a tab, that's an acceptable call at build time — the data
contract is what's specced).

### 2.1 Partners list

Table, one row per partnership: creator name/email · campaign · referral code ·
tracking link (copy button; em-dash when null) · clicks · conversions · revenue ·
earned · **unpaid** (fee + commission, highlighted when > 0) · in-flight · settled ·
dispute badge when `hasDispute`. Default sort: unpaid desc. Header actions:
**Export PayPal CSV** (hits the endpoint), refresh.

### 2.2 Partner detail (drawer or route)

- **Payout info card** — method badge (PayPal), destination (copyable), shipping
  address block when present. Reads the Phase-4 extension of `GET /partnerships/:id`.
- **Attribution panel** — clicks/conversions/revenue tiles + recent conversions table
  (externalId, value, commission, refunded flag, date).
- **Money panel** —
  - Obligations: description, amount, status; `PENDING` rows get **"Create payout"** →
    `POST /payouts/obligations/:id/fixed-fee`.
  - "Unpaid commission: $X across N conversions" with **"Create commission payout"** →
    `POST /payouts/partnerships/:id/commission`; disabled at $0.
  - Payouts table: type, amount, status chip (color per status), reference, dates.
    Row actions by status: `PENDING` → **"Mark as paid…"** modal (reference required —
    the PayPal txn id — note optional) → `POST /payouts/:id/send`; `SENT` → "Resend
    email"; `DISPUTED` → **"Resolve & settle"** → `POST /payouts/:id/settle` (confirm
    dialog: "Only settle after resolving with the creator").
- **Timeline** — the instance's event log already renders in the observability
  inspector; link to it (`/observability` inspector for the instanceId) rather than
  duplicating a timeline here.

### 2.3 API client + types

Extend `web/src/api/types.ts` with `Partnership`, `PartnershipMetrics`, `Obligation`,
`Payout` mirroring the server DTOs (cents fields stay numbers; all dollar rendering via
one shared `formatCents(cents, currency)` util — no ad-hoc `/100` in components).

## 3. Operational niceties (cheap, do them)

- Partners list flags terminal instances (`CONTENT_BRIEF_SENT`) that have **no**
  partnership row ("needs backfill" row with a one-click mint calling a small
  `POST /partnerships/backfill/:instanceId` that reuses `resolvePartnership`) — covers
  runs completed before Phase 1 deployed and any minting failure (Phase 1 §3 posture).
- Empty states with the next action spelled out ("No conversions yet — share the
  tracking link" / "No payout info — creator hasn't completed the form").

## 4. Tests & exit criteria

- Server: rollup query correctness across a seeded matrix (multiple partnerships ×
  statuses × refunds); CSV golden-file test incl. comma/quote-in-name escaping and
  cents→dollars formatting; backfill endpoint idempotence.
- Web: component tests per repo convention (existing web test setup); `formatCents`
  unit-tested; list renders the dispute badge and null-link em-dash.
- Manual: run the full Phase 1→4 live runbook, then operate a real payout end-to-end
  **entirely from this UI** without touching curl.

**Exit criteria:**
- [ ] Brand answers "who sent us users and what do we owe them" from one screen.
- [ ] Every payout action (create fee/commission, mark paid, resend, resolve) works
      from the UI with correct optimistic/refetch behavior.
- [ ] PayPal CSV opens in a spreadsheet with correct amounts and escaping.
- [ ] No N+1 in the list endpoint (verify query count in test).
- [ ] `tsc` clean both packages, server + web suites green.
