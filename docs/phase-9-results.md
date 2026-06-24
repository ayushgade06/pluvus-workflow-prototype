# Phase 9 — Validation Results

Captured from live runs against the Neon Postgres DB + local Redis (BullMQ). All
harnesses drive real engine transitions; none are mocked at the queue layer.

## Phase 9 observability harness — `npm run harness:phase9`

```
── API contract — DTOs, no raw Prisma leakage ──
  ✓ GET /observability/workflow returns 11 nodes with counts + derived metrics
  ✓ instance detail DTO serializes timestamps as ISO strings (no raw Prisma Date)
── Setup — reset instance and drive to AWAITING_REPLY ──
  ✓ instance reached AWAITING_REPLY via the queue
── Scenario A — AWAITING_REPLY → NEGOTIATING reflected in counts ──
  counts before: AWAITING_REPLY=3, NEGOTIATING=2
  counts after:  AWAITING_REPLY=2, NEGOTIATING=3
  ✓ workflow counts updated automatically: AWAITING_REPLY −1, NEGOTIATING +1
── Scenario C — instance inspector shows messages, events, state ──
  detail: state=NEGOTIATING, msgs=2, events=9, decisions=1
  classification decision: POSITIVE @ 0.95
  ✓ instance detail exposes state, messages, events, and AI decisions
── Scenario D — timeline reconstructs full history (chronological) ──
  ✓ timeline is chronological and reconstructs the full lifecycle
── Scenario E — logs trace Queue Job → Worker → Transition → Event ──
  NEGOTIATING hop: source=classification-agent, worker=inbound-email, job=inbound|p9-inbound-…
  ✓ every transition carries source attribution; AI hop has worker + queue job id
── Scenario F / Scenario B — NEGOTIATING → ACCEPTED + live polling ──
  final state: ACCEPTED; counts after: NEGOTIATING −1, ACCEPTED +1
  ✓ workflow counts updated automatically: NEGOTIATING −1, ACCEPTED +1
  ✓ successive reads of the read model reflect the new state (live polling works)

✓ Phase 9 harness complete — 9 checks passed
```

## Regression — Phases 3–8 (no execution logic changed)

| Harness | Result |
| --- | --- |
| `npm run harness` (Phase 3 runtime) | exit 0 — full lifecycle to NO_RESPONSE, 19 events, 4 messages |
| `npm run harness:phase4` (queues) | ✓ all tests passed (advance, inbound, idempotency) |
| `npm run harness:phase5` (scheduler) | ✓ all scenarios passed (auto follow-ups, reply stop, OCC/lock) |
| `npm run harness:phase7` (classification) | ✓ all 7 tests passed |
| `npm run harness:phase8` (negotiation) | ✓ all 7 tests passed |

The structured `[transition]` log lines appear correctly attributed across every
harness (`node-execution-worker`, `inbound-email`, `classification-agent`,
`negotiation-agent`), confirming the logging is wired without altering behavior.

## Build / typecheck

- `npm run typecheck` (server) — clean
- `web` `tsc --noEmit` — clean
- `npm run build -w web` — succeeds (vite production build, 353 kB JS / 8 kB CSS)
- Vite dev server serves the SPA and proxies `/api/observability/*` to :3001 (verified).

## Demo dataset — `npm run db:seed:demo`

15 demo creators (`@demo.pluvus.com`) seeded across **every** state with backdated
event/message history and `source` attribution:

```
MANUAL_REVIEW 4 · ACCEPTED 4 · ENROLLED 2 · NEGOTIATING 2 · OPTED_OUT 2
AWAITING_REPLY 2 · FOLLOWED_UP 2 · NO_RESPONSE 2 · OUTREACH_SENT 1
REPLY_RECEIVED 1 · REJECTED 1
```
(counts combine the original Phase-2 seed + the demo set.)
