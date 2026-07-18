# Deployment Guide — Pluvus Workflow Platform

This is the **single source of truth for deploying the whole system**: what runs where,
every key required, the exact order of operations, and the go-live checklist.

Target platform: **Render** (managed PaaS) for compute + Redis, **Neon** for Postgres,
plus the managed third parties the app already talks to (Nylas email, OpenRouter LLM).

> The general product/architecture README is [`README.md`](./README.md). This file is
> **only** about getting it running in production. Ops runbooks referenced below live in
> [`readme_docs/ops/`](./readme_docs/ops/).

---

## 1. What we are deploying (the topology)

The monorepo is **three deployable applications** plus **three managed dependencies**.

```
                         ┌────────────────────────────────────────────┐
   creators (email) ───► │  Nylas  ── webhook ──►  server (API)        │
                         │                          ▲   │              │
   operator (browser) ──►│  web (static SPA) ───────┘   │              │
                         │        X-Operator-Key         ▼             │
                         │  server (worker fleet)   ◄─ Redis (BullMQ)  │
                         │  server (scheduler ×1)   ◄─ Redis (locks)   │
                         │        │                                    │
                         │        ▼  AGENT_SERVICE_URL                 │
                         │  agent (FastAPI/LangGraph) ──► OpenRouter    │
                         │        │                                    │
                         │        ▼  DATABASE_URL (Neon serverless)    │
                         │  Neon Postgres                              │
                         └────────────────────────────────────────────┘
```

### The three apps (all from this one repo)

| # | App | Folder | Stack | Render service type | Scale |
|---|-----|--------|-------|---------------------|-------|
| 1 | **API + Workers + Scheduler** | `server/` | Node 20, Express, Drizzle, BullMQ | **3 separate Web/Background services from ONE image** (see below) | api ×1+, worker ×N, scheduler **×1 only** |
| 2 | **Agent (AI)** | `agent/` | Python 3.11, FastAPI, LangGraph | Web Service (private) | ×1+ |
| 3 | **Dashboard** | `web/` | React 18 + Vite (static build) | Static Site | CDN |

**The server is ONE Docker image run in three roles** selected by `PROCESS_ROLE`
(`api` | `worker` | `scheduler`). This is deliberate — see `server/processRole.ts` and
`docker-compose.yml`. The rules that must survive to production:

- **`scheduler` runs as exactly ONE instance.** Two schedulers = two 30s pollers hammering
  the same due instances. There is a Redis leader-lease safety net (`SCHEDULER_LEADER_TTL_MS`)
  but do not rely on it to correct a misconfigured scale — set replicas to 1.
- **`worker` scales horizontally.** Add replicas for throughput. Each in-flight step holds a
  worker slot for a 45–120 s LLM call, so tune `WORKER_CONCURRENCY` to the agent's capacity
  first, then add replicas.
- **`api` is the only public HTTP surface.** It also serves the **creator-facing HTML pages**
  (payment form, payout confirm/dispute) — so its public URL is what creator email links and
  the Nylas webhook are minted against (`PAYMENT_BASE_URL`).

### The three managed dependencies

| Dependency | What for | Provider | Notes |
|---|---|---|---|
| **Postgres** | All persistent state | **Neon** (must be Neon) | The server uses `@neondatabase/serverless` (WebSocket driver) — it needs a **Neon** endpoint, **not** Render's own Postgres. Keep the DB on Neon. |
| **Redis** | BullMQ queues + scheduler locks | **Render Key Value** (managed Redis) | ⚠ Requires a one-line code fix — see §6. Use the **internal** URL. |
| **Email** | Outbound + inbound creator email | **Nylas** | Already connected; only the webhook URL + secret need re-pointing. |
| **LLM** | Classification / negotiation / drafting | **OpenRouter** | One key, per-role model slugs. Verify slugs before the first paid run. |

---

## 2. Accounts & keys you need before you start

Gather these first. Every one maps to an env var in §5.

