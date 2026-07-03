// ---------------------------------------------------------------------------
// StateNode — a custom React Flow node representing one workflow state.
// ---------------------------------------------------------------------------
// Shows the count prominently, plus active/waiting/terminal/stuck breakdown and
// average time-in-state. Designed to be readable by a non-engineer at a glance
// (Part 1 requirement: counts on nodes, status understandable by non-engineers).

import { Handle, Position, type NodeProps } from "reactflow";
import type { WorkflowNodeSummary } from "../api/types";
import { colors, stateColor, stateLabel, formatDuration } from "../theme";

export interface StateNodeData {
  summary: WorkflowNodeSummary;
  selected: boolean;
  onSelect: (state: string) => void;
}

export function StateNode({ data }: NodeProps<StateNodeData>) {
  const { summary, selected, onSelect } = data;
  const accent = stateColor[summary.state];
  const hasStuck = summary.stuck > 0;
  const empty = summary.count === 0;

  return (
    <div
      onClick={() => onSelect(summary.state)}
      style={{
        width: 196,
        background: selected ? colors.panelAlt : colors.panel,
        border: `1px solid ${selected ? accent : colors.borderStrong}`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 10,
        padding: "11px 13px",
        opacity: empty ? 0.55 : 1,
        boxShadow: selected
          ? `0 0 0 3px ${accent}26, 0 8px 24px rgba(0,0,0,0.35)`
          : "0 1px 2px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.2)",
        cursor: "pointer",
        transition: "border-color 140ms, box-shadow 140ms, background 140ms",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: "none" }} />

      {/* Header: state label + terminal badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: colors.text, letterSpacing: 0.2 }}>
          {stateLabel[summary.state]}
        </span>
        {summary.terminal && (
          <span
            style={{
              fontSize: 8.5,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: colors.textDim,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              padding: "1px 4px",
            }}
          >
            terminal
          </span>
        )}
      </div>

      {/* Big count */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span
          className="nums"
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: empty ? colors.textDim : colors.text,
            lineHeight: 1,
            letterSpacing: -0.5,
          }}
        >
          {summary.count}
        </span>
        <span style={{ fontSize: 11, color: colors.textMuted }}>
          {summary.count === 1 ? "creator" : "creators"}
        </span>
      </div>

      {/* Breakdown chips */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
        {!summary.terminal && summary.active > 0 && (
          <Chip label={`${summary.active} active`} color={colors.accent} />
        )}
        {summary.waiting > 0 && <Chip label={`${summary.waiting} waiting`} color="#8b96f8" />}
        {hasStuck && <Chip label={`⚠ ${summary.stuck} stuck`} color={colors.warning} solid />}
      </div>

      {/* Avg time in state */}
      {summary.avgTimeInStateSeconds !== null && summary.count > 0 && (
        <div style={{ marginTop: 7, fontSize: 10.5, color: colors.textDim }}>
          avg {formatDuration(summary.avgTimeInStateSeconds)} in state
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
}

function Chip({ label, color, solid }: { label: string; color: string; solid?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 500,
        color: solid ? "#1a1205" : color,
        background: solid ? color : `${color}17`,
        border: `1px solid ${solid ? color : `${color}2e`}`,
        borderRadius: 999,
        padding: "1px 7px",
        whiteSpace: "nowrap",
        lineHeight: 1.6,
      }}
    >
      {label}
    </span>
  );
}
