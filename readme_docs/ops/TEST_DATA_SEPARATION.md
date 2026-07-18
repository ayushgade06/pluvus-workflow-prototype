# P8 — Separate harness/test data from prod

**Goal:** the live operator dashboard, `/observability` counts, and payout
metrics show **only real partners** — no harness fixtures, no stale failed queue
jobs — when we run against the production Neon DB.

---

## Why this matters

The dev DB is shared with the harnesses. Running `npm run harness:phase8`,
`setup-live-test.ts`, or any reclone leaves behind test creators
(`phase8-harness-*@example.com`, the Nylas live-test creator on gmail, anything
on a reserved `*.example.com` domain) plus their instances and — once a hybrid
run mints them — partnerships and payout-ledger rows. Going live on the same DB
means that junk sits next to real creators in every operator view, and the
BullMQ `failed` counter starts at whatever the harnesses left (we saw
`failed:100`). The operator can't tell a real park from a test artifact.

We did **not** add an `isTest` column + migration to every table — for a single
operator that is heavier than needed. Instead there is one convention: **test
data is identified by the owning creator's email.**

---

## The convention (single source of truth)

`server/src/config/testData.ts` — `isTestEmail(email)`. A creator is test data
when its email is:

- on a reserved non-deliverable domain: `example.com/.net/.org/.edu`, `*.test`,
  `*.invalid`, `localhost` (RFC 2606 — these can only ever be fixtures), **or**
- a named test address (currently `ayushgade23@gmail.com`, the Nylas live-test
  creator), **or**
- carries a test marker in the local part: `+harness`, `phase8-harness`,
  `harness-creator`.

The predicate is deliberately **strict** — a real creator's address must never
match, because the cleanup deletes everything hanging off a matched creator.
When you add a new named test creator on a real-looking domain, add it to
`KNOWN_TEST_EMAILS` in that file (never widen the domain rule). Unit-locked in
`server/src/config/testData.test.ts`.

---

## Cleanup + queue drain

`server/scripts/cleanHarnessData.ts`, exposed as npm scripts. **Dry run by
default** — it prints exactly what it would delete and changes nothing.

```
# from server/ — preview what would be purged (SAFE, no changes)
npm run db:clean:harness

# actually purge test rows AND drain stale failed queue jobs
npm run db:clean:harness:apply

# other combinations
npx tsx scripts/cleanHarnessData.ts --apply              # DB only, no queue drain
npx tsx scripts/cleanHarnessData.ts --drain-queues       # dry-run the queue drain
```

What `--apply` does, in ONE transaction (all-or-nothing):

1. Resolve every test creator via `isTestEmail`.
2. Delete their execution instances + the full FK-safe cascade — Event,
   Message, OutboxJob, BrandNotification, PaymentInfo, then the attribution /
   payout ledger (Click/Conversion/Obligation/Payout via the instance's
   Partnership), then the Partnership and the ExecutionInstance. This reuses
   `deleteInstanceCascade` — the **exact** ordering `deleteCampaign` uses, so the
   two can't drift.
3. Delete the test creators themselves.

The shared seed workflow/version/campaign are **left intact** — a test creator
merely enrolled into them.

`--drain-queues` removes all `failed` jobs from both BullMQ queues
(`node-execution`, `inbound-email`) via `queue.clean(0, …, "failed")`, leaving
waiting/active real jobs alone, so the failure counters start clean.

---

## Also confirm before go-live

- `ENABLE_QUEUE_INJECTION=false` in the deployed env (it already defaults to
  `false` in `.env.example`; the POST `/queues/*` injection routes answer 404
  unless this is `true` or `NODE_ENV=test`). Never set it in production.
- Ideally point production at its **own Neon branch** (decision D5) so harness
  runs can't touch prod at all. Until then, this cleanup is the hygiene layer:
  run `npm run db:clean:harness` (dry run) any time, and
  `npm run db:clean:harness:apply` right before the first real creator.

---

## Acceptance

- `npm run db:clean:harness` lists every current test creator and its instance
  count and changes nothing.
- After `npm run db:clean:harness:apply`: the operator dashboard and
  `/observability/instances` show only real partners; `/queues/health` reports
  `failed: 0` on both queues.
