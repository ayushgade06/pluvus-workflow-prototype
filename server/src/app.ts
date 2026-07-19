import express from "express";
import type { Express } from "express";
import path from "path";
import { sql } from "drizzle-orm";
import { db } from "./db/drizzle.js";
import queuesRouter from "./routes/queues.js";
import webhooksRouter from "./routes/webhooks.js";
import observabilityRouter from "./routes/observability.js";
import campaignsRouter from "./routes/campaigns.js";
import workflowsRouter from "./routes/workflows.js";
import manualQueueRouter from "./routes/manualQueue.js";
import creatorsRouter from "./routes/creators.js";
import paymentRouter from "./routes/payment.js";
import uploadsRouter from "./routes/uploads.js";
import trackingRouter from "./routes/tracking.js";
import attributionRouter from "./routes/attribution.js";
import partnershipsRouter from "./routes/partnerships.js";
import payoutsRouter from "./routes/payouts.js";
import payoutConfirmRouter from "./routes/payoutConfirm.js";
import { requireOperatorKey } from "./middleware/requireOperatorKey.js";

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

  // ---------------------------------------------------------------------------
  // /api prefix rewrite — mirrors the Vite dev proxy for production static builds.
  // In dev, Vite proxies /api/* → localhost:3001/* (stripping the prefix).
  // In production, Express serves the static build directly, so we replicate
  // that stripping here so the same relative URLs work in both environments.
  // ---------------------------------------------------------------------------
  app.use((req, _res, next) => {
    if (req.url.startsWith("/api/")) {
      req.url = req.url.slice(4); // "/api/foo" → "/foo"
    } else if (req.url === "/api") {
      req.url = "/";
    }
    next();
  });

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

  // DB health: verifies the db client can reach PostgreSQL.
  app.get("/health/db", async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: "ok", service: "database", timestamp: new Date().toISOString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: "error", service: "database", message });
    }
  });

  // -------------------------------------------------------------------------
  // P2 — operator-route gate. `requireOperatorKey` (X-Operator-Key vs
  // OPERATOR_API_KEY) is mounted on the OPERATOR routers only. The
  // creator/webhook-facing routers (/webhooks, /payment, /t, /attribution,
  // /payout) are intentionally left OPEN — a creator's email magic link and the
  // inbound webhooks must reach them with no operator key. See the route
  // inventory in the go-live plan (P2). Health endpoints above are also open
  // (uptime probes). Gating is open-when-unset in dev; the startup guard
  // (config/requiredSecrets.ts) refuses to boot in prod without the key.
  // -------------------------------------------------------------------------

  // OPERATOR routers (gated) --------------------------------------------------
  // Phase 4 — Queue routes (health/jobs leak internals; injection POSTs already
  // 404 in prod, gated here too for defense in depth).
  app.use("/queues", requireOperatorKey, queuesRouter);
  // Phase 9 — Observability dashboard APIs (leak every creator email/transcript/
  // payout destination).
  app.use("/observability", requireOperatorKey, observabilityRouter);
  // Phase 10 — Workflow Builder APIs (create + cascade-DELETE a campaign).
  app.use("/campaigns", requireOperatorKey, campaignsRouter);
  app.use("/workflows", requireOperatorKey, workflowsRouter);
  // Phase 11 — Manual Queue (escalated-creator data + notify mutation).
  app.use("/manual-queue", requireOperatorKey, manualQueueRouter);
  // Creator roster + CSV import — used by the enrollment UI.
  app.use("/creators", requireOperatorKey, creatorsRouter);
  // Phase 16 — Content Brief: brand file uploads (Campaign Brief PDF).
  app.use("/uploads", requireOperatorKey, uploadsRouter);
  app.use("/partnerships", requireOperatorKey, partnershipsRouter);
  // Phase 3 (Payout ledger) — brand-side payout actions: mark paid, resend,
  // settle money, PayPal CSV export. ALL operator (the creator-facing confirm/
  // dispute pages live on the SEPARATE /payout router below, left open).
  app.use("/payouts", requireOperatorKey, payoutsRouter);

  // OPEN routers (creator magic-link / webhooks / public — NEVER gated) --------
  // Phase 15 — Payment Info: hosted payout-information page (creator magic-link).
  app.use("/payment", paymentRouter);
  // Phase 2 (Attribution) — public short-link redirect + conversion webhook
  // (/attribution has its OWN X-Attribution-Secret gate, P1).
  app.use("/t", trackingRouter);
  app.use("/attribution", attributionRouter);
  // Phase 3 (Payout ledger) — creator-facing confirm/dispute magic-link pages
  // (GET renders, POST mutates — I-5). Token-gated; must reach creators with no
  // operator key. Distinct from the operator /payouts router above.
  app.use("/payout", payoutConfirmRouter);

  // ---------------------------------------------------------------------------
  // Static SPA serving (production only)
  // In development, Vite serves the frontend separately on its own port.
  // In production, Express serves the built web/dist directly after all API
  // routes so API paths are matched first.
  // ---------------------------------------------------------------------------
  if (process.env["NODE_ENV"] === "production") {
    const webDist = path.resolve(process.cwd(), "web/dist");
    app.use(express.static(webDist));
    // SPA catch-all: serve index.html for any unmatched GET so client-side
    // routing (React Router) handles the path.
    app.get("*", (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  return app;
}
