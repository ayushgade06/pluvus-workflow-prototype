import { memo } from "react";
import { Handle, Position } from "reactflow";
import { colors, radii, font } from "../../theme";
import type { DraftNode } from "../../api/builderTypes";
import {
  nodeLabel,
  nodeIcon,
  nodeColor,
  configSummary,
  configChips,
  nodeWarning,
  nodeTypeToState,
} from "./nodeMeta";

export interface BuilderNodeData {
  node: DraftNode;
  selected: boolean;
  executionCount?: Record<string, number> | undefined;
  published?: boolean | undefined;
}

const NODE_WIDTH = 300;

export const BuilderNodeComponent = memo(function BuilderNodeComponent({
  data,
}: {
  data: BuilderNodeData;
}) {
  const { node, selected, executionCount, published } = data;
  const typeColor = nodeColor(node.type);
  const icon = nodeIcon(node.type);
  const label = nodeLabel(node.type);
  const summary = configSummary(node);
  const chips = configChips(node);
  const warning = nodeWarning(node);
  const invalid = warning !== null;

  const stateName = nodeTypeToState(node.type);
  const liveCount = stateName && executionCount ? executionCount[stateName] ?? 0 : null;
  const hasLive = liveCount !== null && liveCount > 0;

  // Border/ring priority: selected > invalid > default.
  const borderColor = selected ? colors.accent : invalid ? colors.danger : colors.border;
  const ring = selected
    ? `0 0 0 3px ${colors.accent}2e`
    : invalid
    ? `0 0 0 3px ${colors.danger}1f`
    : "none";

  return (
    <div
      className="ds-card-interactive"
      style={{
        width: NODE_WIDTH,
        background: selected ? "rgba(56,139,253,0.06)" : colors.panel,
        border: `1.5px solid ${borderColor}`,
        borderRadius: radii.lg,
        overflow: "hidden",
        boxShadow: ring,
        position: "relative",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      {/* Accent rail */}
      <div style={{ height: 3, background: typeColor }} />

      <div style={{ padding: "11px 13px 12px" }}>
        {/* Header: icon · name · status dot */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            aria-hidden
            style={{
              width: 24,
              height: 24,
              borderRadius: radii.sm,
              background: `${typeColor}1f`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            {icon}
          </span>
          <span style={{ fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.text }}>
            {label}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {published && (
              <span
                title="Published"
                style={{ fontSize: 10, color: colors.success, fontWeight: font.weight.bold }}
              >
                ✓
              </span>
            )}
            {hasLive && (
              <span
                title={`${liveCount} in this stage`}
                style={{
                  background: typeColor,
                  color: "#fff",
                  borderRadius: radii.pill,
                  fontSize: 10.5,
                  fontWeight: font.weight.bold,
                  padding: "1px 7px",
                  lineHeight: 1.6,
                }}
              >
                {liveCount}
              </span>
            )}
          </span>
        </div>

        {/* Body: one-line summary */}
        <div
          style={{
            fontSize: font.size.sm,
            color: invalid ? colors.danger : colors.textMuted,
            lineHeight: 1.4,
            marginTop: 8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {warning ?? summary}
        </div>

        {/* Body: config chips */}
        {chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 9 }}>
            {chips.map((c, i) => (
              <span
                key={i}
                style={{
                  fontSize: 10,
                  fontWeight: font.weight.medium,
                  color: colors.textMuted,
                  background: colors.panelAlt,
                  border: `1px solid ${colors.border}`,
                  borderRadius: radii.sm,
                  padding: "1px 6px",
                  lineHeight: 1.6,
                  whiteSpace: "nowrap",
                }}
              >
                {c}
              </span>
            ))}
          </div>
        )}

        {/* Footer: invalid badge (only when something's wrong) */}
        {invalid && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              marginTop: 10,
              paddingTop: 9,
              borderTop: `1px solid ${colors.border}`,
              fontSize: 10.5,
              color: colors.danger,
              fontWeight: font.weight.semibold,
            }}
          >
            <span aria-hidden>⚠</span> Needs configuration
          </div>
        )}
      </div>
    </div>
  );
});
