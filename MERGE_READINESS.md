# MERGE READINESS — pluvus-workflow-proto → Pluvus

**Purpose of this document:** the definitive readiness assessment for merging this workflow-automation prototype into the parent **Pluvus** platform (`D:\internship\Pluvus`) to convert creator outreach from **manual (human + Google Sheets)** to **automated (AI workflow engine)**.

**Date:** 2026-07-14 · **Proto tip:** `65897d1` (main, clean, pushed) · **Verified state:** server 84/84 tests, agent guard-math 23/23, both tsc clean.

---

## TL;DR Verdict

| Layer | Verdict | One-liner |
|---|---|---|
| Negotiation money path (Python agent) | ✅ **Ready** | Cannot overpay or accept out-of-band on a capped campaign; guards are in code, not prompt |
| Workflow engine + state machine (TS server) | ✅ **Ready** | Idempotency, OCC, safe-degrade-to-human all correct; no silent-loss paths found |
| Escalation & routing behavior | ✅ **Ready** | All 6 founder-alignment phases built, merged, live-verified E2E (real Gmail replies) |
| Observability scaffolding | ⚠️ Ready-with-caveats | Right fields captured (tokens/latency/cost), no backend wired |
| Deployment / packaging | ❌ Needs work | Built for standalone 3-service deploy; parent is a single-process Replit autoscale app |
| **Merge fit (ORM / auth / email)** | ⚠️ **In progress** | ✅ Prisma→Drizzle done proto-side (branch `feat/prisma-to-drizzle`); tenant-scoping, parent-side `IStorage` shaping, and an email-provider decision still required before merge |

**Bottom line:** the *engine* — the hard part — is validated and good to go. The remaining work is **adaptation to the parent's conventions**, not redesign. Authentication is **not** a gap: the parent's Clerk + `requireAuth()` + tenant-scoping perimeter covers all workflow routes once mounted inside it.

---

## 1. The Two Systems at a Glance

| | **pluvus-workflow-proto** (this repo) | **Pluvus** (parent, merge target) |
|---|---|---|
| Server | Express + TypeScript | Express + TypeScript (ESM, esbuild-bundled) |
| ORM / DB | **Prisma** → Neon Postgres, migration files | **Drizzle** → Replit Postgres (dev) + Neon (prod), `db:push` sync, single `shared/schema.ts` |
| Auth | None (prototype) | **Clerk** (`server/clerkAuth.ts`) + `requireAuth()` + `getAuthWithTenant()` + subscription paywall |
| Multi-tenancy | None | **Every table tenant-scoped** (`tenantId` FK, cascade delete) |
| Queues | BullMQ + local Redis, dedicated worker process | BullMQ + **Upstash** Redis, workers run **inside the API process**; Redis treated as optional (currently down in their prod) |
| Email out | **Nylas** (per-grant send) | **SendGrid → Brevo fallback** (`dispatchEmail()` in `server/services/email.ts`); Resend is dead config |
| Email in (replies) | **Nylas webhook** → HMAC verify → threadId correlate → classify | **None. Zero inbound email capability.** |
| LLM | Python FastAPI agent service (`agent/`, port 8001) — classify / negotiate / draft | `@anthropic-ai/sdk` in-process (`server/services/claude-adapter.ts`, strategy docs + support bot only) |
| Deployment | 3 services (server, worker, agent) + docker-compose (partial) | **One Replit autoscale process** (API + client + workers + cron), single public port |
| Outreach today | Fully automated end-to-end | **Fully manual, off-platform**: Google Sheet per tenant, humans send emails, humans mark replies, merchant negotiates over `mailto:`, copy-pastes onboarding link |

### What the parent already has that the merge plugs into

