# Single-Operator Go-Live — Hardening Plan

**Status:** DRAFT / not started · **Owner:** Ayush · **Created:** 2026-07-17

## Context & scope

Pluvus itself is the **sole operator** of this system. We reach out to creators,
negotiate, sign, and pay them — no external tenant ever logs into the dashboard
or calls the internal API. Creators only ever interact through **email links**
(payment form, payout confirm/dispute, tracking redirect), never the API.

This reframing removes the entire multi-user auth/RBAC surface. We are NOT
building Clerk-gated login, per-brand tenancy, or role permissions now. What
remains is **operational hardening** so that going live with real creators (real
money, real inboxes, public URLs) is safe *for a single operator*.

The core business logic — state machine, negotiation, idempotency, the
obligation→payout→confirm/dispute→settle ledger, refunds, escalation gates — is
already solid and battle-tested (see memory: attribution phases 1–4, v1
founder-alignment, batch 1–5 remediation). This plan does not touch it.

### Explicitly OUT of scope (accepted trade-offs for single-operator)
- No dashboard login / session / RBAC. Operator routes are gated by a shared
  secret and/or network, not user auth.
- No real payment rail. Payouts are recorded; the operator pays via PayPal
  offline. The system is the ledger + confirm/dispute audit trail.
- Bearer-token payment/payout links stay as-is (standard magic-link pattern).
- Single server instance + single Redis. Fine at a few dozen creators.

### Deployment target
Merge into / run alongside parent **Pluvus** (`D:\internship\Pluvus` —
Clerk/Drizzle/SendGrid/Stripe). Some items (Stripe conversion adapter, stable
domain) are naturally satisfied by that environment. See `MERGE_READINESS.md`
and memory `[[pluvus-parent-merge]]`.

### RESOLVED DECISIONS
- **D2 — Commission trigger (founder-decided 2026-07-17): PURCHASE ONLY.**
  Creators earn commission only when a referred user **buys** (10% × sale value).
  A referred **sign-up that does not buy earns nothing**. There is NO per-signup
  bounty. Consequence: **P6 (Clerk registration adapter) is DROPPED** — we do not
  record registrations as conversions. Attribution wiring is Stripe-purchase-only
  (P5 + P7). This matches the current percentage-of-sale model, so no new
  obligation type is needed.

---

## Priority summary

| # | Item | Severity | Effort | Blocking go-live? |
|---|------|----------|--------|-------------------|
| P1 | Set `ATTRIBUTION_WEBHOOK_SECRET` + send from caller | 🔴 money integrity | XS | YES |
| P2 | Gate operator routes (shared secret OR network) | 🟠 data/money exposure | S | YES |
| P3 | Stable public URL (named tunnel / real host) | 🟠 broken links = disputes | S | YES |
| P4 | Switch LLM to OpenRouter (hosted) + observability | 🔴 offline model won't ship | XS | YES |
| P5 | Stripe `checkout.session.completed` → conversion adapter | 🟠 commission half | M | YES for commissions |
| ~~P6~~ | ~~Clerk `user.created` → conversion adapter~~ | — | — | **DROPPED (D2: purchase-only)** |
| P7 | `?_from=` capture + thread into Stripe checkout metadata | 🟠 attribution plumbing | M | YES for commissions |
| P8 | Separate harness/test data from prod DB | 🟡 hygiene | S | strongly recommended |
| P9 | Error alerting + uptime + queue-failure visibility | 🟡 ops | M | recommended |
| P10 | Secrets hygiene / rotate / move out of `.env` in repo | 🟡 security | S | recommended |

XS ≈ minutes · S ≈ <½ day · M ≈ 1–2 days

---

## P1 — Lock the conversion webhook 🔴 BLOCKING

**Why:** `/attribution/conversion` is publicly reachable (Stripe/Clerk/Pluvus
call it from outside). `ATTRIBUTION_WEBHOOK_SECRET` is currently **unset** →
open posture (`attribution.ts:39`). Referral codes are semi-predictable
(`<name>_<hex>`). Anyone on the internet can POST fake sales → inflate a
creator's commission → we pay fraudulent money. This is money integrity, NOT a
multi-user concern — it applies even as sole operator.

