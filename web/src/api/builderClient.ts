// ---------------------------------------------------------------------------
// Builder API client — Phase 10
// ---------------------------------------------------------------------------
// Mutations use plain fetch (not useQuery) since they're one-shot.
// Queries use TanStack Query. Polling only on execution summary.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { POLL_INTERVAL_MS } from "./client";
import type {
  CampaignListItem,
  CampaignDetail,
  WorkflowDetail,
  WorkflowVersion,
  WorkflowExecutionSummary,
  CreatorItem,
  CreatorImportRow,
  CreatorImportResponse,
  DraftNode,
  PublishResponse,
  EnrollResponse,
  LaunchResponse,
  ValidationResponse,
  TemplateKey,
  ManualQueueResponse,
  NotifyResult,
} from "./builderTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.error ?? JSON.stringify(j);
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail}`.trim());
  }
  // No body to parse (e.g. 204 No Content from DELETE) — calling res.json()
  // on an empty body throws a SyntaxError, so short-circuit here.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function putJson<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () => apiFetch<CampaignListItem[]>("/api/campaigns"),
  });
}

export function useCampaign(id: string | null) {
  return useQuery({
    queryKey: ["campaign", id],
    queryFn: () => apiFetch<CampaignDetail>(`/api/campaigns/${id}`),
    enabled: !!id,
  });
}

export function createCampaign(data: {
  name: string;
  brand: string;
  objective?: string;
  notes?: string;
  notifyEmail?: string;
  brandDescription?: string;
  deliverables?: string;
  timeline?: string;
  rewardDescription?: string;
  shipsPhysicalProduct?: boolean;
}) {
  return postJson<{ id: string; name: string }>("/api/campaigns", data);
}

export function updateCampaign(
  id: string,
  data: {
    notifyEmail?: string | null;
    objective?: string | null;
    notes?: string | null;
    brandDescription?: string | null;
    deliverables?: string | null;
    timeline?: string | null;
    rewardDescription?: string | null;
    shipsPhysicalProduct?: boolean;
  },
) {
  return apiFetch<{ id: string; notifyEmail: string | null }>(`/api/campaigns/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteCampaign(id: string): Promise<void> {
  return apiFetch<void>(`/api/campaigns/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export function useWorkflow(id: string | null) {
  return useQuery({
    queryKey: ["workflow", id],
    queryFn: () => apiFetch<WorkflowDetail>(`/api/workflows/${id}`),
    enabled: !!id,
  });
}

export function useWorkflowVersions(id: string | null) {
  return useQuery({
    queryKey: ["workflow-versions", id],
    queryFn: () => apiFetch<WorkflowVersion[]>(`/api/workflows/${id}/versions`),
    enabled: !!id,
  });
}

export function useWorkflowExecution(id: string | null) {
  return useQuery({
    queryKey: ["workflow-execution", id],
    queryFn: () => apiFetch<WorkflowExecutionSummary>(`/api/workflows/${id}/execution`),
    enabled: !!id,
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: (prev) => prev,
  });
}

export function createWorkflowForCampaign(
  campaignId: string,
  data: { name: string; templateKey: TemplateKey },
) {
  return postJson<{ id: string; name: string; draftNodes: DraftNode[] }>(
    `/api/campaigns/${campaignId}/workflows`,
    data,
  );
}

export function saveDraft(workflowId: string, nodes: DraftNode[]) {
  return putJson<{
    id: string;
    draftNodes: DraftNode[];
    valid: boolean;
    validationErrors: string[];
    updatedAt: string;
  }>(`/api/workflows/${workflowId}/draft`, { nodes });
}

export function validateWorkflow(workflowId: string) {
  return postJson<ValidationResponse>(`/api/workflows/${workflowId}/validate`, {});
}

export function publishWorkflow(workflowId: string, notes?: string) {
  return postJson<PublishResponse>(`/api/workflows/${workflowId}/publish`, {
    notes: notes ?? null,
  });
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

export function useCreators() {
  return useQuery({
    queryKey: ["creators"],
    queryFn: () => apiFetch<CreatorItem[]>("/api/creators"),
  });
}

/** Bulk-import creators from parsed CSV rows. Caller should invalidate the
 * ["creators"] query afterward (see useBuilderInvalidator.invalidateCreators). */
export function importCreators(rows: CreatorImportRow[]) {
  return postJson<CreatorImportResponse>("/api/creators/import", { rows });
}

// ---------------------------------------------------------------------------
// Uploads (Phase 16 — Content Brief PDF)
// ---------------------------------------------------------------------------

export interface UploadResponse {
  /** The stored reference to persist in node config. */
  reference: string;
  /** The original filename, for display + the email attachment. */
  originalName: string;
  size: number;
}

/** Upload a single PDF file. Returns the stored reference to persist in config. */
export async function uploadFile(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  // Note: do NOT set Content-Type — the browser sets the multipart boundary.
  return apiFetch<UploadResponse>("/api/uploads", { method: "POST", body: form });
}

// ---------------------------------------------------------------------------
// Enroll + Launch
// ---------------------------------------------------------------------------

export function enrollCreators(workflowId: string, creatorIds: string[]) {
  return postJson<EnrollResponse>(`/api/workflows/${workflowId}/enroll`, { creatorIds });
}

export function launchWorkflow(workflowId: string) {
  return postJson<LaunchResponse>(`/api/workflows/${workflowId}/launch`, {});
}

// ---------------------------------------------------------------------------
// Manual Queue (Phase 11)
// ---------------------------------------------------------------------------

export function useManualQueue(workflowId: string | null) {
  return useQuery({
    queryKey: ["manual-queue", workflowId],
    queryFn: () =>
      apiFetch<ManualQueueResponse>(`/api/manual-queue/workflows/${workflowId}`),
    enabled: !!workflowId,
    refetchInterval: POLL_INTERVAL_MS,
    placeholderData: (prev) => prev,
  });
}

export function notifyBrand(instanceId: string) {
  return postJson<NotifyResult>(`/api/manual-queue/instances/${instanceId}/notify`, {});
}

// ---------------------------------------------------------------------------
// Query invalidation helpers
// ---------------------------------------------------------------------------

export function useBuilderInvalidator(workflowId: string | null) {
  const qc = useQueryClient();
  return {
    invalidateWorkflow: () => qc.invalidateQueries({ queryKey: ["workflow", workflowId] }),
    invalidateVersions: () =>
      qc.invalidateQueries({ queryKey: ["workflow-versions", workflowId] }),
    invalidateExecution: () =>
      qc.invalidateQueries({ queryKey: ["workflow-execution", workflowId] }),
    invalidateManualQueue: () =>
      qc.invalidateQueries({ queryKey: ["manual-queue", workflowId] }),
    invalidateCampaigns: () => qc.invalidateQueries({ queryKey: ["campaigns"] }),
    invalidateCreators: () => qc.invalidateQueries({ queryKey: ["creators"] }),
  };
}
