// ---------------------------------------------------------------------------
// StateNode — an operational status card for one workflow stage.
// ---------------------------------------------------------------------------
// Not a flowchart box: a monitoring card. Top row = icon + stage name + status
// badge (Live / Blocked / Review / Terminal / Idle). Middle = large creator
// count. Bottom = load bar + avg-wait / oldest metrics. Muted when idle, a
// coloured glow when it's the selected/active stage. Handles are invisible —
// this is a read-only view, not an editor.
import { Handle, Position, type NodeProps } from "reactflow";
import type { WorkflowNodeSummary } from "../api/types";
import { colors, stateColor, stateLabel, formatDuration } from "../theme";
import { stateIcon } from "./observe/stateIcons";
import { nodeStatus, STATUS_LABEL, type NodeStatus } from "./observe/metrics";

export interface StateNodeData {
  summary: WorkflowNodeSummary;
  selected: boolean;
  /** Dimmed because another node is hovered/selected and this one isn't adjacent. */
  faded?: boolean;
  /** Longest-waiting duration (seconds) among creators in this stage, if known. */
  oldestSeconds?: number | null;
  /** This stage's count as a fraction of the busiest active stage (0–1). */
  load?: number;
  /** Pulse once because the count just changed on the latest poll. */
  pulse?: boolean;
  onSelect: (state: string) => void;
  onHover: (state: string | null) => void;
}

// Status badge colour — semantic, per your hierarchy spec.
function statusColor(status: NodeStatus, accent: string): string {
  switch (status) {
    case "live":
      return accent;
    case "blocked":
      return colors.warning;
    case "review":
      return "#e0784a"; // orange — manual review lane
    case "terminal":
      return colors.textDim;
    case "idle":
    default:
      return colors.textDim;
  }
}

export function StateNode({ data }: NodeProps<StateNodeData>) {
  const { summary, selected, faded, oldestSeconds, load = 0, pulse, onSelect, onHover } = data;
  const accent = stateColor[summary.state];
  const status = nodeStatus(summary);
  const empty = summary.count === 0;
  const Icon = stateIcon(summary.state);
  const badgeColor = statusColor(status, accent);
  const isActiveLive = status === "live";

  return (
    <div
      onClick={() => onSelect(summary.state)}
      onMouseEnter={() => onHover(summary.state)}
      onMouseLeave={() => onHover(null)}
      className={pulse ? "ds-node-pulse" : undefined}
      style={{
        width: 260,
        boxSizing: "border-box",
        background: selected
          ? `linear-gradient(180deg, ${accent}1f, ${colors.panel} 60%)`
          : colors.panel,
        border: `1px solid ${selected ? accent : colors.hairline}`,
        borderRadius: 14,
        padding: "13px 15px 14px",
        opacity: faded ? 0.4 : empty ? 0.72 : 1,
        boxShadow: selected
          ? `0 0 0 1px ${accent}66, 0 0 28px ${accent}30, 0 10px 30px rgba(0,0,0,0.45)`
          : isActiveLive
          ? `0 1px 0 ${colors.hairline}, 0 6px 18px rgba(0,0,0,0.30)`
          : "0 1px 0 rgba(255,255,255,0.02), 0 4px 12px rgba(0,0,0,0.22)",
        cursor: "pointer",
        transition: "border-color 160ms ease, box-shadow 200ms ease, opacity 200ms ease, transform 160ms ease",
      }}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} isConnectable={false} />

      {/* Top row: icon · stage name · status badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: `${accent}1c`,
            border: `1px solid ${accent}33`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: accent,
            flexShrink: 0,
          }}
        >
          <Icon size={15} strokeWidth={2.1} />
        </span>
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: colors.text,
            letterSpacing: -0.1,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {stateLabel[summary.state]}
        </span>
        <StatusBadge status={status} color={badgeColor} live={isActiveLive && summary.count > 0} />
      </div>

      {/* Middle: large count, or an idle empty-state line */}
      {empty ? (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 11.5,
            color: colors.textDim,
            lineHeight: 1.4,
          }}
        >
          <Icon size={13} strokeWidth={1.9} style={{ opacity: 0.6, flexShrink: 0 }} />
          {summary.terminal ? "No creators reached this state" : "This stage is idle"}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginTop: 11 }}>
          <span
            className="nums"
            style={{ fontSize: 30, fontWeight: 650, color: colors.text, lineHeight: 1, letterSpacing: -1 }}
          >
            {summary.count}
          </span>
          <span style={{ fontSize: 11.5, color: colors.textMuted }}>
            {summary.count === 1 ? "creator" : "creators"}
          </span>
          {summary.stuck > 0 && (
            <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: colors.warning }}>
              {summary.stuck} stuck
            </span>
          )}
        </div>
      )}

      {/* Bottom: load bar + wait metrics (only when populated & not terminal) */}
      {!empty && !summary.terminal && (
        <>
          <div
            style={{
              marginTop: 11,
              height: 4,
              borderRadius: 3,
              background: colors.panelAlt,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.round(Math.max(0.04, load) * 100)}%`,
                background: accent,
                borderRadius: 3,
                transition: "width 500ms cubic-bezier(0.25,1,0.5,1)",
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 9, fontSize: 10.5, color: colors.textDim }}>
            {summary.avgTimeInStateSeconds !== null && (
              <Metric label="Avg wait" value={formatDuration(summary.avgTimeInStateSeconds)} />
            )}
            {oldestSeconds != null && oldestSeconds > 0 && (
              <Metric label="Oldest" value={formatDuration(oldestSeconds)} />
            )}
          </div>
        </>
      )}

      <Handle type="source" position={Position.Bottom} style={handleStyle} isConnectable={false} />
    </div>
  );
}

const handleStyle = { opacity: 0, width: 1, height: 1, pointerEvents: "none" as const, border: "none", background: "transparent" };

function StatusBadge({ status, color, live }: { status: NodeStatus; color: string; live: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flexShrink: 0,
        fontSize: 9.5,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color,
        background: `${color}1a`,
        border: `1px solid ${color}33`,
        borderRadius: 999,
        padding: "2px 8px",
        lineHeight: 1.4,
      }}
    >
      {live && (
        <span
          className="ds-pulse"
          style={{ width: 5, height: 5, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }}
        />
      )}
      {STATUS_LABEL[status]}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4 }}>
      <span style={{ color: colors.textDim }}>{label}</span>
      <span className="nums" style={{ color: colors.textMuted, fontWeight: 600 }}>{value}</span>
    </span>
  );
}
