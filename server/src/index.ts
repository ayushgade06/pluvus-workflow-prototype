import "dotenv/config";
import express from "express";
import { prisma } from "./db/index.js";
import queuesRouter from "./routes/queues.js";
import webhooksRouter from "./routes/webhooks.js";
import observabilityRouter from "./routes/observability.js";
import campaignsRouter from "./routes/campaigns.js";
import workflowsRouter from "./routes/workflows.js";
import manualQueueRouter from "./routes/manualQueue.js";
import { listCreators } from "./db/creators.js";
import { startWorkers } from "./workers/index.js";
import { startScheduler, stopScheduler } from "./scheduler/scheduler.js";

const app = express();
const port = process.env["PORT"] ? Number(process.env["PORT"]) : 3001;

// ---------------------------------------------------------------------------
// Webhooks (Phase 6) — MUST be mounted before express.json().
// ---------------------------------------------------------------------------
// Nylas signs the RAW request body; signature verification needs the exact
// bytes, so this route uses a raw body parser. express.json() would consume the
// stream and re-parsing would not reproduce the original bytes. GET (challenge)
// carries no body, so the raw parser is a harmless no-op there.
app.use("/webhooks", express.raw({ type: "*/*", limit: "2mb" }), webhooksRouter);

app.use(express.json());

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "server", timestamp: new Date().toISOString() });
});

/** DB health: verifies the Prisma client can reach PostgreSQL. */
app.get("/health/db", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", service: "database", timestamp: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ status: "error", service: "database", message });
  }
});

// ---------------------------------------------------------------------------
// Phase 4 — Queue routes + workers
// ---------------------------------------------------------------------------

app.use("/queues", queuesRouter);

// ---------------------------------------------------------------------------
// Phase 9 — Observability dashboard APIs (read-only)
// ---------------------------------------------------------------------------

app.use("/observability", observabilityRouter);

// ---------------------------------------------------------------------------
// Phase 10 — Workflow Builder APIs
// ---------------------------------------------------------------------------

app.use("/campaigns", campaignsRouter);
app.use("/workflows", workflowsRouter);

// ---------------------------------------------------------------------------
// Phase 11 — Manual Queue (escalated creators + brand notifications)
// ---------------------------------------------------------------------------

app.use("/manual-queue", manualQueueRouter);

/** List all creators — used by the enrollment UI. */
app.get("/creators", async (_req, res) => {
  try {
    const creators = await listCreators();
    res.json(
      creators.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        handle: c.handle,
        platform: c.platform,
        niche: c.niche,
      })),
    );
  } catch (err) {
    console.error("[creators] list error:", err);
    res.status(500).json({ error: "internal server error" });
  }
});

startWorkers();
startScheduler();

const server = app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});

// Graceful shutdown — stop accepting requests, drain workers, then exit.
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received — shutting down`);
  server.close();
  const { stopWorkers } = await import("./workers/index.js");
  await Promise.all([stopWorkers(), stopScheduler()]);
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
