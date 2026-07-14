// ---------------------------------------------------------------------------
// API client + TanStack Query hooks (Phase 9)
// ---------------------------------------------------------------------------
// All requests go through the Vite proxy: /api → http://localhost:3001.
// Polling lives here (refetchInterval) so the dashboard "feels alive" without
// any websocket plumbing — Part 2 target is a 5–10s refresh.

import { useQuery } from "@tanstack/react-query";
import type {
  WorkflowSummary,
  InstanceList,
  InstanceDetail,
  Timeline,
  Logs,
  InstanceState,
  LlmUsageSummary,
} from "./types";

const BASE = "/api/observability";

// Live-refresh cadence for the canvas + queue views (Part 2: 5–10s).
export const POLL_INTERVAL_MS = 6000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText} ${detail}`.trim());
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useWorkflowSummary() {
  return useQuery({
    queryKey: ["workflow-summary"],
    queryFn: () => getJson<WorkflowSummary>(`${BASE}/workflow`),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useLlmUsage() {
  return useQuery({
    queryKey: ["llm-usage"],
    queryFn: () => getJson<LlmUsageSummary>(`${BASE}/llm`),
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useInstances(params: {
  state?: InstanceState | undefined;
  search?: string | undefined;
}) {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.search) qs.set("search", params.search);
  qs.set("pageSize", "200");
  const query = qs.toString();
  return useQuery({
    queryKey: ["instances", params.state ?? null, params.search ?? null],
    queryFn: () => getJson<InstanceList>(`${BASE}/instances?${query}`),
    // Poll the drilldown too, so creators appear/leave a node live.
    refetchInterval: POLL_INTERVAL_MS,
    // Keep showing the previous list while refetching to avoid flicker.
    placeholderData: (prev) => prev,
  });
}

export function useInstanceDetail(id: string | null) {
  return useQuery({
    queryKey: ["instance", id],
    queryFn: () => getJson<InstanceDetail>(`${BASE}/instances/${id}`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useTimeline(id: string | null) {
  return useQuery({
    queryKey: ["timeline", id],
    queryFn: () => getJson<Timeline>(`${BASE}/timeline/${id}`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
  });
}

export function useLogs(id: string | null) {
  return useQuery({
    queryKey: ["logs", id],
    queryFn: () => getJson<Logs>(`${BASE}/logs/${id}`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