| # | Thing to get | Where | Produces |
|---|---|---|---|
| 1 | **Neon project + branch** | https://neon.tech | `DATABASE_URL` (pooled connection string, `?sslmode=require`) |
| 2 | **Render account** | https://render.com | hosts all compute + Redis |
| 3 | **Render Key Value (Redis)** | Render dashboard → New → Key Value | `REDIS_URL` (internal) |
| 4 | **OpenRouter API key** | https://openrouter.ai/keys | `OPENROUTER_API_KEY` |
| 5 | **Nylas API key + Grant ID** | https://dashboard.nylas.com (already set up) | `NYLAS_API_KEY`, `NYLAS_GRANT_ID` |
| 6 | **Nylas webhook secret** | Created when you register the webhook (§8) | `NYLAS_WEBHOOK_SECRET` |
| 7 | **Two secrets you generate yourself** | `openssl rand` / node crypto (below) | `ATTRIBUTION_WEBHOOK_SECRET`, `OPERATOR_API_KEY` |

Generate the two self-minted secrets:

```bash
# Operator dashboard key (also becomes VITE_OPERATOR_API_KEY on the web build)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# Attribution webhook secret (money integrity — required in production)
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

> **Never commit these.** `.env` is gitignored. Run `npm run scan:secrets` before any commit —
> it fails on live-secret patterns in tracked files. See [`readme_docs/ops/SECRETS.md`](./readme_docs/ops/SECRETS.md).

---

## 3. Deployment order (the happy path)

Do these in order. Each step is expanded in the sections below.

1. **Provision data stores** — Neon Postgres + Render Key Value (Redis). [§4]
2. **Apply the DB migrations** to Neon. [§4]
3. **Apply the Redis code fix** (§6) and commit it — required for Render's authed/TLS Redis.
4. **Deploy the Agent** (Python) as a private Render web service. [§7]
5. **Deploy the Server** — three services (api / worker / scheduler) from the shared image. [§7]
6. **Deploy the Web** dashboard as a Render static site. [§7]
7. **Set `PAYMENT_BASE_URL`** to the API's public Render URL and redeploy the server. [§8]
8. **Re-point the Nylas webhook** to `https://<api-host>/webhooks/nylas` and set the secret. [§8]
9. **Smoke-test** the go-live checklist. [§9]

---

## 4. Data stores

### Neon Postgres
1. Create a project + a **production branch** in Neon.
2. Copy the **pooled** connection string → this is `DATABASE_URL`. Keep `?sslmode=require`.
3. **Apply migrations.** The migration SQL lives in `server/prisma/migrations/` and is applied
   with the bundled runner (Prisma runtime is gone; the `.sql` files are the schema of record):

   ```bash
   # from server/, with DATABASE_URL set to the Neon prod branch:
   cd server
   # apply each migration dir in chronological order, oldest first:
   npx tsx prisma/apply-migration.ts prisma/migrations/20260624064336_init/migration.sql
   # …repeat for each dir in filename order through the newest…
   npx tsx prisma/apply-migration.ts prisma/migrations/20260715120000_attribution_payouts_phase1to3/migration.sql
   ```
   Migrations are ordered by their timestamp prefix — apply them in ascending order.
   (For a fresh DB you can concatenate them, but running oldest→newest is the safe default.)

   > The runner wraps each file in a single transaction. A migration that adds an **enum
   > value** (`ALTER TYPE … ADD VALUE`, e.g. the phase-7 manual-review and deferred-intent
   > migrations) cannot run inside a transaction on older Postgres — if the runner errors on
   > one, apply that file's statements by hand (Neon SQL editor) and continue. This is a
   > one-time first-deploy concern; on Neon's current Postgres it generally succeeds.

### Render Key Value (Redis)
1. Render dashboard → **New → Key Value**. Same region as your services.
2. Use the **Internal** connection URL for `REDIS_URL` (services on Render reach it over the
   private network — lower latency, no egress).
3. ⚠ Render's Redis URL carries a **password** (and the public URL uses **TLS** `rediss://`).
   The current code drops both — **apply the §6 fix first.**

---

## 5. Environment variables — the complete inventory

Full annotated list is in [`.env.example`](./.env.example). Below is grouped by **which app
needs it** and flagged **required vs optional** for a live Render deploy.

### Set on ALL server roles (api + worker + scheduler)

