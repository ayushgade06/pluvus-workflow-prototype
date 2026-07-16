// ---------------------------------------------------------------------------
// Partners API client — Phase 4
// ---------------------------------------------------------------------------
// Queries and mutations for the Partners dashboard (partnerships, payouts,
// obligations). Uses TanStack Query for reads; plain fetch for mutations.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  PartnershipListItem,
  PartnershipDetail,
  PartnershipPayoutsResponse,
  Payout,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers (shared with builderClient)
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
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

function postJson<T>(url: string, body?: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ---------------------------------------------------------------------------
// formatCents — shared utility (spec: no ad-hoc /100 in components)
// ---------------------------------------------------------------------------

/**
 * Format integer cents as a dollar string: `formatCents(4999)` → `"$49.99"`.
 * Negative amounts render as `-$X.XX`. Zero → `"$0.00"`.
 */
export function formatCents(cents: number, currency = "USD"): string {
  if (!Number.isFinite(cents)) return "—";
  const symbol = currency === "USD" ? "$" : currency + " ";
  const abs = Math.abs(cents);
  const dollars = (abs / 100).toFixed(2);
  return cents < 0 ? `-${symbol}${dollars}` : `${symbol}${dollars}`;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** All partnerships with metrics + rollup (Phase 4 extended shape). */
export function usePartnerships() {
  return useQuery({
    queryKey: ["partnerships"],
    queryFn: () => apiFetch<PartnershipListItem[]>("/api/partnerships"),
  });
}

/** Single partnership detail with obligations, payouts, and PaymentInfo. */
export function usePartnershipDetail(id: string | null) {
  return useQuery({
    queryKey: ["partnership", id],
    queryFn: () => apiFetch<PartnershipDetail>(`/api/partnerships/${id}`),
    enabled: !!id,
  });
}

/** Payouts + obligations for a partnership (used in the detail money panel). */
export function usePartnershipPayouts(partnershipId: string | null) {
  return useQuery({
    queryKey: ["partnership-payouts", partnershipId],
    queryFn: () =>
      apiFetch<PartnershipPayoutsResponse>(`/api/payouts/partnerships/${partnershipId}`),
    enabled: !!partnershipId,
  });
}

// ---------------------------------------------------------------------------
// Invalidators
// ---------------------------------------------------------------------------

export function usePartnersInvalidator(partnershipId?: string | null) {
  const qc = useQueryClient();
  return {
    invalidateList: () => qc.invalidateQueries({ queryKey: ["partnerships"] }),
    invalidateDetail: () =>
      qc.invalidateQueries({ queryKey: ["partnership", partnershipId] }),
    invalidatePayouts: () =>
      qc.invalidateQueries({ queryKey: ["partnership-payouts", partnershipId] }),
    invalidateAll: () => {
      qc.invalidateQueries({ queryKey: ["partnerships"] });
      if (partnershipId) {
        qc.invalidateQueries({ queryKey: ["partnership", partnershipId] });
        qc.invalidateQueries({ queryKey: ["partnership-payouts", partnershipId] });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mutations (one-shot; callers call invalidateAll after success)
// ---------------------------------------------------------------------------

/** Create a commission payout for a partnership. */
export function createCommissionPayout(partnershipId: string): Promise<Payout> {
  return postJson(`/api/payouts/partnerships/${partnershipId}/commission`);
}

/** Create a fixed-fee payout for an obligation. */
export function createFixedFeePayout(obligationId: string): Promise<Payout> {
  return postJson(`/api/payouts/obligations/${obligationId}/fixed-fee`);
}

/** Mark a PENDING payout as SENT (requires reference). */
export function markPayoutSent(
  payoutId: string,
  data: { reference: string; note?: string },
): Promise<Payout & { emailSent: boolean }> {
  return postJson(`/api/payouts/${payoutId}/send`, data);
}

/** Resend the payout-sent email for a SENT payout. */
export function resendPayoutEmail(payoutId: string): Promise<Payout & { emailSent: boolean }> {
  return postJson(`/api/payouts/${payoutId}/resend`);
}

/** Settle a CONFIRMED or DISPUTED payout. */
export function settlePayout(payoutId: string): Promise<Payout> {
  return postJson(`/api/payouts/${payoutId}/settle`);
}

/** Backfill a missing partnership for a terminal instance. */
export function backfillPartnership(
  instanceId: string,
): Promise<{ partnership: PartnershipListItem; created: boolean }> {
  return postJson(`/api/partnerships/backfill/${instanceId}`);
}

// ---------------------------------------------------------------------------
// Hooks (wrap mutations in useQuery-style for loading/error state)
// ---------------------------------------------------------------------------

export function useCreateCommissionPayout(partnershipId: string) {
  const inv = usePartnersInvalidator(partnershipId);
  return useMutation({
    mutationFn: () => createCommissionPayout(partnershipId),
    onSuccess: () => inv.invalidateAll(),
  });
}

export function useCreateFixedFeePayout(partnershipId: string) {
  const inv = usePartnersInvalidator(partnershipId);
  return useMutation({
    mutationFn: (obligationId: string) => createFixedFeePayout(obligationId),
    onSuccess: () => inv.invalidateAll(),
  });
}

export function useMarkPayoutSent(partnershipId: string) {
  const inv = usePartnersInvalidator(partnershipId);
  return useMutation({
    mutationFn: ({ payoutId, data }: { payoutId: string; data: { reference: string; note?: string } }) =>
      markPayoutSent(payoutId, data),
    onSuccess: () => inv.invalidateAll(),
  });
}

export function useResendPayout(partnershipId: string) {
  const inv = usePartnersInvalidator(partnershipId);
  return useMutation({
    mutationFn: (payoutId: string) => resendPayoutEmail(payoutId),
    onSuccess: () => inv.invalidateAll(),
  });
}

export function useSettlePayout(partnershipId: string) {
  const inv = usePartnersInvalidator(partnershipId);
  return useMutation({
    mutationFn: (payoutId: string) => settlePayout(payoutId),
    onSuccess: () => inv.invalidateAll(),
  });
}
