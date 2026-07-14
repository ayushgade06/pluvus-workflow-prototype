import { db } from "./drizzle.js";
import { llmCalls, type LlmCall, type LlmCallInsert } from "./schema.js";

// ---------------------------------------------------------------------------
// LlmCall — durable per-call LLM telemetry (HARD-O1).
// ---------------------------------------------------------------------------
// One row per LLM call the agent service made, parsed from the `llmUsage`
// block each agent response carries and attributed to the workflow instance
// whose step made the call. Written best-effort by the observability sink
// (observability/llmUsage.ts) — a failed insert degrades reporting, never the
// workflow. Read-side aggregation lives in observability/repository.ts.

export async function createLlmCalls(rows: LlmCallInsert[]): Promise<LlmCall[]> {
  if (rows.length === 0) return [];
  return db.insert(llmCalls).values(rows).returning();
}
