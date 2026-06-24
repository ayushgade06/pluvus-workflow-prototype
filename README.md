# Pluvus Workflow Prototype

A focused validation harness for the Pluvus V2 workflow execution architecture.
See `.claude/docs/` for the full architecture documentation.

---

## Prerequisites

| Tool | Version | Required for |
|------|---------|-------------|
| Node.js | ≥ 20 | server, web |
| Python | ≥ 3.11 | agent |
| Docker Desktop | any | optional (Postgres + Redis) |

---

## Quick Start (Phase 1 — no external services needed)

### 1. Install Node dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# No edits required for Phase 1
```

### 3. Start the Express server

```bash
npm run dev:server
# → http://localhost:3001
```

### 4. Start the React frontend

```bash
npm run dev:web
# → http://localhost:5173
```

Or start both together:

```bash
npm run dev
```

### 5. Start the Python agent service

```bash
cd agent
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# → http://localhost:8000
```

---

## Phase 1 Acceptance Checklist

Verify all three services are running, then:

- [ ] `curl http://localhost:3001/health` → `{"status":"ok","service":"server",...}`
- [ ] `curl http://localhost:8000/health` → `{"status":"ok","service":"agent"}`
- [ ] Open `http://localhost:5173` → dashboard shows ✓ for both services

---

## Phase 2 — Database Setup

PostgreSQL is required from Phase 2 onward. Redis is not needed until Phase 4.

### Option A — Docker (recommended)

```bash
npm run infra:up    # starts Postgres on localhost:5432
```

### Option B — Local Postgres

Install PostgreSQL locally and create the database manually:

```sql
CREATE USER pluvus WITH PASSWORD 'pluvus';
CREATE DATABASE pluvus_workflow OWNER pluvus;
```

Then set `DATABASE_URL` in `.env`:

```
DATABASE_URL=postgresql://pluvus:pluvus@localhost:5432/pluvus_workflow
```

### Run migrations and seed

```bash
cd server
npm install
npm run db:migrate    # applies prisma/migrations/
npm run db:seed       # creates workflow, version, creators, instances
```

### Verify

```bash
curl http://localhost:3001/health/db
# → {"status":"ok","service":"database",...}
```

---

## Phase 4 — Event System (BullMQ Queues)

Redis is required from Phase 4 onward.

```bash
npm run infra:up    # start Postgres + Redis
```

### Run the Phase 4 harness

```bash
cd server
npm run harness:phase4
# Validates: node-execution job advances an instance
#            inbound-email job triggers reply path
#            re-delivered jobs are idempotent
```

### Queue API endpoints

Once the server is running (`npm run dev:server`), the following endpoints are available:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/queues/health` | Live job counts for both queues |
| GET | `/queues/jobs` | Recent waiting/active/failed jobs |
| POST | `/queues/node-execution` | Manually enqueue a node-execution job |
| POST | `/queues/inbound-email` | Inject a mocked inbound email event |

**Example — advance an instance:**
```bash
curl -X POST http://localhost:3001/queues/node-execution \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "<id>"}'
```

**Example — inject a reply:**
```bash
curl -X POST http://localhost:3001/queues/inbound-email \
  -H "Content-Type: application/json" \
  -d '{"instanceId": "<id>", "mockIntent": "POSITIVE"}'
