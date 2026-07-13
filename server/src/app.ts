import express from "express";
import type { Express } from "express";
import { prisma } from "./db/index.js";
import queuesRouter from "./routes/queues.js";
import webhooksRouter from "./routes/webhooks.js";
import observabilityRouter from "./routes/observability.js";
import campaignsRouter from "./routes/campaigns.js";
import workflowsRouter from "./routes/workflows.js";
import manualQueueRouter from "./routes/manualQueue.js";
import creatorsRouter from "./routes/creators.js";
import paymentRouter from "./routes/payment.js";
import uploadsRouter from "./routes/uploads.js";

// ---------------------------------------------------------------------------
// Express app factory (HARD-A1)
// ---------------------------------------------------------------------------
// The HTTP surface, extracted from index.ts so the API can be started as its
// OWN process (separate from the workers + scheduler) while all three share this
// one route wiring. Building the app is side-effect-free — it does NOT start
// workers, the scheduler, or the HTTP listener; the entrypoint owns that. This
// is the prerequisite for scaling the API independently of the worker fleet
// (HARD-S1) and running the scheduler as a single leader.

export function createApp(): Express {
  const app = express();

  // Webhooks (Phase 6) — MUST be mounted before express.json(). Nylas signs the
  // RAW request body; signature verification needs the exact bytes, so this route
  // uses a raw body parser. GET (challenge) carries no body, so the raw parser is
  // a harmless no-op there.
  app.use("/webhooks", express.raw({ type: "*/*", limit: "2mb" }), webhooksRouter);

  app.use(express.json());

  // Health endpoints
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "server", timestamp: new Date().toISOString() });
  });

  // DB health: verifies the Prisma client can reach PostgreSQL.
  app.get("/health/db", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ok", service: "database", timestamp: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: "error", service: "database", message });
    }
  });

  // Phase 4 — Queue routes
  app.use("/queues", queuesRouter);
  // Phase 9 — Observability dashboard APIs (read-only)
  app.use("/observability", observabilityRouter);
  // Phase 10 — Workflow Builder APIs
  app.use("/campaigns", campaignsRouter);
  app.use("/workflows", workflowsRouter);
  // Phase 11 — Manual Queue (escalated creators + brand notifications)
  app.use("/manual-queue", manualQueueRouter);
  // Creator roster + CSV import — used by the enrollment UI.
  app.use("/creators", creatorsRouter);
  // Phase 15 — Payment Info: hosted payout-information page (server-rendered)
  app.use("/payment", paymentRouter);
  // Phase 16 — Content Brief: brand file uploads (Campaign Brief PDF)
  app.use("/uploads", uploadsRouter);

  return app;
}
