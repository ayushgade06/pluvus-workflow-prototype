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
   * Declared reply intent for Phase 4 (mocked).
   * In Phase 7 this will be omitted and classification will happen in the worker.
   */
  mockIntent?: string;
}
