// ---------------------------------------------------------------------------
// ObligationsPanel — PLU-111 conversation obligations in the inspector.
// ---------------------------------------------------------------------------
// Shows the open creator questions + Pluvus commitments (still in the AI context)
// and, below, the resolved history — with a per-item operator "resolve" action
// (POST .../obligations/:id/resolve). Read-only for terminal rows.

import { useState } from "react";
import type {
  ConversationObligationDTO,
  ManualResolveStatus,
} from "../api/types";
import { useResolveObligation } from "../api/client";
import { colors, font } from "../theme";
import { Empty } from "./ui";
import { Button, Select } from "./ds";

// The terminal statuses an operator can apply, scoped by obligation type so the
// UI offers the sensible verb (a question is ANSWERED, a commitment COMPLETED).
const STATUS_OPTIONS: { value: ManualResolveStatus; label: string }[] = [
  { value: "ANSWERED", label: "Mark answered" },
  { value: "COMPLETED", label: "Mark completed" },
  { value: "CANCELED", label: "Cancel" },
  { value: "NO_LONGER_RELEVANT", label: "No longer relevant" },
];

function statusColor(status: ConversationObligationStatusLike): string {
  switch (status) {
    case "OPEN":
      return colors.warning;
    case "DEFERRED":
    case "ESCALATED":
      return colors.accent;
    case "ANSWERED":
    case "COMPLETED":
      return colors.success;
    default:
      return colors.textMuted;
  }
}

type ConversationObligationStatusLike = ConversationObligationDTO["status"];

function typeLabel(type: ConversationObligationDTO["type"]): string {
  return type === "CREATOR_QUESTION" ? "Creator question" : "Pluvus commitment";
}

export function ObligationsPanel({
  instanceId,
  obligations,
}: {
  instanceId: string;
  obligations: ConversationObligationDTO[];
}) {
  const open = obligations.filter((o) => o.open);
  const resolved = obligations.filter((o) => !o.open);

  if (obligations.length === 0) {
    return <Empty>No tracked questions or commitments yet.</Empty>;
  }

  return (
    <div>
      <p style={{ fontSize: 11, color: colors.textDim, margin: "0 0 12px", lineHeight: 1.4 }}>
        Durable creator questions and Pluvus commitments (PLU-111). Open items are
        fed into every subsequent AI email until resolved — by a sent answer, or by
        you here. Resolved items are kept for audit.
      </p>

      <SubHeading>Open ({open.length})</SubHeading>
      {open.length === 0 ? (
        <Empty>Nothing open — all questions answered and commitments completed.</Empty>
      ) : (
        open.map((o) => (
          <ObligationRow key={o.id} instanceId={instanceId} obligation={o} resolvable />
        ))
      )}

      {resolved.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <SubHeading>Resolved ({resolved.length})</SubHeading>
          {resolved.map((o) => (
            <ObligationRow key={o.id} instanceId={instanceId} obligation={o} resolvable={false} />
          ))}
        </>
      )}
    </div>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: font.size.xs,
        fontWeight: font.weight.semibold,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        color: colors.textMuted,
        margin: "0 0 8px",
      }}
    >
      {children}
    </div>
  );
}

function ObligationRow({
  instanceId,
  obligation,
  resolvable,
}: {
  instanceId: string;
  obligation: ConversationObligationDTO;
  resolvable: boolean;
}) {
  const o = obligation;
  const resolve = useResolveObligation(instanceId);
  const [status, setStatus] = useState<ManualResolveStatus>(
    o.type === "CREATOR_QUESTION" ? "ANSWERED" : "COMPLETED",
  );

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 8,
        background: colors.panelAlt,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10.5, color: colors.textMuted }}>{typeLabel(o.type)}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: font.weight.semibold,
            color: statusColor(o.status),
            border: `1px solid ${statusColor(o.status)}`,
            borderRadius: 4,
            padding: "1px 6px",
          }}
        >
          {o.status}
        </span>
        {o.category && (
          <span style={{ fontSize: 10, color: colors.textDim }}>· {o.category}</span>
        )}
        {o.resolutionSource && !o.open && (
          <span style={{ fontSize: 10, color: colors.textDim }}>· by {o.resolutionSource}</span>
        )}
      </div>

      <div style={{ fontSize: 12.5, color: colors.text, lineHeight: 1.4 }}>{o.originalText}</div>

      {o.resolution && (
        <div style={{ fontSize: 11, color: colors.textDim, marginTop: 4 }}>
          Resolution: {o.resolution}
        </div>
      )}

      {resolvable && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as ManualResolveStatus)}
            aria-label="Resolution status"
            style={{ maxWidth: 180 }}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ obligationId: o.id, status })}
          >
            {resolve.isPending ? "Resolving…" : "Resolve"}
          </Button>
          {resolve.isError && (
            <span style={{ fontSize: 10.5, color: colors.danger }}>
              {(resolve.error as Error)?.message ?? "Failed"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