- `tenants.outreachGuidelines` (jsonb) — brand voice/style config, collected in-app "for AI agent", **currently consumed by nothing** → becomes the draft-agent's brand context.
- `addOutreachJob()` on an `outreach` BullMQ queue (`server/queues/index.ts:45`) — **zero callers, no worker** → ready-made async seam for the engine's node-execution.
- `POST /api/partnerships/create-deal` / `finalize` (`server/routes/api/partnerships.ts:53/168`) — already creates `negotiatedDeals` + `paymentObligations` + onboarding token programmatically → the engine's deal-close call.
- "Needs Attention" queue (`prospectResolutions`, `/api/attention-count`, `CycleProspectPanel`) → the natural **MANUAL_REVIEW** surface; replaces this proto's Manual Queue tab.
- SendGrid Event Webhook with signature verification (`server/routes/webhooks/sendgrid.ts`) → delivery/open/click tracking loop, just needs `custom_args` set on sends.

---

## 2. READY — validated and good to go

These are the parts extensive testing has already proven. They port as-is (logic unchanged; only the data/auth/email seams get re-plumbed).

### 2.1 The negotiation money path (`agent/app/routes/negotiate.py`)
- Every rate-bearing action is coerced and **clamped to `[floor, ceiling]` in code** (`_apply_decision_guards`, negotiate.py:1071) — the model literally cannot agree above ceiling or below floor.
- Clamp target vs escalate boundary kept as **separate values** (`ceiling_rate` vs `tolerance_ceiling`) — offers are always capped at the real ceiling; only the ESCALATE trigger uses the tolerance band.
- Final-round false-accept guard (CRITICAL-4): a firm over-tolerance ask on the last round **escalates instead of silently closing** at a clamped number (negotiate.py:1090).
- Anti-overpay: never counters a below-floor ask upward; never offers more than the creator asked.
- Any LLM failure degrades to the deterministic rules strategy — never a 500 that strands a negotiation.
- Guard-altered decisions **drop the model's pre-guard email draft** so a contradictory email can never ship.
- Locked by 23 deterministic guard-math tests (`agent/tests/test_escalation_traps.py`) — no model call needed to verify in CI.

### 2.2 Escalation & routing (server) — the V1 founder behavior
All six founder-alignment phases (A–F) are built, merged to main, and **live-verified E2E with real Gmail replies through the full Nylas webhook → classify → route path** (2026-07-13):
- Escalation is a clean **one-way handoff to a human** (terminal `MANUAL_REVIEW` + brand FYI email) — no magic links, no brand-decision round-trip (Phase A removal complete; `AWAITING_BRAND_DECISION` no longer exists in the schema).
- Always-escalate topic gate (legal / usage-rights / licensing / pricing-exception / dispute) fires **deterministically, pre-model, regardless of confidence**; payment-timing defers honestly instead of escalating (Q3).
- DEFERRED reply intent ("let me think about it") → soft follow-up at +3 days (Phase D; the server-seam allowlist bug is fixed and regression-tested, commit `65897d1`).
- Negotiation opens at the floor (Phase B); over-ceiling tolerance band configurable (Phase C, default 0).
- Opt-out is a deterministic code gate that runs **before** any model call, on every inbound, every round — no injection can suppress CAN-SPAM compliance.
- 11 deterministic routing tests (`server/src/engine/escalationTraps.test.ts`) lock all of this in CI. Full trap matrix + live runbook: `readme_docs/testing/README.md`.

### 2.3 Engine correctness invariants (server)
- **Workers are the only writers of instance state**; OCC (`updateInstanceStateConditional`) is the real backstop with the Redis lock explicitly a mere optimization.
- Idempotency at every layer: `sendOnce` reserves a Message row *before* sending (no double-send), `processedAt`-based inbound dedup (a crash mid-processing retries instead of losing the reply), deterministic BullMQ job IDs.
- The busy-lock asymmetry is right in both directions: node-execution skips on busy (poller re-enqueues), inbound email **throws to force a retry** (a creator reply is never dropped).
- Circuit breaker on the agent HTTP seam; degradation is uniformly **toward a human** (classify→UNKNOWN→MANUAL_REVIEW, negotiate→escalate, draft→retry 3×→template/escalate) — never toward a guessed money decision.
- Prompt-injection defenses layered correctly: regex gates reduce fooling, but the deterministic money guards and code-gated opt-out are the actual guarantees.

