// ---------------------------------------------------------------------------
// Observability routes (Phase 9, Part 8)
// ---------------------------------------------------------------------------
// Read-only endpoints powering the workflow dashboard. All responses are DTOs
// (see observability/dto.ts) — no raw Prisma objects are serialized.
//
//   GET /observability/workflow        node/state counts + summary
//   GET /observability/instances       filter + search + paginate
//   GET /observability/instances/:id   detail (messages, events, decisions)
//   GET /observability/timeline/:id    chronological event stream
//   GET /observability/logs/:id        transition trace (source/worker/job)
//   GET /observability/meta            static state metadata for the canvas

import { Router } from "express";
import type { InstanceState } from "@prisma/client";
import {
  getWorkflowSummary,
  listInstances,
  getInstanceDetail,
  getTimeline,
  getLogs,
} from "../observability/repository.js";
import { WORKFLOW_STATE_ORDER, TERMINAL_STATES, WAITING_STATES } from "../observability/dto.js";

const router = Router();

const VALID_STATES = new Set<string>(WORKFLOW_STATE_ORDER);

function parseState(raw: unknown): InstanceState | undefined {
  if (typeof raw === "string" && VALID_STATES.has(raw)) return raw as InstanceState;
  return undefined;
}

// ---------------------------------------------------------------------------
// GET /observability/meta
// ---------------------------------------------------------------------------
// Static metadata the canvas needs to lay itself out without hardcoding the
// state list on the frontend.

router.get("/meta", (_req, res) => {
  res.json({
    states: WORKFLOW_STATE_ORDER,
    terminalStates: TERMINAL_STATES,
    waitingStates: WAITING_STATES,
  });
});

// ---------------------------------------------------------------------------
// GET /observability/workflow
// ---------------------------------------------------------------------------

router.get("/workflow", async (_req, res) => {
  try {
    const summary = await getWorkflowSummary();
    res.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "workflow_summary_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/metrics  (HARD-S1)
// ---------------------------------------------------------------------------
// Worker-fleet metrics — queue depth per BullMQ queue + stuck-state counts — the
// scaffolding surface a monitoring backend / autoscaler scrapes. The same numbers
// are also logged on the scheduler cadence (workerMetrics.logWorkerMetrics). The
// load-test-to-1,000 acceptance criterion is the infra behind this, not the route.

router.get("/metrics", async (_req, res) => {
  try {
    const { collectWorkerMetrics } = await import("../workers/workerMetrics.js");
    res.json(await collectWorkerMetrics());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "worker_metrics_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/instances?state=&search=&page=&pageSize=
// ---------------------------------------------------------------------------

router.get("/instances", async (req, res) => {
  try {
    const state = parseState(req.query["state"]);
    if (req.query["state"] && !state) {
      res.status(400).json({ error: "invalid_state", value: req.query["state"] });
      return;
    }
    const search = typeof req.query["search"] === "string" ? req.query["search"] : undefined;
    const page = req.query["page"] ? Number(req.query["page"]) : undefined;
    const pageSize = req.query["pageSize"] ? Number(req.query["pageSize"]) : undefined;

    const result = await listInstances({
      ...(state ? { state } : {}),
      ...(search ? { search } : {}),
      ...(page && !Number.isNaN(page) ? { page } : {}),
      ...(pageSize && !Number.isNaN(pageSize) ? { pageSize } : {}),
    });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "instances_list_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/instances/:id
// ---------------------------------------------------------------------------

router.get("/instances/:id", async (req, res) => {
  try {
    const detail = await getInstanceDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: "instance_not_found", id: req.params.id });
      return;
    }
    res.json(detail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "instance_detail_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/timeline/:id
// ---------------------------------------------------------------------------

router.get("/timeline/:id", async (req, res) => {
  try {
    const timeline = await getTimeline(req.params.id);
    if (!timeline) {
      res.status(404).json({ error: "instance_not_found", id: req.params.id });
      return;
    }
    res.json(timeline);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "timeline_failed", message });
  }
});

// ---------------------------------------------------------------------------
// GET /observability/logs/:id
// ---------------------------------------------------------------------------

router.get("/logs/:id", async (req, res) => {
  try {
    const logs = await getLogs(req.params.id);
    if (!logs) {
      res.status(404).json({ error: "instance_not_found", id: req.params.id });
      return;
    }
    res.json(logs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "logs_failed", message });
  }
});

export default router;
