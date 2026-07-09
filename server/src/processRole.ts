// ---------------------------------------------------------------------------
// Process role resolution (HARD-A1)
// ---------------------------------------------------------------------------
// One codebase, three deployable roles. PROCESS_ROLE selects which components a
// process runs so the API, the worker fleet, and the scheduler can be scaled and
// restarted independently (the audit's split-topology finding: API + both
// workers + the 30s scheduler all ran in ONE process, so N API replicas = N
// schedulers/pollers all polling the same due instances).
//
//   PROCESS_ROLE=api        → HTTP API only
//   PROCESS_ROLE=worker     → BullMQ workers only (scale this horizontally)
//   PROCESS_ROLE=scheduler  → the single-leader poller/scheduler ONLY (run ONE)
//   PROCESS_ROLE=all        → everything in one process (DEFAULT — local dev /
//                             single-node; identical to the pre-split behavior)
//
// Default is `all` so existing single-process deploys, `npm start`, and tests
// are unchanged. A multi-instance deploy sets the role per service (see
// docker-compose.yml) and MUST run exactly one `scheduler`.

export type ProcessRole = "api" | "worker" | "scheduler" | "all";

const VALID: ReadonlySet<ProcessRole> = new Set(["api", "worker", "scheduler", "all"]);

/** Resolve the role from an explicit value; unknown/unset → "all". Pure. */
export function resolveProcessRole(explicit: string | undefined): ProcessRole {
  const v = (explicit ?? "").trim().toLowerCase();
  return VALID.has(v as ProcessRole) ? (v as ProcessRole) : "all";
}

export function processRole(): ProcessRole {
  const raw = process.env["PROCESS_ROLE"];
  const role = resolveProcessRole(raw);
  if (raw !== undefined && raw.trim() !== "" && !VALID.has(raw.trim().toLowerCase() as ProcessRole)) {
    console.warn(`[processRole] unknown PROCESS_ROLE="${raw}" — defaulting to "all"`);
  }
  return role;
}

export const runsApi = (r: ProcessRole): boolean => r === "api" || r === "all";
export const runsWorkers = (r: ProcessRole): boolean => r === "worker" || r === "all";
export const runsScheduler = (r: ProcessRole): boolean => r === "scheduler" || r === "all";