### 2.4 The full automated lifecycle (what replaces the manual flow)
Working end-to-end in this repo: enroll → AI-drafted outreach → reply webhook → classify → multi-round bounded negotiation → agreement confirmation (Reward node) → payout-info collection via hosted form (Payment node) → campaign-brief PDF email (Content Brief node) → terminal. Every step event-logged with source attribution (observability dashboard reads it).

---

## 3. NEEDS WORK — with the specific improvement required

### 3.1 Merge-required porting (must do; this is the actual integration work)

| # | Item | What exactly must change |
|---|---|---|
| M1 | ✅ **Prisma → Drizzle (proto-side DONE)** | **Done on branch `feat/prisma-to-drizzle` (2026-07-14):** the proto server now runs entirely on Drizzle — one `server/src/db/schema.ts` (10 `pgTable`s + 10 `pgEnum`s + `createInsertSchema` companions, byte-identical to the live Neon DDL, cuid2 + `$onUpdate` reproducing Prisma's client-side magic), neon-serverless + `ws` client matching the parent's `db.ts`, all `server/src/db/*` + every caller ported, Prisma deps removed. Gates green: `tsc` clean (server+web), suite 85/85 incl. the 11 escalation traps + a new PGlite OCC race test, `harness:phase8` 9/9 against live Neon, and a full **live E2E campaign** (real outreach → 2-round negotiation → $250 ACCEPT → payment chain) verified row-by-row in the DB. **Remaining (parent-side):** fold the `pgTable`s into the parent's `shared/schema.ts` and rewrite the data access as `IStorage` methods in `server/storage.ts` (+ `MemStorage`). The mechanical ORM rewrite — the hard part — is complete and validated; only the copy-into-parent + `IStorage` shaping is left. |
| M2 | **Tenant-scope everything** | Every workflow table gets `tenantId` FK (cascade); every query filters by it; route handlers use `requireAuth()` + `getAuthWithTenant(req)` and 401 on missing tenant. Public creator-facing endpoints (payment form, inbound-email webhook) register **before** `app.use(clerk)` like the parent's `/api/track/*` routes. Decide paywall status for workflow routes (`SUBSCRIPTION_ALLOWLIST_PREFIXES`). *Note: this replaces — and is stronger than — the "no API auth" blocker from the standalone assessment.* |
| M3 | **Email provider decision** (see §5) | Either (a) bring **Nylas** into the parent as a new integration (keeps this repo's proven send+reply-webhook+threadId correlation intact), or (b) re-found on **SendGrid + Inbound Parse** (matches parent's stack; requires rebuilding reply correlation off `In-Reply-To`/`References` headers instead of Nylas threadIds, and per-tenant inbound routing). Outbound should flow through the parent's `dispatchEmail()` and create `outboundMessages` rows with `custom_args` so the existing event webhook closes the tracking loop. |
| M4 | **Python agent deployment** | The parent is one esbuild-bundled Node process on Replit — a FastAPI sidecar doesn't fit the deployment unit. Options: (a) **deploy `agent/` as a separate hosted service** (Fly/Railway/Render) the engine calls over HTTPS with `AGENT_API_KEY` enforced (auth middleware already exists in `agent/app/security.py`, currently unset), or (b) **port the agent to TypeScript** in `server/services/` using the parent's existing `@anthropic-ai/sdk` seam. (a) is faster and keeps the tested guard code byte-identical; (b) removes an infra dependency but re-implements ~3.5k lines of tested money-path logic — **recommend (a) for V1, (b) later if desired**. |
| M5 | **Redis-optional degraded path** | The parent treats Redis as optional and its production Upstash is *currently unreachable* (documented gotcha). The engine's progression hard-depends on BullMQ. Either fix/replace Upstash before launch (required for real automation), or add a DB-backed polling fallback consistent with the parent's null-queue warn-and-skip convention. Workers must be registered in the parent's `initializeQueues()` / in-process worker pattern (no separate worker fleet exists on Replit). |
| M6 | **Domain-table mapping** | Don't ship parallel tables. Map: negotiation outcome → parent's `negotiatedDeals`; proto Reward/Payment nodes → parent's `/api/partnerships/create-deal` + `paymentObligations` + existing `/onboard/:token` flow (which already handles approval, Firma contracts, PayPal info, welcome emails); proto Manual Queue → parent's "Needs Attention" surface. The proto's `PaymentInfo` table/hosted form is superseded by parent onboarding — **drop it in the merge** and have the agreement-confirmed step auto-send the onboarding link (today's copy-paste step). |
| M7 | **Enrollment trigger** | Wire enrollment to the parent's prospect source: on cycle activation (or sheet-cache ingest in `server/routes/api/sheets.ts`), enroll prospects into a workflow instance per campaign. The orphaned `addOutreachJob()` seam is the natural entry. Draft context = `tenants.outreachGuidelines` + `campaigns` terms (`fixedPaymentAmount`, `paymentTerms`, `priceStrategy`) + prospect profile. |

