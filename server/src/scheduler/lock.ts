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

// ---------------------------------------------------------------------------
// Scheduler leader lock (W-8)
// ---------------------------------------------------------------------------
// A single renewable lease that elects ONE active scheduler among any number of
// PROCESS_ROLE=scheduler processes. Without it, two schedulers both poll and
// both reconcile: sendOnce still prevents duplicate EMAILS and OCC prevents
// duplicate TRANSITIONS, but the agent (LLM) call inside an executor runs BEFORE
// the OCC check — so a double-fire means real duplicate LLM spend even though no
// duplicate side effect reaches a creator. The leader lock removes that waste.
//
// Mechanism (mirrors the instance lock above): a fixed key holds a per-process
// fencing token. acquire = SET NX PX; renew = compare-and-extend PEXPIRE only if
// the stored token is still ours; release = compare-and-delete. A leader that
// stalls past the lease loses it, a standby takes over, and the stalled ex-leader
// can neither renew nor release the new leader's lease (token mismatch).
//
// SAFETY NOTE: like the instance lock, this is an OPTIMIZATION, not a correctness
// guarantee. A brief two-leader overlap (clock skew, a missed renewal) at worst
// wastes one extra poll's LLM calls; OCC + sendOnce still guarantee no duplicate
// transition or email. So a conservative lease + per-cycle renewal is enough — we
// don't need consensus.

const LEADER_KEY = "scheduler:leader";

// The lease must outlive one full poll cycle (reconcile + metrics + due-scan +
// enqueues) with headroom, or a slow tick would drop leadership mid-cycle and let
// a standby double-poll. Default 90s for the 30s poll cadence; env-tunable.
function leaderTtlMs(): number {
  const raw = Number(process.env["SCHEDULER_LEADER_TTL_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
}

// Compare-and-extend: refresh the TTL only if we still hold the lease (token
// matches). Returns 1 on success, 0 if we no longer own it.
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

// This process's leader fencing token, set once acquired, cleared on loss/release.
let _leaderToken: string | null = null;

// The minimal Redis surface the leadership logic needs. Extracted so the
// acquire/renew state machine can be unit-tested with a fake, without a live
// Redis (the production path binds this to the real node-redis client).
export interface LeaderRedisOps {
  /** SET key token NX PX ttl → "OK" when acquired, null when the key exists. */
  setNxPx(key: string, token: string, ttlMs: number): Promise<"OK" | null>;
  /** Compare-and-extend: PEXPIRE only if the stored value equals token → 1/0. */
  renew(key: string, token: string, ttlMs: number): Promise<number>;
}

// Injectable token generator so a test can make tokens deterministic; production
// uses randomUUID.
let _mintToken: () => string = randomUUID;

/**
 * Pure-ish leadership decision over an injected Redis surface. Mutates the
 * module-level `_leaderToken` (this process's claim) and returns whether we hold
 * the lease after the call. Kept separate from the client wiring so it is
 * testable; `acquireOrRenewLeadership` binds it to the real client.
 */
export async function decideLeadership(ops: LeaderRedisOps): Promise<boolean> {
  const ttl = leaderTtlMs();

  if (_leaderToken) {
    // We think we're the leader — try to renew. If renewal fails we lost the
    // lease (expired + taken over), so drop our claim and fall through to a
    // fresh acquire attempt.
    const renewed = await ops.renew(LEADER_KEY, _leaderToken, ttl);
    if (renewed === 1) return true;
    _leaderToken = null;
  }

  // Not (or no longer) leader — attempt a fresh acquire.
  const token = _mintToken();
  const result = await ops.setNxPx(LEADER_KEY, token, ttl);
  if (result === "OK") {
    _leaderToken = token;
    return true;
  }
  return false;
}

/**
 * Try to become (or remain) the active scheduler leader for one poll cycle.
 *
 * Returns true when this process holds the lease after the call:
 *   - first time: SET NX succeeds → we are the new leader;
 *   - subsequent: we still own it → renew (extend the TTL) → stay leader;
 *   - contested: another process holds it → return false, caller skips this poll.
 *
 * On any Redis error this returns false (do NOT poll): if Redis is unreachable
 * the scheduler can't enqueue anyway (BullMQ needs Redis), so skipping is the
 * safe, side-effect-free choice — never assume leadership blind.
 */
export async function acquireOrRenewLeadership(): Promise<boolean> {
  try {
    const client = await connectIfNeeded();
    const ops: LeaderRedisOps = {
      setNxPx: (key, token, ttlMs) =>
        client.set(key, token, { NX: true, PX: ttlMs }) as Promise<"OK" | null>,
      renew: (key, token, ttlMs) =>
        client.eval(RENEW_SCRIPT, {
          keys: [key],
          arguments: [token, String(ttlMs)],
        }) as Promise<number>,
    };
    return await decideLeadership(ops);
  } catch (err) {
    console.error(
      "[scheduler/lock] leadership acquire/renew failed:",
      err instanceof Error ? err.message : err,
    );
    // Lost confidence in our lease state — clear it so we must re-acquire cleanly.
    _leaderToken = null;
    return false;
  }
}

// Test helper: override the token generator for deterministic tokens in tests.
export function _setTokenMinterForTest(fn: () => string): void {
  _mintToken = fn;
}

/** True if this process currently believes it holds the leader lease. */
export function isLeader(): boolean {
  return _leaderToken !== null;
}

/**
 * Release leadership IFF we still own it (compare-and-delete), so a standby can
 * take over immediately on graceful shutdown instead of waiting for the lease to
 * lapse. Best-effort — a failure just means the lease expires on its own.
 */
export async function releaseLeadership(): Promise<void> {
  const token = _leaderToken;
  _leaderToken = null;
  if (!token) return;
  try {
    const client = await connectIfNeeded();
    await client.eval(RELEASE_SCRIPT, {
      keys: [LEADER_KEY],
      arguments: [token],
    });
  } catch (err) {
    console.error(
      "[scheduler/lock] leadership release failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Test helper: forget this process's cached leader token WITHOUT touching Redis,
// so a test can simulate "this process lost/never had leadership".
export function _resetLeaderTokenForTest(): void {
  _leaderToken = null;
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
