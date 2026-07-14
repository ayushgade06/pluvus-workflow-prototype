// ---------------------------------------------------------------------------
// LLM usage sink (HARD-O1) — parse + persist the `llmUsage` block the agent
// service returns on every /classify, /negotiate, /draft response.
// ---------------------------------------------------------------------------
// The agent's own telemetry is an in-process ring buffer: it dies on restart
// and cannot say WHICH instance a call served. This module is the server-side
// counterpart that makes usage durable and attributable:
//
//   * runWithLlmAttribution(instanceId, fn) — an AsyncLocalStorage scope set at
//     the single seam every agent call flows through (WorkflowRuntime.dispatch),
//     so the sink knows the instance without threading an id through the
//     IAgentProvider interface and every executor signature.
//   * recordAgentLlmUsage(role, data) — called by the LangGraph providers with
//     the raw agent response JSON; validates the llmUsage.calls array and
//     inserts LlmCall rows. Best-effort BY DESIGN: it never throws and is
//     awaited nowhere on the money path — a telemetry failure must degrade
//     reporting, never a workflow step.
//
// Under NODE_ENV=test the sink is a no-op (unit tests mock fetch on the
// providers and must not open a DB connection); set LLM_USAGE_PERSIST=true to
// force-enable it in a test-env harness that wants real rows.

import { AsyncLocalStorage } from "node:async_hooks";
import { createLlmCalls } from "../db/llmCalls.js";
import type { LlmCallInsert, LlmCallRole } from "../db/schema.js";

interface LlmAttributionContext {
  instanceId: string;
}

const attributionStore = new AsyncLocalStorage<LlmAttributionContext>();

/** Run fn with all agent LLM usage recorded against `instanceId`. */
export function runWithLlmAttribution<T>(instanceId: string, fn: () => T): T {
  return attributionStore.run({ instanceId }, fn);
}

/** The instance the current async execution is stepping, if any. */
export function currentLlmAttribution(): string | null {
  return attributionStore.getStore()?.instanceId ?? null;
}

// The wire shape of one call record inside llmUsage.calls (the Python
// LLMCallRecord dataclass, snake_case keys — see agent/app/telemetry.py).
function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asIntOrNull(v: unknown): number | null {
  const n = asFiniteNumber(v);
  return n === null ? null : Math.round(n);
}

/**
 * Validate the `llmUsage` block of an agent response into LlmCall insert rows.
 * Tolerant of absence (old agent, non-LLM early returns) and of garbage —
 * anything that doesn't look like a call record is dropped, never thrown on.
 * Exported for unit tests.
 */
export function parseLlmUsage(
  role: LlmCallRole,
  data: Record<string, unknown>,
  instanceId: string | null,
): LlmCallInsert[] {
  const usage = data["llmUsage"];
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return [];
  const calls = (usage as Record<string, unknown>)["calls"];
  if (!Array.isArray(calls)) return [];

  const rows: LlmCallInsert[] = [];
  for (const raw of calls) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const c = raw as Record<string, unknown>;
    const model = c["model"];
    const latency = asFiniteNumber(c["latency_ms"]);
    // model + latency are the only fields every record must carry; a record
    // without them is unusable for any aggregate and is dropped.
    if (typeof model !== "string" || model === "" || latency === null) continue;
    rows.push({
      instanceId,
      role,
      model,
      promptVersion: typeof c["prompt_version"] === "string" ? c["prompt_version"] : null,
      latencyMs: latency,
      inputTokens: asIntOrNull(c["input_tokens"]),
      outputTokens: asIntOrNull(c["output_tokens"]),
      totalTokens: asIntOrNull(c["total_tokens"]),
      estCostUsd: asFiniteNumber(c["est_cost_usd"]),
      ok: c["ok"] !== false,
      errorKind: typeof c["error_kind"] === "string" ? c["error_kind"] : null,
    });
  }
  return rows;
}

function persistenceEnabled(): boolean {
  if (process.env["LLM_USAGE_PERSIST"] === "true") return true;
  if (process.env["LLM_USAGE_PERSIST"] === "false") return false;
  return (process.env["NODE_ENV"] ?? "").toLowerCase() !== "test";
}

/**
 * Persist the LLM usage carried by one agent response, attributed to the
 * instance in the current attribution scope. Fire-and-forget: never throws,
 * never awaited on the request path — the insert races ahead on its own and
 * logs on failure.
 */
export function recordAgentLlmUsage(
  role: LlmCallRole,
  data: Record<string, unknown>,
): void {
  if (!persistenceEnabled()) return;
  const rows = parseLlmUsage(role, data, currentLlmAttribution());
  if (rows.length === 0) return;
  void createLlmCalls(rows).catch((err) => {
    console.error(
      `[llmUsage] failed to persist ${rows.length} ${role} call(s): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}
