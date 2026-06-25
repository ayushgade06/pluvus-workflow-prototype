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
//   AGENT_TIMEOUT_MS           — per-request timeout (default 30000; was a fixed
//                                120000). The interactive reply path should fail
//                                fast, not hold a worker for two minutes.
//   AGENT_CB_FAILURE_THRESHOLD — consecutive failures that open the breaker (default 5)
//   AGENT_CB_COOLDOWN_MS       — how long the breaker stays open before a probe (default 30000)

export function agentBaseUrl(override?: string): string {
  return (override ?? process.env["AGENT_SERVICE_URL"] ?? "http://localhost:8000").replace(/\/$/, "");
}

function agentTimeoutMs(): number {
  const raw = process.env["AGENT_TIMEOUT_MS"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
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
): Promise<Record<string, unknown>> {
  return breaker().run(async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(agentTimeoutMs()),
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