### 3.2 Hardening improvements (should do; found in code review, none are open bugs)

| # | Item | Improvement needed |
|---|---|---|
| H1 | ✅ **DONE (proto-side, 2026-07-14)** — Uncapped campaign bypasses ceiling guard | Runtime backstop added server-side: `executeNegotiation` now resolves the band as a pure-config PRECONDITION (before any DB load or agent call) and, when a campaign has a floor but no ceiling, escalates to `MANUAL_REVIEW` (`escalateNoCeiling`, reason `no_ceiling_configured`) instead of negotiating against `+inf`. Locked by 3 tests in `escalationTraps.test.ts` (helper shape + agent-never-consulted + capped-campaign-proceeds). In the merged world, ALSO derive the band from `campaigns.fixedPaymentAmount` and validate at campaign-publish time; this guard remains the runtime net. Original: prompt was the only protection (negotiate.py:1518-1520). |
| H2 | ✅ **DONE (proto-side, 2026-07-14)** — Intent-allowlist drift | The two runtime allowlists (classify provider + worker mockIntent list) now DERIVE from `replyIntentEnum.enumValues` (single source of truth); the worker copy had actually drifted (missing `DEFERRED`). Locked by `LangGraphClassificationProvider.intents.test.ts`: both runtime sets == the enum, DEFERRED asserted explicitly, and a compile-time bidirectional check that `ReplyIntentValue` matches the enum union. This drift caused a real incident (DEFERRED silently degraded to MANUAL_REVIEW). The Python agent list is the remaining hand-maintained copy — assert it in the parent's CI at merge. |
| H3 | **Telemetry has no backend** | The right fields are captured (tokens, latency, per-role cost, error kinds) and funnel through one seam (`emit_llm_metric`, telemetry.py:134) but land only in a 256-entry in-process ring buffer. **Wire that one function to a real sink** (OTel/Prometheus or even structured logs shipped to the parent's logging) before trusting production monitoring. |
| H4 | **Concurrency-model globals** | `_active_prompt_version` is a module global (races under async/multi-worker; telemetry.py:188), and the agent's rate limiter is in-process. Fine for a single-worker deploy; **move to `ContextVar` + shared store before scaling the agent horizontally**. |
| H5 | **Secrets rotation** | The working-tree `.env` holds live Neon password, Nylas key + webhook secret, and an OpenRouter key (never committed to git — verified — but present on dev machines). **Rotate all of them at merge time**; in the parent, secrets live in Replit env, so fold these into that store and delete the local file. |
| H6 | **Destructive scripts unguarded** | `db:reset`, `reset_instance.mjs`, `prisma/reset-to-*.ts` read the live `DATABASE_URL` with no environment guard. Add an `ALLOW_DESTRUCTIVE=1` gate — or simply don't port them; the parent has its own tooling. |
| H7 | ✅ **DONE (proto-side, 2026-07-14)** — Edge-validation nits | (a) `LangGraphNegotiationProvider` now drops a non-finite / non-number `proposedTerms.rate` at the HTTP seam (string / NaN / ±Infinity → treated as "no rate proposed"; non-rate fields preserved). (b) `executeNegotiation`'s outcome `switch` gained a `default` that escalates to a human (`escalateOverCeiling`) instead of falling through to `undefined`, with a `never` exhaustiveness check so tsc flags a new outcome. Locked by 3 new cases in `LangGraphNegotiationProvider.test.ts` + `providers.negotiateOutcome.test.ts`. |
| H8 | ✅ **DONE (proto-side, 2026-07-14)** — Stranded-instance sweep coverage | `RECONCILE_STATES` is now exported and covered by `reconciliation.coverage.test.ts`: asserts `NEGOTIATING` + `REPLY_RECEIVED` ARE swept, every WAITING and TERMINAL state is NOT, the set equals exactly (all states − terminal − waiting), and drives `reconcileStuckInstances` end-to-end for both flagged states. The previously-unverified review flag is now green. |

### 3.3 Open product decisions (need a founder call, not code)

| # | Decision | Context |
|---|---|---|
| P1 | **Max-rounds auto-REJECT is unreachable under the live LLM strategy** | On the final round the LLM always ACCEPTs (in-band) or ESCALATEs (over-band) — it never COUNTERs, so the `maxRoundsReject` path (and its courteous close email) never fires in practice. Routing is proven by tests; the question is whether founder #15's "auto-reject at max rounds" is still wanted, and whether the close email should also fire on creator-initiated REJECT (today it doesn't). |
| P2 | **Utility-curve concession math (founder #1)** | Deliberately deferred — offers step symmetrically instead of conceding smallest-near-the-floor. Marked TODO on `negotiate.py:_step_offer`. Founder's own answer called this later-phase. |
| P3 | **Anchor-low-then-escalate (D-1)** | Resolved 2026-07-13 as intended V1 behavior (early rounds counter low even on a wild ask; escalate only at the final round). Documented here so the merge doesn't "fix" it. |

---

## 4. Automated Outreach — How the Merge Replaces the Manual Flow

Parent's manual lifecycle today (verified by code reading) → what automates it:

| Step | Today (manual) | After merge (automated by this engine) |
|---|---|---|
| 1. Setup | Merchant sets campaign terms, outreach guidelines, criteria | Unchanged (these become engine inputs) |
| 2. Discovery | Pluvus team fills Google Sheet `Cycle_N` per tenant | Unchanged for V1 (sheet/`prospects` remains the source) |
| 3. Cold outreach | Human sends first email externally, writes it into the sheet | **Initial Outreach node**: AI-drafted email from `outreachGuidelines` + campaign terms, sent via `dispatchEmail()`, tracked in `outboundMessages` |
| 4. Reply detection | Human sets `response_status` in the sheet | **Inbound webhook → classify** (POSITIVE / NEGATIVE / QUESTION / DEFERRED / OPT_OUT / UNKNOWN @ confidence, topic gate first) |
| 5. Attention surface | Sheet cache polled into "Needs Attention" | **State-driven**: only true escalations (topics, low confidence, over-tolerance) land in the attention queue — with a reason label |
| 6. Negotiation | Merchant haggles over `mailto:` | **Negotiation node**: bounded multi-round AI negotiation inside `[floor, ceiling]`, opens at floor, max-rounds capped, guards in code |
| 7. Deal entry | Merchant clicks "Finalize Deal" | **Engine calls the `create-deal`/`finalize` logic** on ACCEPT — `negotiatedDeals` + `paymentObligations` created programmatically |
| 8. Link delivery | Merchant copy-pastes `/onboard/{token}` into an email | **Auto-sent** by the agreement-confirmation step |
| 9. Onboarding | In-app (approval / Firma / PayPal / tracking link) | **Unchanged** — parent's existing flow is kept as-is |
| 10. Payouts | In-app obligations → PayPal CSV | **Unchanged** |

Humans stay in the loop exactly where the founder specified: escalated topics, low-confidence replies, over-tolerance asks — as terminal one-way handoffs into the attention queue.

### Suggested merge order
1. **Phase 0 — decisions:** email provider (M3), agent hosting (M4), Redis fix (M5), ceiling requirement (H1). *(≈ a meeting, not code)*
2. **Phase 1 — schema + storage:** port models to `shared/schema.ts` + `IStorage` methods, tenant-scoped (M1, M2, M6).
3. **Phase 2 — engine mount:** runtime/executors/state machine into the parent server; queues into `initializeQueues()`; routes behind `requireAuth()`; inbound webhook pre-Clerk with signature verification.
4. **Phase 3 — seams:** outbound through `dispatchEmail()`; agent service deployed + `AGENT_API_KEY` on; enrollment trigger from cycles (M7); deal-close wired to partnerships routes.
5. **Phase 4 — UI:** fold Manual Queue into "Needs Attention"; workflow monitor into `Prospecting.tsx`; retire the copy-paste dialog.
6. **Phase 5 — hardening pass:** H2–H8, port the T1/T2 test suites into the parent's vitest setup, secrets rotation (H5).

---

## 5. Key Risk Register (top 5, post-merge context)

1. **Redis unavailability in parent prod** (M5) — automation cannot run without a queue backbone; this is a launch blocker on the *parent's* side, not this repo's.
2. **Inbound-email is net-new to the parent** (M3) — the least-proven seam post-merge regardless of provider choice; budget real E2E time here (this repo's live testing found both its inbound bugs at exactly this seam: webhook secret unset, allowlist drift).
3. **ORM port regressions** (M1) — the Prisma → Drizzle rewrite touches every query the engine makes; the ported T1 routing tests are the safety net, port them first.
4. **Uncapped-ceiling overpay exposure** (H1) — one-line validation, catastrophic if skipped, because the parent's campaign creation doesn't currently force a budget ceiling.
5. **Replit single-process limits** (M4) — long LLM negotiations + webhook processing + UI in one autoscale process; the external agent service (option a) offloads the heavy part, but watch request timeouts on scale-to-zero cold starts.

---

## Appendix — Evidence Base

- Proto test state (2026-07-14, post-M1-merge + H1/H2/H7/H8 hardening): server `103/103` pass, agent trap suite `23/23` pass, server+web `tsc` clean. M1 (Prisma→Drizzle) is merged to `main`; the four proto-side hardening items are done and locked by the new tests noted in §3.2.
- Live E2E verification (2026-07-13): traps 3, 8, 9, 10, 14 passed with real Gmail replies through Nylas webhook → classify → route; DEFERRED seam bug root-caused and fixed the same day.
- Trap matrix & live runbook: `readme_docs/testing/README.md`.
- Founder-alignment spec: `.claude/spec/v1-founder-alignment/PLAN.md`.
- Parent-code findings referenced herein: `Pluvus/server/clerkAuth.ts`, `server/storage.ts`, `server/services/email.ts`, `server/services/redis.ts`, `server/queues/index.ts`, `server/routes/api/partnerships.ts`, `server/routes/api/sheets.ts`, `server/routes/webhooks/sendgrid.ts`, `shared/schema.ts`, `replit.md`.