| Key | Required | Value for this deploy |
|---|---|---|
| `NODE_ENV` | ✅ | `production` (turns on the fail-loud secret guard) |
| `DATABASE_URL` | ✅ | Neon pooled connection string |
| `REDIS_URL` | ✅ | Render Key Value internal URL |
| `ATTRIBUTION_WEBHOOK_SECRET` | ✅ | your generated secret (server **refuses to boot** without it in prod) |
| `OPERATOR_API_KEY` | ✅ | your generated operator key (server refuses to boot without it in prod) |
| `AGENT_SERVICE_URL` | ✅ | the Agent service's **internal** Render URL (e.g. `http://pluvus-agent:8000` or the private `.onrender.com` host) |
| `AGENT_API_KEY` | ✅ | shared secret; same value set on the Agent |
| `AGENT_PROVIDER` | ✅ | `langgraph` |
| `NEGOTIATION_PROVIDER` | ✅ | `langgraph` |
| `EMAIL_PROVIDER` | ✅ | `nylas` |
| `NYLAS_API_KEY` | ✅ | from Nylas |
| `NYLAS_GRANT_ID` | ✅ | from Nylas |
| `NYLAS_WEBHOOK_SECRET` | ✅ | from webhook registration (§8) |
| `PAYMENT_BASE_URL` | ✅ | the **API public URL** (§8) — creator links + webhook are minted from this |
| `PROCESS_ROLE` | ✅ | `api` / `worker` / `scheduler` per service |
| `PORT` | api only | Render injects it; the app reads it |
| `WORKER_CONCURRENCY` | worker | default `5`; tune to agent capacity |
| `SCHEDULER_LEADER_TTL_MS` | scheduler | default `90000` |
| `BRAND_NOTIFY_EMAIL` | optional | workspace-wide fallback for manual-review notices |
| `ENABLE_QUEUE_INJECTION` | ✅ leave **unset/false** | never enable in a deployed env (it can inject fake creator replies) |
| `LOG_DIR` or `LOG_FILE` | optional | mirror logs to a file for the live log; see [`readme_docs/ops/ALERTING.md`](./readme_docs/ops/ALERTING.md) |

### Set on the Agent (Python)

| Key | Required | Value |
|---|---|---|
| `LLM_PROVIDER` | ✅ | `openrouter` |
| `OPENROUTER_API_KEY` | ✅ | from OpenRouter |
| `OPENROUTER_MODEL` | ✅ | money/decision model slug, e.g. `anthropic/claude-opus-4.8` — **verify on openrouter.ai/models** |
| `OPENROUTER_MODEL_DRAFT` | optional | cheaper copy model for drafting (blank → inherits `OPENROUTER_MODEL`) |
| `NEGOTIATION_STRATEGY` | ✅ | `llm` (or `rules` for deterministic) |
| `AGENT_API_KEY` | ✅ | same shared secret as the server |
| `AGENT_ENV` | ✅ | `production` — makes the agent **fail closed** (503) if `AGENT_API_KEY` is empty |
| `LLM_MAX_REQUEST_COST_USD` | ✅ recommended | per-request hard cap, e.g. `0.50` — kills a runaway negotiation loop |
| `LLM_DAILY_SPEND_ALERT_USD` | recommended | daily spend alarm surfaced on `/observability/llm`, e.g. `25` |
| `LLM_INVOKE_TIMEOUT_SECONDS` | optional | default `60` |

> ⚠ **Verify OpenRouter model slugs before the first paid run.** Slugs get renamed
> (`deepseek/deepseek-chat-v3` was already dead → the `deepseek-v4-*` family). Confirm each slug
> resolves on https://openrouter.ai/models. `anthropic/claude-opus-4.8` was valid at last check.

### Set on the Web (static build — baked in at build time)

| Key | Required | Value |
|---|---|---|
| `VITE_OPERATOR_API_KEY` | ✅ | the **same** value as `OPERATOR_API_KEY` — the dashboard sends it as `X-Operator-Key` |
| API base | ✅ | the web build must call the API's public URL. In dev, Vite proxies `/api`→`:3001`; in prod there is no proxy, so point the client at the API host (see §7 web note). |

---

## 6. ⚠ Required code fix before Render Redis works

`server/src/workers/redis.ts` currently parses **only host + port** from `REDIS_URL` and
drops the password and TLS scheme. That is fine for local plaintext Redis, but Render's Key
Value requires **auth** (and the public endpoint uses **TLS `rediss://`**). Connecting as-is
will fail with `NOAUTH` / connection reset.

