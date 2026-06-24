import { Router, type Request, type Response } from "express";
import { verifyNylasSignature } from "../providers/nylas/verifySignature.js";
import { findMessagesByThreadId } from "../db/index.js";
import { enqueueInboundEmail } from "../workers/queues.js";

// ---------------------------------------------------------------------------
// Nylas webhook intake — POST/GET /webhooks/nylas
// ---------------------------------------------------------------------------
// Responsibilities (and only these):
//   1. GET  — echo the `challenge` query param so Nylas can verify the endpoint.
//   2. POST — verify the X-Nylas-Signature over the RAW body, extract the
//      inbound message, correlate it to an ExecutionInstance by threadId, and
//      enqueue an inbound-email job. Then ack 200 fast.
//
// What it deliberately does NOT do (preserves existing invariants):
//   - No classification, no state transition. Workers remain the only writers
//     of execution-instance state; the webhook is just a queue producer.
//   - No heavy work before the ack. Nylas requires a 200 within ~10s.
//
// Idempotency for duplicate deliveries is handled downstream:
//   - enqueueInboundEmail builds jobId = inbound|<externalMessageId>, so BullMQ
//     drops a duplicate enqueue.
//   - inboundEmailWorker re-checks findMessageByExternalId before processing.
//   - Message.externalMessageId is @unique as the final backstop.
//
// IMPORTANT: this router must be mounted with a RAW body parser (express.raw),
// not express.json — signature verification needs the exact bytes Nylas sent.

const router = Router();

// ── Extracted, normalized inbound message ──────────────────────────────────
interface InboundMessage {
  messageId: string;
  threadId: string | undefined;
  subject: string;
  body: string;
}

// Tolerate both snake_case (raw Nylas webhook JSON) and camelCase (SDK-shaped).
function pick<T = unknown>(
  obj: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

/**
 * Pull the fields we need out of a Nylas webhook payload.
 * Returns null if this isn't a message-bearing event we can act on.
 */
function extractInboundMessage(payload: unknown): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as Record<string, unknown>)["data"];
  if (!data || typeof data !== "object") return null;

  const object = (data as Record<string, unknown>)["object"];
  if (!object || typeof object !== "object") return null;
  const msg = object as Record<string, unknown>;

  const messageId = pick<string>(msg, "id", "message_id", "messageId");
  if (!messageId) return null;

  return {
    messageId,
    threadId: pick<string>(msg, "thread_id", "threadId"),
    subject: pick<string>(msg, "subject") ?? "",
    body: pick<string>(msg, "body", "snippet") ?? "",
  };
}

// ── GET: endpoint verification challenge ───────────────────────────────────
router.get("/nylas", (req: Request, res: Response) => {
  const challenge = req.query["challenge"];
  if (typeof challenge === "string") {
    // Plain text, exact value, no quotes — per Nylas verification contract.
    res.status(200).type("text/plain").send(challenge);
    return;
  }
  res.status(400).json({ error: "missing challenge" });
});

// ── POST: inbound event ────────────────────────────────────────────────────
// Note: the raw parser leaves req.body as a Buffer. We verify over it, then
// JSON.parse it ourselves.
router.post("/nylas", async (req: Request, res: Response) => {
  const secret = process.env["NYLAS_WEBHOOK_SECRET"];
  const signature = req.header("x-nylas-signature");

  // req.body is a Buffer when mounted with express.raw(). Be defensive in case
  // a parser changed it.
  const rawBody: Buffer = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));

  // ── Verify authenticity ──────────────────────────────────────────────────
  if (!verifyNylasSignature(rawBody, signature, secret)) {
    console.warn("[webhook/nylas] rejected — invalid or missing signature");
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // ── Parse ────────────────────────────────────────────────────────────────
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid JSON" });
    return;
  }

  const inbound = extractInboundMessage(payload);
  if (!inbound) {
    // Not a message event we can act on (e.g. a non-message notification type).
    // Ack so Nylas doesn't retry; nothing to do.
    res.status(200).json({ status: "ignored", reason: "no actionable message" });
    return;
  }

  // ── Correlate to an instance by threadId ─────────────────────────────────
  // All messages in a conversation share the Nylas thread_id. The outbound
  // send persisted that thread_id on a Message row, so we look it up here.
  if (!inbound.threadId) {
    res.status(200).json({ status: "ignored", reason: "no threadId to correlate" });
    return;
  }

  const threadMessages = await findMessagesByThreadId(inbound.threadId);
  if (threadMessages.length === 0) {
    // A reply to a thread we never sent (or not ours). Drop, ack.
    console.log(
      `[webhook/nylas] no instance for thread ${inbound.threadId} — dropping ${inbound.messageId}`,
    );
    res.status(200).json({ status: "ignored", reason: "thread not found" });
    return;
  }

  // Every message in the thread belongs to the same instance; take any.
  const instanceId = threadMessages[0]!.instanceId;

  // ── Enqueue (the only side effect) ───────────────────────────────────────
  // No mockIntent — Phase 7 classifies the real reply in the worker.
  await enqueueInboundEmail({
    instanceId,
    externalMessageId: inbound.messageId,
    threadId: inbound.threadId,
    subject: inbound.subject,
    body: inbound.body,
  });

  console.log(
    `[webhook/nylas] enqueued inbound-email for instance ${instanceId} (msg ${inbound.messageId}, thread ${inbound.threadId})`,
  );

  // ── Ack fast ─────────────────────────────────────────────────────────────
  res.status(200).json({ status: "accepted", instanceId });
});

export default router;
