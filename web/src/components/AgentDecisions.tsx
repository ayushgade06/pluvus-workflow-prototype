// ---------------------------------------------------------------------------
// AgentDecisions — what the AI decided and why (Part 7).
// ---------------------------------------------------------------------------
// Surfaces classification (intent + confidence) and negotiation (outcome +
// round + reasoning) decisions pulled from the event log, so a non-engineer can
// see exactly what each agent chose.

import type { AgentDecisionDTO } from "../api/types";
import { colors, formatTimestamp } from "../theme";
import { Empty } from "./ui";

export function AgentDecisions({ decisions }: { decisions: AgentDecisionDTO[] }) {
  if (decisions.length === 0) return <Empty>No AI decisions recorded for this creator.</Empty>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {decisions.map((d, i) => (
        <Card key={i} d={d} />
      ))}
    </div>
  );
}

function Card({ d }: { d: AgentDecisionDTO }) {
  const isClassification = d.kind === "classification";
  const accent = isClassification ? "#d29922" : "#e3b341";
  const conf = d.confidence;

  return (
    <div
      style={{
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: accent, textTransform: "uppercase" }}>
          {isClassification ? "Classification" : "Negotiation"}
        </span>
        <span style={{ fontSize: 10, color: colors.textDim }}>{formatTimestamp(d.occurredAt)}</span>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 7 }}>
        <span style={{ fontSize: 10.5, color: colors.textDim }}>{isClassification ? "Intent" : "Decision"}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>{d.decision ?? "—"}</span>
        {d.round !== null && (
          <span style={{ fontSize: 11, color: colors.textMuted }}>· round {d.round}</span>
        )}
      </div>

      {/* Confidence bar for classification. */}
      {conf !== null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: colors.textDim, marginBottom: 3 }}>
            <span>confidence</span>
            <span>{(conf * 100).toFixed(0)}%</span>
          </div>
          <div style={{ height: 5, background: colors.bg, borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                width: `${Math.round(conf * 100)}%`,
                height: "100%",
                background: conf >= 0.7 ? colors.success : colors.warning,
              }}
            />
          </div>
        </div>
      )}

      {d.reasoning && (
        <div
          style={{
            marginTop: 9,
            fontSize: 11.5,
            color: colors.textMuted,
            fontStyle: "italic",
            lineHeight: 1.45,
            borderLeft: `2px solid ${colors.border}`,
            paddingLeft: 9,
          }}
        >
          "{d.reasoning}"
        </div>
      )}
    </div>
  );
}
