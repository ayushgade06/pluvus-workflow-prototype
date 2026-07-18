import "dotenv/config";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { assertRequiredSecrets } from "./config/requiredSecrets.js";
import { initLogSink } from "./observability/logSink.js";
import { startWorkers, stopWorkers } from "./workers/index.js";
import { startScheduler, stopScheduler } from "./scheduler/scheduler.js";
import { processRole, runsApi, runsWorkers, runsScheduler, type ProcessRole } from "./processRole.js";

// P9: mirror console output to a file when LOG_FILE / LOG_DIR is set, so the live
// log is readable even when this runs detached / behind a tunnel. No-op when
// unset (stdout-only, unchanged). Installed FIRST so every startup line is
// captured too.
initLogSink();

// ---------------------------------------------------------------------------
// Unified entrypoint (HARD-A1)
// ---------------------------------------------------------------------------
// Starts only the components selected by PROCESS_ROLE (api | worker | scheduler
// | all). Default "all" keeps the original single-process behavior; a split
// deploy runs `api`, `worker`, and a SINGLE `scheduler` as separate processes
// (see docker-compose.yml + the `start:api|start:worker|start:scheduler` npm
// scripts). This lets the worker fleet scale independently of the API and stops
// every API replica from also running its own poller (the split-topology bug).

const role: ProcessRole = processRole();
const port = process.env["PORT"] ? Number(process.env["PORT"]) : 3001;

// P1: in production, refuse to boot with an open money/data posture (e.g. an
// unset ATTRIBUTION_WEBHOOK_SECRET). No-op in local dev / test. Guard runs for
// every role — the worker/scheduler share the same env, and failing loud from
// any process is better than a silent open API replica.
assertRequiredSecrets();

let httpServer: Server | null = null;

if (runsApi(role)) {
  const app = createApp();
  httpServer = app.listen(port, () => {
    console.log(`[server] (${role}) API listening on http://localhost:${port}`);
  });
}

if (runsWorkers(role)) {
  startWorkers();
  console.log(`[server] (${role}) workers started`);
}

if (runsScheduler(role)) {
  startScheduler();
  console.log(`[server] (${role}) scheduler started (single leader)`);
}

console.log(`[server] process role: ${role}`);

// Graceful shutdown — stop only the components this process started, in the safe
// order: stop accepting HTTP, then drain workers + the scheduler.
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received — shutting down (${role})`);
  if (httpServer) httpServer.close();
  const tasks: Promise<unknown>[] = [];
  if (runsWorkers(role)) tasks.push(stopWorkers());
  if (runsScheduler(role)) tasks.push(stopScheduler());
  await Promise.all(tasks);
  console.log("[server] shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch((err) => {
    console.error("[server] shutdown error:", err);
    process.exit(1);
  });
});
process.once("SIGINT", () => {
  shutdown("SIGINT").catch((err) => {
    console.error("[server] shutdown error:", err);
    process.exit(1);
  });
});