```

---

## Phase 5 — Scheduler + Instance Locking

Builds on Phase 4. Requires Postgres + Redis (same `npm run infra:up`).

### What Phase 5 adds

- **Optimistic concurrency control (OCC):** every state write uses a `WHERE currentState = expected` guard. If a concurrent worker already moved the instance, the update returns null and the job exits cleanly — no overwrite, no crash.
- **Redis instance locks:** `SET instance:{id} NX PX 30000` acquired by each worker before execution and released in `finally`. Prevents two workers from processing the same instance simultaneously.
- **Scheduler poller:** runs every 30 s, queries `dueAt <= now` for instances in `AWAITING_REPLY` or `FOLLOWED_UP`, and enqueues a node-execution job for each. Uses deterministic job IDs so overlapping polls never double-enqueue.
- **Follow-up scheduling:** the follow-up executor now returns a `dueAt` (derived from node config `intervals` in days) when entering `AWAITING_REPLY`. The scheduler uses this to fire the next follow-up automatically.

### Run the Phase 5 harness

```bash
cd server
npm run harness:phase5
# Scenario A — scheduler fires follow-ups automatically (NO_REPLY path)
# Scenario B — inbound reply stops follow-ups; scheduler finds nothing to trigger
# Scenario C — two concurrent jobs for the same instance: OCC + lock allow exactly one win
```

---

## Infrastructure

```bash
npm run infra:up    # start Postgres + Redis
npm run infra:down  # stop and remove containers
```

---

## Repository Structure

```
pluvus-workflow-proto/
├── web/              # React + Vite frontend (Phase 1, 9)
├── server/           # Express API + execution engine (Phases 1–6)
│   ├── prisma/
│   │   ├── schema.prisma     # All six models + enums
│   │   ├── migrations/       # Generated migration SQL
│   │   └── seed.ts           # Mocked creators, workflow, instances
│   └── src/
│       ├── index.ts          # Entrypoint + health + /health/db
│       ├── db/               # Prisma client singleton + repository layer
│       ├── routes/           # HTTP routes
│       │   └── queues.ts         # Queue health + diagnostics endpoints
│       ├── engine/           # State machine + node executors (Phase 3)
│       │   ├── runtime.ts        # WorkflowRuntime + StaleInstanceError
│       │   ├── stateMachine.ts   # Transition table + guards
│       │   ├── providers.ts      # IEmailProvider, IAgentProvider interfaces
│       │   └── executors/        # One file per node type
│       ├── workers/          # BullMQ queues + workers (Phase 4)
│       │   ├── redis.ts          # Redis connection config
│       │   ├── jobs.ts           # Job payload type definitions
│       │   ├── queues.ts         # Queue singletons + enqueue helpers
│       │   ├── nodeExecutionWorker.ts  # Advances instance one step
│       │   ├── inboundEmailWorker.ts   # Processes inbound email reply
│       │   ├── index.ts          # Worker startup + graceful shutdown
│       │   └── harness.ts        # Phase 4 acceptance test harness
│       ├── scheduler/        # Distributed scheduling + locking (Phase 5)
│       │   ├── lock.ts           # Redis SET NX PX per-instance locks
│       │   ├── poller.ts         # 30 s due-instance polling loop
│       │   ├── scheduler.ts      # Facade: startScheduler / stopScheduler
│       │   └── harness.ts        # Phase 5 acceptance test harness
│       └── adapters/         # Email + agent adapters (Phases 3–7)
├── agent/            # Python LangGraph service (Phase 1, 7–8)
│   └── app/
│       ├── main.py           # FastAPI entrypoint + health check
│       ├── routes/           # /draft, /classify, /negotiate (Phase 7+)
│       └── graphs/           # LangGraph graphs (Phase 7+)
├── docker-compose.yml        # Optional: Postgres + Redis
├── tsconfig.base.json        # Shared TypeScript config
├── .env.example              # All env vars documented
└── .claude/docs/             # Architecture documentation
```

---

## Implementation Phases

| Phase | Deliverable | Status |
|-------|-------------|--------|
| 1 | Repository foundation | ✓ done |
| 2 | Data models (Prisma schema, seed) | ✓ done |
| 3 | Workflow runtime engine | ✓ done |
| 4 | Event system (BullMQ queues + workers) | ✓ done |
| 5 | Scheduler + instance locking (OCC + Redis locks) | ✓ done |
| 6 | Nylas integration layer | pending |
| 7 | Reply classification (LangGraph) | pending |
| 8 | Negotiation agent | pending |
| 9 | Observability UI (React Flow) | pending |
| 10 | Testing & validation | pending |