Patch `redisConnection()` to pass the credentials through:

```ts
export interface BullMQConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, unknown>;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
}

export function redisConnection(): BullMQConnection {
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  try {
    const u = new URL(url);
    return {
      host: u.hostname || "127.0.0.1",
      port: u.port ? Number(u.port) : 6379,
      username: u.username || undefined,
      password: u.password || undefined,
      tls: u.protocol === "rediss:" ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  } catch {
    return { host: "127.0.0.1", port: 6379, maxRetriesPerRequest: null, enableReadyCheck: false };
  }
}
```

`server/src/scheduler/lock.ts` uses `createClient({ url })` from `redis`, which already parses
the full URL — no change needed there.

> If you use Render's **internal** Redis URL (recommended), it is plaintext on the private
> network and the password is still present in the URL — so this fix is needed either way for
> the auth, and additionally for the `rediss://` public URL. Apply it, commit, then deploy.

---

## 7. Deploying each app on Render

You can wire these by hand in the dashboard or with a `render.yaml` Blueprint (recommended —
a starter blueprint is at [`render.yaml`](./render.yaml)). Manual steps per app:

### 7a. Agent (Python) — deploy FIRST (the server depends on it)
- **New → Web Service**, connect the repo, root directory `agent/`.
- Runtime: Python 3.11. Build: `pip install -e ".[ai]"`. Start:
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
- Set the Agent env vars from §5. Mark it **private** (only the server calls it) if your plan
  supports private services; otherwise keep it locked by `AGENT_API_KEY` + `AGENT_ENV=production`.
- Health check path: `/health`.

### 7b. Server — three services from one Docker image
- Build all three from `server/Dockerfile` (repo root as build context — the Dockerfile expects
  the workspace layout).
- **`pluvus-api`** — Web Service. `PROCESS_ROLE=api`. Health check `/health`. This is the
  **public** URL. Command: `node dist/index.js` (default).
- **`pluvus-worker`** — Background Worker. `PROCESS_ROLE=worker`. Scale replicas ≥ 1.
- **`pluvus-scheduler`** — Background Worker. `PROCESS_ROLE=scheduler`. **Replicas = 1. Never scale.**
- All three share the "ALL server roles" env block from §5.
- Run migrations (§4) once against Neon before the first boot (or as a Render pre-deploy job).

### 7c. Web dashboard — static site
- **New → Static Site**, root `web/`. Build: `npm ci && npm run build`. Publish dir: `web/dist`.
- Build-time env: `VITE_OPERATOR_API_KEY` = your operator key.
- **API base:** the dev Vite proxy (`/api` → `localhost:3001`) does **not** exist in a static
  build. Either (a) point the API client at the public API host via a `VITE_API_BASE_URL` you
  thread into `web/src/api/*`, or (b) put the static site and API behind one domain and add a
  Render **rewrite rule** `/api/* → https://<api-host>/*`. Pick one before building — the SPA
  can't reach the API otherwise.

---

## 8. Wire the public URL + Nylas webhook

The API is the origin every creator link and the inbound webhook are built from.

1. After `pluvus-api` is live, copy its public URL (e.g. `https://pluvus-api.onrender.com`).
2. Set **`PAYMENT_BASE_URL`** to that URL on **all three** server roles and redeploy.
   (Locally the tunnel launcher keeps this in sync — see
   [`readme_docs/ops/STABLE_URL.md`](./readme_docs/ops/STABLE_URL.md) — but Render gives you a
   stable host, so you set it once.)
3. In the **Nylas dashboard**, point the webhook destination at
   `https://<api-host>/webhooks/nylas`. Nylas probes with `HEAD`/`GET` (challenge) before
   saving — the route already answers both.
4. Copy the **webhook secret** Nylas returns into `NYLAS_WEBHOOK_SECRET` on the server roles and
   redeploy. Without it the webhook route rejects inbound deliveries.

**Which routes are public vs gated** (so a creator link is never blocked):
- **Gated** by `X-Operator-Key`: `/payouts`, `/campaigns`, `/partnerships`, `/observability`,
  `/manual-queue`, `/workflows`, `/creators`, `/uploads`, `/queues`.