**Do:**
1. Generate a strong secret; set `ATTRIBUTION_WEBHOOK_SECRET` in `.env` (and the
   deployed env).
2. Every caller of `POST /attribution/conversion` and
   `POST /attribution/conversion/:externalId/refund` must send
   `X-Attribution-Secret: <secret>`. The check already exists
   (`attribution.ts:28 checkSecret`, constant-time) — it just needs a value.
3. On startup in a non-local env, FAIL LOUD if the secret is unset (right now it
   only `console.warn`s once). Add a guard: if `NODE_ENV==='production'` and no
   secret → refuse to boot, so we never silently run open in prod.

**Acceptance:** POST without header → 401; with correct header → 201; boot in
prod with no secret → process exits with a clear error.

**Files:** `server/src/routes/attribution.ts` (add prod-required guard),
`.env` / deploy env.

---

## P2 — Gate the operator routes 🟠 BLOCKING

**Why:** Everything runs on ONE Express app / one public origin (`app.ts`).
Public-by-necessity routes (`/webhooks`, `/payment`, `/t`, `/payout`,
`/attribution`) sit on the SAME origin as the operator money/data routes:
- `/payouts` — mark paid, send emails, settle money
- `/campaigns` — create AND **delete** (cascade-wipes a campaign)
- `/partnerships` — read all creator/payout data
- `/observability` — leaks every creator email, negotiation transcript, payout
  destination
- `/manual-queue`, `/workflows`, `/creators`, `/uploads`

"We're the only users" does NOT protect these if the origin URL is public
(and it must be, for the creator/webhook routes). Anyone who learns the URL can
hit them. Need SOME gate — full auth is overkill, a gate is mandatory.

**Pick ONE (or both):**

- **A. Shared-secret middleware (app-level).** Reuse the existing pattern
  (`attribution.ts checkSecret` / `queues.ts requireInjectionEnabled`). Add an
  `requireOperatorKey` middleware checking `X-Operator-Key` against
  `OPERATOR_API_KEY` (constant-time). Mount it on the operator routers ONLY:
  `/payouts`, `/payout`(brand-side settle only — NOT the creator confirm GET/POST
  which are magic-link-gated), `/campaigns`, `/partnerships`, `/observability`,
  `/manual-queue`, `/workflows`, `/creators`, `/uploads`, `/queues`. Leave
  `/webhooks`, `/payment`, `/t`, `/attribution` open (creator/webhook-facing).
  The web dashboard (`web/`) sends the key on every request (env-injected).

  ⚠ CAREFUL: `/payout` mixes brand-side (`/payouts/:id/settle` is under
  `/payouts`) and creator-side (`/payout/confirm/:id`, `/payout/dispute/:id` under
  `/payout`). Confirm the split before gating so a creator's magic link is never
  blocked. Map every route to public|operator first (see checklist below).

- **B. Network-level.** Put the operator routes behind Cloudflare Access / an IP
  allowlist / a private network, so only the operator's machine reaches them.
  Cleaner if using a named Cloudflare tunnel — expose only the public paths
  publicly, keep operator paths on a protected hostname.

**Recommendation:** Do **A** (portable, in-code, survives infra changes) and
optionally **B** on top. A is ~half a day.

**Acceptance:** an unauthenticated request to `/payouts/*`, `/campaigns` DELETE,
`/observability/*` → 401. Creator magic links (`/payment/:token`,
`/payout/confirm/:id`) and `/webhooks/nylas` still work with NO operator key.
Dashboard works with the key injected.

**Files:** new `server/src/middleware/requireOperatorKey.ts`, `server/src/app.ts`
(mount per-router), `web/src/api/*` (inject header), `.env`.

**Pre-req task:** produce a route inventory table: every mounted path →
public|operator|creator-magic-link. This is the source of truth for what gets
gated. (Do this FIRST — mis-gating a creator route breaks payouts.)

---

## P3 — Stable public URL 🟠 BLOCKING

**Why:** Everything rides an **ephemeral** `trycloudflare.com` quick tunnel that
**dies and changes URL on restart** — we hit this failure 3× in one session
(see memory `[[delete-campaign-attribution-cascade-fix]]` sibling notes and the
webhook-secret saga). For live creators, a dead URL = broken payment/payout/
tracking links = disputes and lost conversions. Also breaks the Nylas webhook
registration each restart.

