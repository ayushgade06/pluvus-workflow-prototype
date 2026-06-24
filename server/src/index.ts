import "dotenv/config";
import express from "express";
import { prisma } from "./db/index.js";
import queuesRouter from "./routes/queues.js";
import { startWorkers } from "./workers/index.js";

const app = express();
const port = process.env["PORT"] ? Number(process.env["PORT"]) : 3001;

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

startWorkers();

const server = app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});

// Graceful shutdown — stop accepting requests, drain workers, then exit.
async function shutdown(signal: string): Promise<void> {
  console.log(`[server] ${signal} received — shutting down`);
  server.close();
  const { stopWorkers } = await import("./workers/index.js");
  await stopWorkers();
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