- **Open** (creator magic-links / webhooks — must stay open): `/health`, `/webhooks`, `/payment`,
  `/t`, `/attribution`, `/payout/confirm`, `/payout/dispute`.

---

## 9. Go-live smoke checklist

Run these after everything is deployed:

- [ ] `GET https://<api-host>/health` → `200 {"status":"ok"}`.
- [ ] `GET https://<api-host>/observability/meta` **without** `X-Operator-Key` → **401**;
      **with** the key → 200. (Confirms the operator gate.)
- [ ] `GET https://<agent-host>/health` → 200; `/metrics` without `AGENT_API_KEY` → 401/503.
- [ ] `GET /observability/alerts` (with key) → a JSON roll-up with `status: ok|warning|critical`.
      Point your uptime monitor at this. See [`readme_docs/ops/ALERTING.md`](./readme_docs/ops/ALERTING.md).
- [ ] The dashboard loads and its data calls succeed (operator key baked in).
- [ ] Enroll **one test creator** (an `@example.com`/`.test` address — these are recognized test
      addresses) and launch → confirm `ENROLLED → OUTREACH_SENT` in the dashboard and a real email
      lands. Then reply and confirm the classify → negotiate loop runs on OpenRouter.
- [ ] Confirm the scheduler is the **only** one polling (one `pluvus-scheduler` replica).
- [ ] After testing, purge test data: `npm run db:clean:harness` (dry-run) →
      `npm run db:clean:harness:apply`. See [`readme_docs/ops/TEST_DATA_SEPARATION.md`](./readme_docs/ops/TEST_DATA_SEPARATION.md).

---

## 10. Cost & spend guardrails

- **OpenRouter** is the only per-use cost on the AI path. `LLM_MAX_REQUEST_COST_USD` caps a
  single request (kills a runaway loop → agent returns 503 → orchestration degrades to
  `MANUAL_REVIEW`). `LLM_DAILY_SPEND_ALERT_USD` is a monitor surfaced on `/observability/llm`
  and in the alerts roll-up — it **alerts**, it does not block.
- **Render**: the scheduler + at least one worker + api + agent are always-on services; size
  the worker replicas to load. Redis + Neon are the managed add-ons.
- Verify OpenRouter model slugs before the first paid run (§5).

---

## 11. Quick reference — commands

```bash
# One-time, before deploy
npm ci                                 # install workspace deps
npm run typecheck                      # server + web must be clean
npm run scan:secrets                   # no live secrets in tracked files
cd server && npm test                  # server test suite

# Migrations (against Neon prod branch)
cd server && npx tsx prisma/apply-migration.ts prisma/migrations/<dir>/migration.sql

# Local full stack (for comparison / staging on one box)
docker compose --profile app up -d --scale worker=3   # api + worker×3 + scheduler×1 + pg + redis
npm run dev                            # non-Docker: server + web together (agent runs separately)

# Server roles by hand (no Docker)
cd server && npm run build
npm run start:api        # PROCESS_ROLE=api
npm run start:worker     # PROCESS_ROLE=worker
npm run start:scheduler  # PROCESS_ROLE=scheduler   (exactly one)

# Agent by hand
cd agent && pip install -e ".[ai]" && uvicorn app.main:app --host 0.0.0.0 --port 8000
```

---

## 12. Related ops runbooks

| Doc | Covers |
|---|---|
| [`readme_docs/ops/SECRETS.md`](./readme_docs/ops/SECRETS.md) | Full secret inventory + rotation; `npm run scan:secrets` |
| [`readme_docs/ops/STABLE_URL.md`](./readme_docs/ops/STABLE_URL.md) | Public-URL story (interim tunnel vs the stable Render host) |
| [`readme_docs/ops/ALERTING.md`](./readme_docs/ops/ALERTING.md) | `/observability/alerts`, log-to-file sink, uptime monitoring |
| [`readme_docs/ops/TEST_DATA_SEPARATION.md`](./readme_docs/ops/TEST_DATA_SEPARATION.md) | Recognizing + purging test data before/after go-live |
| [`.env.example`](./.env.example) | Every env var the code reads, annotated |
| [`docker-compose.yml`](./docker-compose.yml) | The split topology (api / worker / scheduler) |
