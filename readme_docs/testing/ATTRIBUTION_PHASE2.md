# Attribution Phase 2 — Testing Runbook

**Branch:** `feat/attribution-phase-2`
**Spec:** `.claude/spec/attribution-payouts/phase-2-attribution.md`

---

## Product-side integration contract

### Which event fires the conversion webhook?

**Both** — two distinct events, in order:

| Event | When | `externalId` format | `amountCents` |
|---|---|---|---|
| Signup | When a referred user creates an account | `signup:{userId}` | `0` |
| First payment | When the referred user completes their first payment | `payment:{orderId}` | payment amount in cents |

The product SHOULD send the signup event at account-creation time regardless of
whether a `_from` param was captured, because the referral may be attributed later.
Both events hit the same `POST /attribution/conversion` endpoint.

### Where does the product capture `_from`?

The product back-end reads the `_from` query param (controlled by the campaign's
`hiddenParamKey` column, default `"_from"`) on landing and persists it to the
session / signup record / order. This is product-side bookkeeping — out of this
repo's scope.

### cURL simulation

Replace `<BASE>` with your tunnel/localhost URL (e.g. from `ngrok http 3001`).
Replace `<CODE>` with a real referral code from `GET /partnerships`.

```bash
# Signup conversion (free — valueCents=0)
curl -X POST <BASE>/attribution/conversion \
  -H "Content-Type: application/json" \
  -d '{"referralCode":"<CODE>","externalId":"signup:user_test_001","amountCents":0}'

# First-payment conversion ($49.99)
curl -X POST <BASE>/attribution/conversion \
  -H "Content-Type: application/json" \
  -d '{"referralCode":"<CODE>","externalId":"payment:ord_test_001","amountCents":4999}'

# Replay the same externalId → 200 duplicate:true (idempotent)
curl -X POST <BASE>/attribution/conversion \
  -H "Content-Type: application/json" \
  -d '{"referralCode":"<CODE>","externalId":"signup:user_test_001","amountCents":0}'

# Unknown referral code → 202 attributed:false (audit row)
curl -X POST <BASE>/attribution/conversion \
  -H "Content-Type: application/json" \
  -d '{"referralCode":"bogus_xyz","externalId":"signup:user_test_002","amountCents":0}'

# Refund a conversion
curl -X POST <BASE>/attribution/conversion/payment:ord_test_001/refund

# View metrics
curl <BASE>/partnerships

# Short-link redirect (follow from a browser or curl -L)
curl -L <BASE>/t/<CODE>
```

If `ATTRIBUTION_WEBHOOK_SECRET` is set, add `-H "X-Attribution-Secret: <secret>"` to
all `POST /attribution/*` requests.

---

## Tier 1 — Unit tests (no DB, no LLM)

```bash
cd server
npm test
```

Covers: validation matrix (missing fields, both/neither amount, bad secret, negative
amount), duplicate `externalId`, unknown code, commission rounding, refund guards,
redirect 302 + click recording failure (I-8).

## Tier 2 — Harness (real DB, no LLM)

```bash
cd server
npx cross-env NODE_ENV=production tsx --no-warnings src/engine/attribution.harness.ts
```

Asserts: Partnership minted (Phase 1), `/t/:code` redirect + click row, three
conversions (attributed, duplicate, unknown code), `partnershipMetrics` buckets,
`CONVERSION_RECORDED` and `CONVERSION_REFUNDED` events in inspector, payout-lock 409.

Requires: `DATABASE_URL` pointed at Neon, `EMAIL_PROVIDER=mock`.

## Tier 3 — Live E2E (manual)

1. Start the server: `cd server && npm run dev`
2. Open a tunnel: e.g. `ngrok http 3001`
3. Set `PAYMENT_BASE_URL=<tunnel-url>` in `.env`, restart.
4. Complete a workflow through to `CONTENT_BRIEF_SENT` (use the reclone-campaign skill
   or the partnership harness).
5. Copy the `referralCode` from `GET /partnerships`.
6. Visit `<tunnel>/t/<code>` from a **different device** — confirm 302 to product URL
   with the `_from` param present; confirm click appears in `GET /partnerships/:id`.
7. Simulate a signup conversion with cURL (see above) — confirm `201 attributed:true`.
8. Replay the same `externalId` — confirm `200 duplicate:true`.
9. Simulate a first-payment conversion — confirm `201`, commission calculated correctly
   (`Math.round(amountCents * commissionRate / 100)`).
10. View `GET /partnerships/:id` — confirm metrics: `clicks=1, conversions=2`.
11. Refund the payment conversion — confirm `200 refunded:true`, metrics update.
12. Check the observability inspector for `CONVERSION_RECORDED` and `CONVERSION_REFUNDED`
    events on the instance timeline.

## Exit criteria checklist

- [ ] Click from a phone via tunnel lands on the product with the `_from` param; click counted.
- [ ] Product-fired (or curl-simulated) conversion appears under the right creator with correct cents; replaying is a no-op.
- [ ] Unknown-code conversions are kept but unattributed; refunds respect the payout lock (409).
- [ ] `tsc` clean, suite green, harness green, DDL applied + `db:pull` refreshed.
