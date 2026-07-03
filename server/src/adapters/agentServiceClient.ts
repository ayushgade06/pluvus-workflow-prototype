import { CircuitBreaker } from "./circuitBreaker.js";

// ---------------------------------------------------------------------------
// Shared agent-service HTTP client (FIX-12 auth, FIX-9 breaker/timeout)
// ---------------------------------------------------------------------------
// Centralizes how the TypeScript side talks to the Python agent service so that
// base-URL resolution, the shared-secret auth header, the request timeout, and
// the circuit breaker live in exactly one place instead of being copy-pasted
// across the classify / negotiate / draft providers.
//
//   AGENT_SERVICE_URL          — base URL of the agent service (default http://localhost:8000)
//   AGENT_API_KEY              — shared secret sent as `Authorization: Bearer <key>`
//                                (FIX-12). When unset, no auth header is sent —
//                                matches the agent service's env-gated auth.
//   AGENT_TIMEOUT_MS           — per-request timeout for the generation routes
//                                (/negotiate, /draft). Default 120000 (C3).
//                                RATIONALE: the Python side bounds each llm.invoke
//                                at LLM_INVOKE_TIMEOUT_SECONDS (default 60) and may
//                                retry up to `retries` times (structured.py). A
//                                local Qwen call is ~38s, so a single generation
//                                plus one repair retry can legitimately take ~80s.
//                                The old 30000 default aborted the HTTP request
//                                before even the FIRST generation finished, which
//                                tripped the breaker and dumped every turn to
//                                MANUAL_REVIEW. The abort MUST exceed the slowest
//                                provider's realistic invoke budget or the Python
//                                retry logic can never help.
//   AGENT_CLASSIFY_TIMEOUT_MS  — shorter per-request timeout for /classify only
//                                (default 45000). Classification is a single short
//                                generation on the interactive reply path, so it
//                                should fail fast rather than hold a worker as long
//                                as a full draft. Still comfortably above one Qwen
//                                call (~38s) so a normal classify completes.
//   AGENT_CB_FAILURE_THRESHOLD — consecutive failures that open the breaker (default 5)
//   AGENT_CB_COOLDOWN_MS       — how long the breaker stays open before a probe (default 30000)

export function agentBaseUrl(override?: string): string {
  return (override ?? process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000").replace(/\/$/, "");
}

// Parse a positive-number env var, falling back to `fallback` when unset/invalid.
function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Default request timeout for the generation routes (negotiate/draft). Must be
// large enough for the Python side's invoke budget × retries (see the env doc
// above) so a slow local model isn't aborted mid-generation.
const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
// Shorter default for the fast interactive classify route.
const DEFAULT_CLASSIFY_TIMEOUT_MS = 45_000;

export function agentTimeoutMs(): number {
  return positiveEnvMs("AGENT_TIMEOUT_MS", DEFAULT_AGENT_TIMEOUT_MS);
}

/** Per-request timeout in ms, honoring an explicit override, else the default. */
export function resolveTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  return agentTimeoutMs();
}

/**
 * Classify-route timeout: AGENT_CLASSIFY_TIMEOUT_MS if set, else the shorter
 * default. Exposed so the classify provider can opt into fail-fast behavior
 * without holding a worker as long as a full draft generation.
 */
export function classifyTimeoutMs(): number {
  return positiveEnvMs("AGENT_CLASSIFY_TIMEOUT_MS", DEFAULT_CLASSIFY_TIMEOUT_MS);
}

function authHeaders(): Record<string, string> {
  const key = process.env["AGENT_API_KEY"];
  return key ? { authorization: `Bearer ${key}` } : {};
}

// One breaker guards the whole agent service (it is a single backend). Lazily
// constructed so it picks up env at first use; reusable across all three routes.
let _breaker: CircuitBreaker | null = null;

function breaker(): CircuitBreaker {
  if (_breaker === null) {
    const threshold = Number(process.env["AGENT_CB_FAILURE_THRESHOLD"]);
    const cooldown = Number(process.env["AGENT_CB_COOLDOWN_MS"]);
    _breaker = new CircuitBreaker("agent-service", {
      failureThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 5,
      cooldownMs: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : 30_000,
    });
  }
  return _breaker;
}

/** Test/ops helper: reset the shared agent-service breaker. */
export function resetAgentBreaker(): void {
  _breaker?.reset();
  _breaker = null;
}

/**
 * POST JSON to an agent-service path and return the parsed body.
 *
 * Wrapped in the shared circuit breaker (FIX-9): once the agent service has
 * failed `AGENT_CB_FAILURE_THRESHOLD` times in a row, further calls fast-fail
 * with OpenCircuitError until the cooldown elapses, instead of hammering a dead
 * backend. Throws on non-2xx, transport failure, or timeout (all count as
 * failures toward the breaker). The auth header and timeout are applied here so
 * every caller is consistent.
 */
export async function agentPostJson(
  baseUrl: string,
  path: string,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<Record<string, unknown>> {
  return breaker().run(async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolveTimeoutMs(opts?.timeoutMs)),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`agent service ${path} returned ${res.status}: ${text}`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
    }

    return (await res.json()) as Record<string, unknown>;
  });
}
