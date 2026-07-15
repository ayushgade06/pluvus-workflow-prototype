import { startPoller, stopPoller } from "./poller.js";
import { closeLockClient, releaseLeadership } from "./lock.js";

// ---------------------------------------------------------------------------
// Scheduler facade
// ---------------------------------------------------------------------------
// Single entry point for Phase 5 scheduling. Wraps the poller start/stop and
// lock-client teardown so callers (index.ts) only interact with this module.

export function startScheduler(pollIntervalMs?: number): void {
  startPoller(pollIntervalMs);
}

export async function stopScheduler(): Promise<void> {
  stopPoller();
  // W-8: hand the leader lease back before closing the client, so a standby
  // scheduler can take over immediately instead of waiting for the lease to
  // lapse. Best-effort — releaseLeadership swallows its own errors.
  await releaseLeadership();
  await closeLockClient();
}
