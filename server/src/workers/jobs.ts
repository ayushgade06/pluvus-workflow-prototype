// ---------------------------------------------------------------------------
// Job payload types for all Phase 4 queues
// ---------------------------------------------------------------------------

/**
 * Advance an execution instance by one step through the current node.
 *
 * idempotency key: `instanceId + expectedState`
 * The worker re-reads the instance state on entry and no-ops if it has already
 * moved past `expectedState`, so re-delivered jobs are harmless.
 */
export interface NodeExecutionJobData {
  instanceId: string;
  /**
   * The InstanceState the instance must be in for this job to execute.
   * If the instance is already in a different state when the job runs, it was
   * delivered more than once and the worker will skip it.
   */
  expectedState: string;
  /**
   * Opaque correlation id so each logical trigger produces exactly one job
   * even if the producer retries. BullMQ deduplicates on jobId.
   */
  triggerRef: string;
}

/**
 * Process an inbound email reply and advance the instance to REPLY_RECEIVED.
 *
 * idempotency key: `externalMessageId`
 * The worker checks whether a Message row with this externalMessageId already
 * exists before creating one, so a re-delivered job is a safe no-op.
 */
export interface InboundEmailJobData {
  instanceId: string;
  /** The Nylas (or mock) message id — globally unique per inbound email. */
  externalMessageId: string;
  threadId: string;
  subject: string;
  body: string;
  /**
   * The From: address of the inbound message (CRITICAL-1). Carried from the
   * webhook so the brand-decision handler can verify the reply originated from
   * the brand (campaign notifyEmail), not the creator. Optional: the mocked
   * injection path (queues route / harness) omits it, and a real webhook may
   * occasionally lack a parseable from — the handler treats a missing/mismatched
   * sender conservatively (does not auto-resolve on it).
   */
  senderEmail?: string;
  /**
   * Declared reply intent for Phase 4 (mocked).
   * Phase 6: real Nylas-webhook-originated jobs OMIT this field — the webhook
   * only ingests and correlates, it does not classify. The worker currently
   * defaults the intent to POSITIVE when absent; Phase 7 replaces that default
   * with a real LangGraph classify call. The field stays optional so both the
   * mocked-injection path (queues route / harness) and the real webhook path
   * share one job type.
   */
  mockIntent?: string;
}
