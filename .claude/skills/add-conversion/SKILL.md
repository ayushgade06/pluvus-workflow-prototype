---
name: add-conversion
description: Record a purchase (conversion) for a partner in the local Pluvus dev system, minting the creator's commission. Resolves the partner by referral code, creator email, name, or partnership id, then POSTs to /attribution/conversion — exactly what Pluvus's outbound reporter does in production when a referred user buys. Use when the user says "add a conversion", "record a sale for <partner>", "simulate a purchase", "give <creator> a conversion", or wants to test the commission/payout half of a hybrid campaign. Also supports refunding a conversion.
---

# Add a conversion for a partner

Records a **purchase** against a partner's referral code so the creator's **10%
(or configured) commission** accrues on the payout ledger. This is the manual
stand-in for the automatic Stripe/Clerk-billing conversion reporter that Pluvus
fires in production — it hits the same `POST /attribution/conversion` webhook, so
the same validation, dedup, and commission math apply.

## When to use

Invoke when the user wants to:
- "add a conversion" / "record a sale for <partner>" / "simulate a purchase",
- "give <creator> a conversion" / test the commission side of a hybrid campaign,
- see commission accrue before paying it out,
- or **refund** a previously recorded conversion.

## Prerequisites

- The dev server must be running (`server/`, default port `3001`; override `PORT`).
- **A partner must exist** — i.e. a hybrid campaign has been onboarded far enough
  to mint a Partnership (creator accepted + submitted payout info →
  `CONTENT_BRIEF_SENT`). If `/partnerships` is empty, run the onboarding flow first.
- On the hardened branch (`feat/single-operator-golive`) the reads/writes need
  secrets — the helper auto-reads `OPERATOR_API_KEY` (for `/partnerships`) and
  `ATTRIBUTION_WEBHOOK_SECRET` (for `/attribution`) from `.env`, so no manual
  header wrangling.

## How it works

The bundled helper `scripts/add-conversion.mjs`:

1. `GET /partnerships` (with `X-Operator-Key`) → resolves the partner by matching
   the `--partner` value against **referral code, creator email, creator name, or
   partnership id**. Prints a list of known partners if none matches.
2. Prints the **before** rollup (unpaid commission + conversion count).
3. `POST /attribution/conversion` (with `X-Attribution-Secret`) with
   `{ referralCode, externalId, amount|amountCents, currency?, customerEmail?,
   metadata:{kind:"purchase"} }`.
   - `externalId` is the dedup key (auto-generated unless you pass `--external-id`);
     re-posting the same id is an idempotent no-op (`{duplicate:true}`).
   - Commission = `amount × commissionRate%`, computed server-side.
4. Re-reads and prints the **after** rollup so you see the commission accrue.

With `--refund` it instead calls
`POST /attribution/conversion/:externalId/refund` to reverse a conversion.

## Steps

1. Confirm the server is up: `Invoke-RestMethod http://localhost:3001/health`
   (expect `status: ok`). If down, tell the user to start it and stop.
2. Identify the partner. If unsure, `GET /partnerships` (with the operator key)
   lists creators + their referral codes. The `--partner` arg accepts any of:
   referral code, email, name, or partnership id.
3. Run the helper from the repo root. Amount is in **dollars** by default:
   ```
   node .claude/skills/add-conversion/scripts/add-conversion.mjs --partner <who> --amount <dollars>
   ```
4. Report: the resolved partner, the conversion result (attributed / duplicate),
   and the before → after unpaid-commission delta. Offer to record more sales
   (each grows the owed commission) or to pay it out via the Partners dashboard.

## Examples

Record a $149 sale for a creator (by email):
```
node .claude/skills/add-conversion/scripts/add-conversion.mjs --partner ayushgade23@gmail.com --amount 149
```

Record by referral code, with a customer email and explicit sale id:
```
node .claude/skills/add-conversion/scripts/add-conversion.mjs \
  --partner ayushgade_54a072ce590e --amount 99.99 \
  --email buyer@example.com --external-id order-2001
```

Record using integer cents instead of dollars:
```
node .claude/skills/add-conversion/scripts/add-conversion.mjs --partner "Ayush Gade" --amount-cents 14900
```

Refund a previously recorded conversion:
```
node .claude/skills/add-conversion/scripts/add-conversion.mjs --partner ayushgade23@gmail.com --refund --external-id order-2001
```

## Notes / variations

- **Dollars vs cents**: pass `--amount` (dollars, e.g. `149` or `149.99`) OR
  `--amount-cents` (integer cents, e.g. `14900`) — never both.
- **Dedup**: pass a stable `--external-id` (e.g. the real order id) to make
  re-runs idempotent; omit it to auto-generate a unique one each time.
- **Multiple sales**: run it repeatedly with different `--external-id`s to watch
  unpaid commission batch up before a payout.
- **Overrides**: `PORT` / `SERVER` (server location); `OPERATOR_API_KEY` /
  `ATTRIBUTION_WEBHOOK_SECRET` (env vars override `.env` values).
- **Unknown referral code**: the webhook still 202-accepts it as an *unattributed*
  audit row — but this helper resolves a real partner first, so that only happens
  if the partnership was deleted mid-run.
- The helper uses only Node built-ins and goes entirely through the REST API — no
  DB access — so the same server-side validation and commission math apply as a
  real production conversion.
