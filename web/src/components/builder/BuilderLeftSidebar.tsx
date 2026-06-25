// ---------------------------------------------------------------------------
// BuilderLeftSidebar (Phase B) — workflow overview, node search + index,
// quick stats and metadata. Pure presentation: every value comes from data
// WorkflowBuilder already holds, and selecting a node calls the SAME
// onSelectNode the canvas uses. No new data fetching, no contract changes.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { colors, radii, font, formatTimestamp } from "../../theme";
import { Input, StatusBadge, SectionHeader, Tooltip } from "../ds";
import {
  nodeLabel,
  nodeIcon,
  nodeColor,
  nodeDescription,
  nodeWarning,
  nodeTypeToState,
} from "./nodeMeta";
import type { DraftNode, WorkflowDetail, WorkflowExecutionSummary } from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  nodes: DraftNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  execution: WorkflowExecutionSummary | undefined;
  versionCount: number;
}

export function BuilderLeftSidebar({
  workflow,
  nodes,
  selectedNodeId,
  onSelectNode,
  execution,
  versionCount,
}: Props) {
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => [...nodes].sort((a, b) => a.order - b.order), [nodes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (n) => nodeLabel(n.type).toLowerCase().includes(q) || n.type.toLowerCase().includes(q),
    );
  }, [sorted, query]);

  const invalidCount = useMemo(() => sorted.filter((n) => nodeWarning(n) !== null).length, [sorted]);

  const total = execution?.totalInstances ?? 0;
  const counts = execution?.stateCounts;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: colors.panel,
        overflow: "hidden",
      }}
    >
      {/* Overview */}
      <div style={{ padding: "16px 16px 14px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ fontSize: font.size.lg, fontWeight: font.weight.bold, color: colors.text, lineHeight: 1.25 }}>
          {workflow.name}
        </div>
        {workflow.campaign && (
          <div style={{ fontSize: font.size.sm, color: colors.textDim, marginTop: 3 }}>
            {workflow.campaign.brand}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <StatusBadge status={workflow.status} small />
          {workflow.latestVersion && (
            <span style={{ fontSize: font.size.xs, color: colors.textDim }}>
              v{workflow.latestVersion.version}
            </span>
          )}
        </div>
      </div>

      {/* Quick stats */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <MiniStat label="Steps" value={sorted.length} />
          <MiniStat label="Versions" value={versionCount} />
          <MiniStat label="Enrolled" value={total} color={total > 0 ? colors.accent : undefined} />
          <MiniStat
            label="Issues"
            value={invalidCount}
            color={invalidCount > 0 ? colors.danger : colors.success}
          />
        </div>
      </div>

      {/* Node search + index */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "14px 16px 8px" }}>
        <SectionHeader count={sorted.length}>Steps</SectionHeader>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search steps…"
          aria-label="Search workflow steps"
          style={{ padding: "6px 10px", fontSize: font.size.sm, marginBottom: 10 }}
        />
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {filtered.length === 0 ? (
            <div style={{ fontSize: font.size.sm, color: colors.textDim, padding: "8px 2px", fontStyle: "italic" }}>
              No steps match “{query}”.
            </div>
          ) : (
            filtered.map((n, i) => (
              <NodeIndexItem
                key={n.id}
                node={n}
                index={sorted.indexOf(n)}
                selected={n.id === selectedNodeId}
                liveCount={liveCountFor(n, counts)}
                onClick={() => onSelectNode(n.id === selectedNodeId ? null : n.id)}
                isLast={i === filtered.length - 1 && !query}
              />
            ))
          )}
        </div>
      </div>

      {/* Metadata footer */}
      <div
        style={{
          padding: "10px 16px 12px",
          borderTop: `1px solid ${colors.border}`,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <MetaRow label="Created" value={formatTimestamp(workflow.createdAt)} />
        <MetaRow label="Updated" value={formatTimestamp(workflow.updatedAt)} />
      </div>
    </div>
  );
}

function liveCountFor(n: DraftNode, counts: Record<string, number> | undefined): number | null {
  const state = nodeTypeToState(n.type);
  if (!state || !counts) return null;
  return counts[state] ?? 0;
}

function NodeIndexItem({
  node,
  index,
  selected,
  liveCount,
  onClick,
}: {
  node: DraftNode;
  index: number;
  selected: boolean;
  liveCount: number | null;
  onClick: () => void;
  isLast: boolean;
}) {
  const color = nodeColor(node.type);
  const warning = nodeWarning(node);
  return (
    <Tooltip content={nodeDescription(node.type)}>
      <button
        onClick={onClick}
        aria-pressed={selected}
        className="ds-focusable ds-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: "100%",
          textAlign: "left",
          padding: "7px 9px",
          background: selected ? "rgba(56,139,253,0.1)" : "transparent",
          border: `1px solid ${selected ? colors.accent : "transparent"}`,
          borderRadius: radii.sm,
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 10, color: colors.textDim, width: 12, flexShrink: 0, textAlign: "right" }}>
          {index + 1}
        </span>
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: radii.sm,
            background: `${color}1f`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {nodeIcon(node.type)}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: font.size.md,
            color: selected ? colors.text : colors.textMuted,
            fontWeight: selected ? font.weight.semibold : font.weight.regular,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {nodeLabel(node.type)}
        </span>
        {warning && (
          <span title={warning} aria-label={warning} style={{ fontSize: 11, color: colors.danger, flexShrink: 0 }}>
            ⚠
          </span>
        )}
        {liveCount !== null && liveCount > 0 && (
          <span
            style={{
              fontSize: 10,
              fontWeight: font.weight.bold,
              color: "#fff",
              background: color,
              borderRadius: radii.pill,
              padding: "0 6px",
              flexShrink: 0,
            }}
          >
            {liveCount}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number; color?: string | undefined }) {
  return (
    <div
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.sm,
        padding: "8px 10px",
      }}
    >
      <div style={{ fontSize: font.size.lg, fontWeight: font.weight.bold, color: color ?? colors.text, lineHeight: 1.1 }}>
        {value}
      </div>
      <div style={{ fontSize: 9.5, color: colors.textDim, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontSize: font.size.xs, color: colors.textDim }}>{label}</span>
      <span style={{ fontSize: font.size.xs, color: colors.textMuted }}>{value}</span>
    </div>
  );
}
