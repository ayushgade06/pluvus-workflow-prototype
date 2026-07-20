#!/bin/bash
# Production startup script — runs all three services in one VM
set -e

echo "[start-prod] Starting Redis on port 6379..."
# Loopback only — Redis is internal (BullMQ); binding * makes Replit's port
# detector auto-expose it via a [[ports]] mapping in .replit.
redis-server --bind 127.0.0.1 --port 6379 --daemonize yes --logfile /tmp/redis.log
echo "[start-prod] Redis started."

echo "[start-prod] Starting Python agent on port 8000..."
cd agent
uvicorn app.main:app --host 0.0.0.0 --port 8000 >>/tmp/agent.log 2>&1 &
cd ..
echo "[start-prod] Agent started (PID $!)."

# Apply any migrations the deployed DB is missing. Runs before the server starts so
# a schema-drifted boot fails loudly here rather than 500ing on every request that
# touches a changed table. `set -e` aborts the boot if this fails — that is intended.
echo "[start-prod] Applying database migrations..."
(cd server && npx tsx prisma/apply-all-migrations.ts)
echo "[start-prod] Migrations up to date."

echo "[start-prod] Starting Node server on port ${PORT:-3000}..."
exec node server/dist/index.js