**Do (pick one):**
- **Named Cloudflare tunnel** with a stable hostname (requires a domain on
  Cloudflare). Persist the config so restarts keep the same URL.
- **Deploy behind a real host** (Pluvus's infra / Render / Fly / Railway) with a
  fixed domain + TLS.

Then set `PAYMENT_BASE_URL` to the stable origin ONCE, and register the Nylas
webhook against the stable `/webhooks/nylas` ONCE.

**Acceptance:** restart server + tunnel → same public URL → existing payment/
payout links still resolve → Nylas webhook still verified. No re-registration
needed after a restart.

**Files:** infra/tunnel config, `.env` `PAYMENT_BASE_URL`, Nylas dashboard (one
time).

---

## P4 — Hosted LLM (OpenRouter) + basic observability 🔴 BLOCKING

**Why:** `LLM_PROVIDER=ollama` runs negotiation/drafting on a local model on the
operator's machine — does not survive deployment and has no capacity/uptime
guarantees. (User is already providing an OpenRouter key.)

**Do:**
1. Set `OPENROUTER_API_KEY`; flip `LLM_PROVIDER=openrouter`. Verify the model
   slugs on openrouter.ai before a paid run (they get renamed — see the
   OPENROUTER_MODEL comment in `.env`). Keep `NEGOTIATION_STRATEGY=llm`.
2. Confirm the existing LLM usage telemetry (`[[llm-usage-telemetry]]`,
   `/observability/llm`) records real OpenRouter calls (cost/latency/tokens).
3. Set a per-run / daily **spend guard** or at least monitor the telemetry so a
   negotiation loop can't run up an unbounded bill.
4. Keep Ollama as the documented local-dev fallback.

**Acceptance:** a live negotiation runs through OpenRouter; `/observability/llm`
shows the call with non-zero cost; a smoke run of the reclone→accept flow passes
on the hosted model.

**Files:** `.env`, verify `agent/` provider wiring already supports openrouter
(it does per memory `[[severity1-fixes-openrouter]]`).

---

## P5 — Stripe conversion adapter (paid) 🟠 BLOCKING for commissions

**Why:** The commission half is inert until real sales flow into
`/attribution/conversion`. Parent Pluvus already has Stripe (`stripe ^19.1.0`).

**Do (in Pluvus, or the merged codebase):**
1. Add a Stripe webhook handler for `checkout.session.completed` (and
   `charge.refunded` → our refund endpoint).
2. Verify the Stripe signature (`Stripe-Signature`) in Pluvus — reuse the
   raw-body-HMAC pattern from `webhooks.ts verifyNylasSignature`.
3. Read `referralCode` from `session.metadata.referralCode` (set at checkout —
   see P7).
4. Translate → `POST /attribution/conversion` with
   `X-Attribution-Secret` (P1), `referralCode`, `externalId: session.id`,
   `amountCents: session.amount_total`, `customerEmail`,
   `metadata:{ kind:"purchase" }`.
5. On `charge.refunded` → `POST /attribution/conversion/:externalId/refund`.

**Acceptance:** a real (test-mode) Stripe checkout carrying a referralCode
produces an attributed conversion + 10% commission obligation on the right
partnership; a refund reverses it.

**Files:** Pluvus Stripe webhook module (NEW); this system unchanged (endpoint
ready).

---

## P6 — Clerk conversion adapter (registrations) — ❌ DROPPED

**Founder decision D2 (2026-07-17): commission is PURCHASE ONLY.** A referred
sign-up that does not buy earns the creator nothing; there is no per-signup
bounty. Therefore we do NOT wire Clerk `user.created` into attribution and do
NOT record registrations as conversions.

Do not build this. If the policy ever changes to reward signups, revisit: it
would need a Clerk `user.created` adapter (Svix-verified) AND a new flat-bounty
obligation type (a % rate yields $0 on a $0 signup), plus stronger anti-abuse
(signups are cheap to fake). Out of scope for go-live.

---

## P7 — `?_from=` capture + Stripe metadata threading 🟠 BLOCKING for commissions

**Why:** THIS is the real integration work and the crux of attribution accuracy.
The tracking redirect (`/t/:code`) already appends `?_from=<code>` to the
brand's target URL. But capturing it and carrying it through to checkout is 100%
on the Pluvus side and does NOT exist yet. Without it, P5 fires with a null
`referralCode` → unattributed. (Purchase-only per D2, so this threads into Stripe
checkout only — not Clerk sign-up.)

**Do (in Pluvus):**
1. Landing page / entry: read `?_from=<code>` from the URL, persist it
   (first-touch cookie/localStorage, honoring an `attributionWindow` if set —
   campaign already has the field).
2. Carry the persisted `referralCode` through the browsing session to checkout.
3. At Stripe Checkout Session creation: inject `referralCode` into
   `metadata.referralCode` so `checkout.session.completed` (P5) carries it.
4. Decide attribution model: first-touch vs last-touch; cookie window length
   (campaign `attributionWindow` is the intended source of truth — D3).

**Acceptance:** click tracking link → land on Pluvus → purchase → the conversion
webhook receives the correct `referralCode` end-to-end, with NO manual code
entry.

**Files:** Pluvus front-end capture + Stripe session creation (NEW).

---

## P8 — Separate harness/test data from prod 🟡 recommended

**Why:** The dev DB mixes real runs with harness fixtures (`phase8-harness-*`
instances, stale `failed:100` queue jobs). Going live against the same Neon DB
means test junk pollutes real dashboards and metrics.

**Do:** either a dedicated prod DB/branch (Neon branch), or a clear
`isTest`/prefix convention + a cleanup script + queue-drain of stale failed
jobs. Ensure `ENABLE_QUEUE_INJECTION=false` in prod (already is).

**Acceptance:** prod dashboard shows only real partners; no harness rows;
queue failure counters start clean.

---

## P9 — Alerting, uptime, queue visibility 🟡 recommended

**Why:** One server, no error alerting. A failed payout email or a stuck
instance currently surfaces only if someone looks. With real creators + money,
silent failures = disputes.

**Do:** uptime monitor on `/health`; alert on queue `failed` growth
(`/queues/health`); alert on `MANUAL_REVIEW` / `AWAITING_BRAND_DECISION` parks so
the operator actions them; capture server logs to a file/service (currently
stdout-only — we literally couldn't read the live log this session).

**Acceptance:** an operator gets notified within minutes of: server down, a
payout email failing, an instance parking for human action.

---

## P10 — Secrets hygiene 🟡 recommended

**Why:** Live secrets (Nylas key, DB URL, webhook secret, soon OpenRouter +
attribution + operator keys) currently sit in a repo-adjacent `.env`. The Nylas
webhook secret was already rotated once this session.

**Do:** move prod secrets to the deploy platform's secret store (not committed);
confirm `.env` is gitignored; rotate anything that has been shared in plaintext;
document which secret feeds which surface.

**Acceptance:** no prod secret in the repo; `.env.example` documents every key
with a placeholder.

---

## Suggested execution order

1. **P1 + P4** (XS each — secret + OpenRouter) — do together, immediate.
2. **P2** (operator gate) — after the route-inventory pre-req.
3. **P3** (stable URL) — needed before any creator gets a link.
4. **P7 → P5** — the Pluvus-side attribution plumbing (Stripe-purchase-only per
   D2); biggest chunk, done in the parent repo. (P6 dropped.)
5. **P8, P9, P10** — harden in parallel / just before/after first live creator.

**Definition of "safe to go live" (single-operator):** P1, P2, P3, P4 done;
P7+P5 done IF commissions are in play for the first campaign; P8 at least
minimally (don't launch on top of harness data).

---

## Open decisions for the operator
- **D1:** Operator-route protection — shared secret (A), network (B), or both?
- ~~**D2:** Pay per-registration or purchase-only?~~ **RESOLVED 2026-07-17:
  PURCHASE ONLY** (see RESOLVED DECISIONS above). P6 dropped.
- **D3:** Attribution model — first-touch vs last-touch; cookie window source
  (campaign `attributionWindow`?).
- **D4:** Stable-URL approach — named Cloudflare tunnel vs deploy to a host.
- **D5:** Prod data isolation — new Neon branch vs cleanup convention (P8).
