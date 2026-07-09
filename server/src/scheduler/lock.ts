import { createClient } from "redis";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Redis instance lock (HARD-R2 — made sound)
// ---------------------------------------------------------------------------
// Per-instance distributed lock using Redis SET NX PX, hardened so it can never
// silently corrupt another worker's step:
//
//   1. FENCING TOKEN — acquireLock stores a unique token as the lock VALUE and
//      returns it. releaseLock only deletes the key if the stored value still
//      matches that token (compare-and-delete via a Lua script). Previously the
//      release did an unconditional DEL, so if worker A's step overran the TTL,
//      the lock expired, worker B acquired it, and A's `finally { releaseLock }`
//      then deleted B's lock — letting a THIRD worker in while B was mid-step.
//
//   2. TTL ≥ worst-case step — a negotiation step can take one 120s agent call
//      plus up to DRAFT_MAX_ATTEMPTS draft retries (agentServiceClient timeout ×
//      retries). 30s was far below that, so the lock routinely expired mid-step.
//      Sized to comfortably exceed the worst-case single step.
//
// ── What the lock is NOT ────────────────────────────────────────────────────
// The lock is a best-effort OPTIMIZATION to reduce wasted duplicate work, NOT the
// correctness guarantee. The real guarantees are:
//   - OCC (updateInstanceStateConditional): a state write only commits if the
//     instance is still in the expected state, so two workers can never both
//     advance the same instance — the loser gets StaleInstanceError.
//   - sendOnce (idempotentSend): reserve-before-send with a unique idempotency
//     key, so an email is sent at most once even across retries.
// Because of these, a lost/expired/stolen lock degrades to (at worst) some
// duplicated work that OCC + sendOnce then no-op — never a double-send or a
// double-transition. That is why the fencing token matters (it prevents a stale
// releaser from freeing an active lock) but a missed lock does not.

// TTL must exceed the worst-case single stepInstance() call. A negotiation step
// is the longest: one agent call plus up to a few draft retries at ~120s each.
// 6 minutes leaves generous headroom; OCC is the backstop if a step somehow runs
// even longer and the lock lapses.
const LOCK_TTL_MS = 360_000;

function lockKey(instanceId: string): string {
  return `instance:${instanceId}`;
}

// Compare-and-delete: only DEL the key if its value equals the caller's fencing
// token (i.e. the caller still owns the lock). Atomic under Redis single-threaded
// execution, so there is no check-then-delete race.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// Lazy singleton Redis client for lock operations.
// We use the `redis` package (node-redis) directly so we don't conflict with
// BullMQ's bundled ioredis instance.
let _client: ReturnType<typeof createClient> | null = null;

function getClient(): ReturnType<typeof createClient> {
  if (_client) return _client;
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  _client = createClient({ url });
  _client.on("error", (err: Error) => {
    console.error("[scheduler/lock] Redis client error:", err.message);
  });
  // Connect is async; we call connectIfNeeded before each operation.
  return _client;
}

async function connectIfNeeded(): Promise<ReturnType<typeof createClient>> {
  const client = getClient();
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

/**
 * Attempt to acquire the lock for `instanceId`.
 *
 * Returns a fencing token (an opaque string) when acquired, or null when another
 * process already holds it. The caller MUST pass the returned token back to
 * releaseLock so only the true owner can free the lock:
 *
 *   const token = await acquireLock(id);
 *   if (!token) throw ...;   // busy — let the job retry (see CRITICAL-6)
 *   try { ... } finally { await releaseLock(id, token); }
 */
export async function acquireLock(instanceId: string): Promise<string | null> {
  const client = await connectIfNeeded();
  const token = randomUUID();
  const result = await client.set(lockKey(instanceId), token, {
    NX: true,
    PX: LOCK_TTL_MS,
  });
  return result === "OK" ? token : null;
}

/**
 * Release the lock for `instanceId` IFF the caller still owns it (its `token`
 * matches the stored value). A no-op if the lock has already expired, was never
 * held, or is now held by someone else — this is the fencing that stops a worker
 * whose step overran the TTL from deleting a successor's freshly-acquired lock.
 *
 * `token` is the value returned by acquireLock. Passing an empty/wrong token can
 * never free another holder's lock.
 */
export async function releaseLock(instanceId: string, token: string): Promise<void> {
  if (!token) return;
  const client = await connectIfNeeded();
  await client.eval(RELEASE_SCRIPT, {
    keys: [lockKey(instanceId)],
    arguments: [token],
  });
}

/**
 * Unconditionally clear the lock for `instanceId`, ignoring ownership.
 *
 * ONLY for test/harness setup/teardown where a lingering lock from a prior
 * scenario must be cleared before a fresh run. Production code MUST use the
 * token-checked releaseLock so it can never free an active holder's lock.
 */
export async function forceReleaseLock(instanceId: string): Promise<void> {
  const client = await connectIfNeeded();
  await client.del(lockKey(instanceId));
}

/**
 * Close the Redis client. Call during graceful shutdown.
 */
export async function closeLockClient(): Promise<void> {
  if (_client?.isOpen) {
    await _client.quit();
    _client = null;
  }
}
