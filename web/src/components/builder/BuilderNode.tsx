import { memo } from "react";
import { Handle, Position } from "reactflow";
import { colors } from "../../theme";
import type { DraftNode } from "../../api/builderTypes";

export interface BuilderNodeData {
  node: DraftNode;
  selected: boolean;
  executionCount?: Record<string, number>;
}

const NODE_TYPE_LABELS: Record<string, string> = {
  INITIAL_OUTREACH: "Initial Outreach",
  FOLLOW_UP: "Follow-Up",
  REPLY_DETECTION: "Reply Detection",
  NEGOTIATION: "Negotiation",
  END: "End",
  IMPORT_CREATOR_LIST: "Import Creators",
};

const NODE_TYPE_ICONS: Record<string, string> = {
  INITIAL_OUTREACH: "✉",
  FOLLOW_UP: "🔔",
  REPLY_DETECTION: "🤖",
  NEGOTIATION: "💬",
  END: "✓",
  IMPORT_CREATOR_LIST: "👥",
};

const NODE_TYPE_COLORS: Record<string, string> = {
  INITIAL_OUTREACH: "#388bfd",
  FOLLOW_UP: "#a371f7",
  REPLY_DETECTION: "#56d364",
  NEGOTIATION: "#d29922",
  END: "#3fb950",
  IMPORT_CREATOR_LIST: "#6e7681",
};

function configSummary(node: DraftNode): string {
  const cfg = node.config as Record<string, unknown>;
  switch (node.type) {
    case "INITIAL_OUTREACH": {
      const subj = cfg["subjectTemplate"] as string | undefined;
      return subj ? `Subject: ${subj.slice(0, 36)}${subj.length > 36 ? "…" : ""}` : "No subject set";
    }
    case "FOLLOW_UP": {
      const count = cfg["maxCount"] as number | undefined;
      const unit = cfg["intervalUnit"] as string | undefined;
      const intervals = cfg["intervals"] as number[] | undefined;
      if (count && intervals) {
        return `${count} follow-up${count !== 1 ? "s" : ""} · ${intervals.join(", ")} ${unit ?? "days"}`;
      }
      return "Not configured";
    }
    case "REPLY_DETECTION": {
      const threshold = cfg["lowConfidenceThreshold"] as number | undefined;
      return threshold !== undefined
        ? `Confidence ≥ ${Math.round(threshold * 100)}%`
        : "Not configured";
    }
    case "NEGOTIATION": {
      const min = cfg["minBudget"] as number | undefined;
      const max = cfg["maxBudget"] as number | undefined;
      const rounds = cfg["maxRounds"] as number | undefined;
      if (min !== undefined && max !== undefined) {
        return `$${min}–$${max} · ${rounds ?? "?"} rounds`;
      }
      return "Not configured";
    }
    case "END":
      return "Terminal node";
    default:
      return "—";
  }
}

export const BuilderNodeComponent = memo(function BuilderNodeComponent({
  data,
}: {
  data: BuilderNodeData;
}) {
  const { node, selected, executionCount } = data;
  const typeColor = NODE_TYPE_COLORS[node.type] ?? colors.textMuted;
  const icon = NODE_TYPE_ICONS[node.type] ?? "◆";
  const label = NODE_TYPE_LABELS[node.type] ?? node.type;
  const summary = configSummary(node);

  // Execution counts for this node state (shown in monitor mode)
  const stateName = nodeTypeToState(node.type);
  const liveCount = stateName && executionCount ? executionCount[stateName] ?? 0 : null;

  return (
    <div
      style={{
        width: 280,
        background: selected ? "rgba(56,139,253,0.06)" : colors.panel,
        border: `1.5px solid ${selected ? colors.accent : colors.border}`,
        borderRadius: 10,
        overflow: "hidden",
        boxShadow: selected ? `0 0 0 3px rgba(56,139,253,0.18)` : "none",
        transition: "border-color 0.15s, box-shadow 0.15s",
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      {/* Accent bar */}
      <div style={{ height: 3, background: typeColor }} />

      <div style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 16 }}>{icon}</span>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: colors.text }}>
            {label}
          </span>
          {liveCount !== null && liveCount > 0 && (
            <span
              style={{
                marginLeft: "auto",
                background: typeColor,
                color: "#fff",
                borderRadius: 10,
                fontSize: 10.5,
                fontWeight: 700,
                padding: "1px 7px",
              }}
            >
              {liveCount}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: colors.textMuted,
            lineHeight: 1.4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summary}
        </div>
      </div>
    </div>
  );
});

function nodeTypeToState(type: string): string | null {
  const map: Record<string, string> = {
    INITIAL_OUTREACH: "OUTREACH_SENT",
    FOLLOW_UP: "FOLLOWED_UP",
    REPLY_DETECTION: "REPLY_RECEIVED",
    NEGOTIATION: "NEGOTIATING",
    END: "ACCEPTED",
  };
  return map[type] ?? null;
}
