import { createClient } from "redis";

// ---------------------------------------------------------------------------
// Redis instance lock
// ---------------------------------------------------------------------------
// Provides per-instance distributed locking using Redis SET NX PX.
// TTL is 30 s — long enough for a single stepInstance() call to complete.
//
// Usage pattern:
//   const acquired = await acquireLock(instanceId);
//   if (!acquired) return; // another worker holds the lock
//   try { ... } finally { await releaseLock(instanceId); }

const LOCK_TTL_MS = 30_000;

function lockKey(instanceId: string): string {
  return `instance:${instanceId}`;
}

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
 * Returns true if acquired, false if another process holds it.
 */
export async function acquireLock(instanceId: string): Promise<boolean> {
  const client = await connectIfNeeded();
  const result = await client.set(lockKey(instanceId), "1", {
    NX: true,
    PX: LOCK_TTL_MS,
  });
  return result === "OK";
}

/**
 * Release the lock for `instanceId`.
 * No-op if the lock has already expired or was never held.
 */
export async function releaseLock(instanceId: string): Promise<void> {
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
