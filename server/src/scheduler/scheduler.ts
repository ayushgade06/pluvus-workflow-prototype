import { startPoller, stopPoller } from "./poller.js";
import { closeLockClient } from "./lock.js";

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
  await closeLockClient();
}
