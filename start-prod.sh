#!/bin/bash
# Production startup script — runs all three services in one VM
set -e

echo "[start-prod] Starting Redis on port 6379..."
redis-server --port 6379 --daemonize yes --logfile /tmp/redis.log
echo "[start-prod] Redis started."

echo "[start-prod] Starting Python agent on port 8000..."
cd agent
uvicorn app.main:app --host 0.0.0.0 --port 8000 >>/tmp/agent.log 2>&1 &
cd ..
echo "[start-prod] Agent started (PID $!)."

echo "[start-prod] Starting Node server on port ${PORT:-3000}..."
exec node server/dist/index.js
