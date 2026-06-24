import { randomUUID } from "crypto";
import { Router } from "express";
import {
  getNodeExecutionQueue,
  getInboundEmailQueue,
  enqueueNodeExecution,
  enqueueInboundEmail,
} from "../workers/queues.js";
import { findInstanceById } from "../db/index.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /queues/health
// ---------------------------------------------------------------------------
// Returns live counts for both queues: waiting, active, completed, failed,
// delayed.  Useful for at-a-glance operational status.

router.get("/health", async (_req, res) => {
  try {
    const [nodeQ, inboundQ] = [getNodeExecutionQueue(), getInboundEmailQueue()];

    const [nodeCounts, inboundCounts] = await Promise.all([
      nodeQ.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
      inboundQ.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
    ]);

    res.json({
      status: "ok",
      queues: {
        "node-execution": nodeCounts,
        "inbound-email": inboundCounts,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ status: "error", message });
  }
});

// ---------------------------------------------------------------------------
// GET /queues/jobs
// ---------------------------------------------------------------------------
// Returns the most recent waiting + active + failed jobs for diagnostics.

router.get("/jobs", async (req, res) => {
  // Clamp to [1, 100]: limit-1 is passed as the Redis end index, so 0 would
  // become -1 which returns all jobs (Redis LRANGE 0 -1 semantics).
  const limit = Math.max(1, Math.min(Number(req.query["limit"] ?? 20), 100));

  try {
    const [nodeQ, inboundQ] = [getNodeExecutionQueue(), getInboundEmailQueue()];

    const [nodeWaiting, nodeActive, nodeFailed, inboundWaiting, inboundActive, inboundFailed] =
      await Promise.all([
        nodeQ.getWaiting(0, limit - 1),
        nodeQ.getActive(0, limit - 1),
        nodeQ.getFailed(0, limit - 1),
        inboundQ.getWaiting(0, limit - 1),
        inboundQ.getActive(0, limit - 1),
        inboundQ.getFailed(0, limit - 1),
      ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialize = (jobs: any[]) =>
      jobs.map((j) => ({
        id: j.id as string | undefined,
        name: j.name as string,
        data: j.data as unknown,
        attemptsMade: j.attemptsMade as number,
        processedOn: j.processedOn as number | undefined,
        finishedOn: j.finishedOn as number | undefined,
        failedReason: j.failedReason as string | undefined,
        timestamp: j.timestamp as number,
      }));

    res.json({
      "node-execution": {
        waiting: serialize(nodeWaiting),
        active: serialize(nodeActive),
        failed: serialize(nodeFailed),
      },
      "inbound-email": {
        waiting: serialize(inboundWaiting),
        active: serialize(inboundActive),
        failed: serialize(inboundFailed),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(503).json({ status: "error", message });
  }
});

// ---------------------------------------------------------------------------
// POST /queues/node-execution
// ---------------------------------------------------------------------------
// Manually enqueue a node-execution job (for testing / harness use).
//
// Body: { instanceId: string, triggerRef?: string }

router.post("/node-execution", async (req, res) => {
  const { instanceId, triggerRef } = req.body as {
    instanceId?: string;
    triggerRef?: string;
  };

  if (!instanceId) {
    res.status(400).json({ error: "instanceId is required" });
    return;
  }

  const instance = await findInstanceById(instanceId);
  if (!instance) {
    res.status(404).json({ error: `Instance not found: ${instanceId}` });
    return;
  }

  const ref = triggerRef ?? randomUUID();

  await enqueueNodeExecution({
    instanceId,
    expectedState: instance.currentState,
    triggerRef: ref,
  });

  res.status(202).json({
    queued: true,
    instanceId,
    expectedState: instance.currentState,
    triggerRef: ref,
  });
});

// ---------------------------------------------------------------------------
// POST /queues/inbound-email
// ---------------------------------------------------------------------------
// Inject a mocked inbound email event (Phase 4 / 5 testing).
//
// Body: {
//   instanceId: string,
//   subject?: string,
//   body?: string,
//   mockIntent?: "POSITIVE" | "NEGATIVE" | "QUESTION" | "OPT_OUT",
//   threadId?: string,
// }

router.post("/inbound-email", async (req, res) => {
  const {
    instanceId,
    subject = "Re: Collaboration opportunity",
    body = "Yes, I'm interested!",
    mockIntent = "POSITIVE",
    threadId,
  } = req.body as {
    instanceId?: string;
    subject?: string;
    body?: string;
    mockIntent?: string;
    threadId?: string;
  };

  if (!instanceId) {
    res.status(400).json({ error: "instanceId is required" });
    return;
  }

  const instance = await findInstanceById(instanceId);
  if (!instance) {
    res.status(404).json({ error: `Instance not found: ${instanceId}` });
    return;
  }

  const externalMessageId = `mock-inbound-${randomUUID()}`;
  const resolvedThreadId = threadId ?? `mock-thread-${instance.creatorId}`;

  await enqueueInboundEmail({
    instanceId,
    externalMessageId,
    threadId: resolvedThreadId,
    subject,
    body,
    mockIntent,
  });

  res.status(202).json({
    queued: true,
    instanceId,
    externalMessageId,
    mockIntent,
  });
});

export default router;
