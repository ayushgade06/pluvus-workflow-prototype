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

## Optional Infrastructure

Redis is not needed until Phase 4 (BullMQ queues).

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
│       ├── routes/           # HTTP routes (Phase 2+)
│       ├── services/         # Business logic, no transitions (Phase 2+)
│       ├── engine/           # State machine + node executors (Phase 3)
│       ├── workers/          # BullMQ workers (Phase 4)
│       ├── scheduler/        # Delayed job management (Phase 5)
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
| 1 | Repository foundation (this) | ✓ done |
| 2 | Data models (Prisma schema, seed) | ✓ done |
| 3 | Workflow runtime engine (stubs) | pending |
| 4 | Event system (BullMQ queues + workers) | pending |
| 5 | Scheduler (follow-up timers) | pending |
| 6 | Nylas integration layer | pending |
| 7 | Reply classification (LangGraph) | pending |
| 8 | Negotiation agent | pending |
| 9 | Observability UI (React Flow) | pending |
| 10 | Testing & validation | pending |
