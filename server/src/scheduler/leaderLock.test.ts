/**
 * W-8 unit test — scheduler leader election.
 *
 * Proves the acquire/renew/release state machine (decideLeadership + the
 * module's _leaderToken) elects exactly one leader over a SHARED lease key, and
 * that a stalled leader loses the lease to a standby which then holds it.
 *
 * Uses a fake Redis that models one key with a token value + expiry, so the SET
 * NX and compare-and-extend semantics are exercised without a live Redis.
 *
 * Run:  npx tsx src/scheduler/leaderLock.test.ts
 */

import assert from "node:assert/strict";
import {
  decideLeadership,
  isLeader,
  _resetLeaderTokenForTest,
  _setTokenMinterForTest,
  type LeaderRedisOps,
} from "./lock.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// A fake shared Redis holding one lease key: { value: token, expiresAt: ms }.
// `now()` is injectable so we can expire the lease deterministically.
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number }>();
  now = 0;

  private live(key: string): { value: string; expiresAt: number } | null {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now) {
      this.store.delete(key);
      return null;
    }
    return e;
  }

  ops(): LeaderRedisOps {
    return {
      setNxPx: async (key, token, ttlMs) => {
        if (this.live(key)) return null; // key exists → NX fails
        this.store.set(key, { value: token, expiresAt: this.now + ttlMs });
        return "OK";
      },
      renew: async (key, token, ttlMs) => {
        const e = this.live(key);
        if (!e || e.value !== token) return 0; // not ours → can't extend
        e.expiresAt = this.now + ttlMs;
        return 1;
      },
    };
  }
}

async function main(): Promise<void> {
  // Distinct deterministic tokens per acquire so two "processes" don't collide.
  let tok = 0;
  _setTokenMinterForTest(() => `token-${++tok}`);

  const redis = new FakeRedis();
  const ops = redis.ops();

  // The module holds ONE _leaderToken (per-process). We simulate two processes
  // by resetting that token between calls — each reset = "a different process".

  await test("first caller acquires leadership", async () => {
    _resetLeaderTokenForTest();
    const got = await decideLeadership(ops);
    assert.equal(got, true, "uncontested acquire succeeds");
    assert.equal(isLeader(), true);
  });

  await test("the leader renews and stays leader", async () => {
    // Same process (token not reset) — should renew, not re-acquire.
    const beforeTok = tok;
    const got = await decideLeadership(ops);
    assert.equal(got, true, "renewal keeps leadership");
    assert.equal(tok, beforeTok, "no new token minted on a successful renew");
  });

  await test("a second process cannot acquire while the lease is held", async () => {
    _resetLeaderTokenForTest(); // simulate a DIFFERENT process (no cached token)
    const got = await decideLeadership(ops);
    assert.equal(got, false, "contended acquire fails — only one leader");
    assert.equal(isLeader(), false, "the loser does not believe it is leader");
  });

  await test("standby takes over after the leader's lease lapses", async () => {
    // Leader stalls past the lease: advance time beyond the 90s default TTL.
    redis.now += 90_001;
    // Standby (fresh process) now acquires the expired lease.
    _resetLeaderTokenForTest();
    const got = await decideLeadership(ops);
    assert.equal(got, true, "standby acquires once the old lease expired");
    assert.equal(isLeader(), true);
  });

  await test("a stale token cannot extend the standby's lease (fencing)", async () => {
    // The stalled ex-leader tries to renew with its OLD token while the standby
    // holds the lease. Compare-and-extend must reject it (token mismatch), so it
    // can't steal leadership back mid-lease.
    const wrongTokenRenew = await ops.renew("scheduler:leader", "token-1", 90_000);
    assert.equal(wrongTokenRenew, 0, "an outdated token cannot extend the current lease");
    // And a stale-token holder that resets and re-acquires is blocked while the
    // standby's lease is still live.
    _resetLeaderTokenForTest();
    const blocked = await decideLeadership(ops);
    assert.equal(blocked, false, "cannot re-acquire while the standby's lease is live");
  });

  console.log(`\n${n} passed\n`);
}

await main();
