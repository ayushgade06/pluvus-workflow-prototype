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
  nodeTypeToState,
} from "./nodeMeta";
import {
  dedupeIssues,
  nodeValidity,
  type ValidationIssue,
} from "../../workflow/graphValidation";
import type { DraftNode, WorkflowDetail, WorkflowExecutionSummary } from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  nodes: DraftNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  execution: WorkflowExecutionSummary | undefined;
  versionCount: number;
  /** Per-node validation issues from validateGraph() — the single validity
   * source shared with the canvas + issues panel. */
  nodeIssues: Map<string, ValidationIssue[]>;
}

export function BuilderLeftSidebar({
  workflow,
  nodes,
  selectedNodeId,
  onSelectNode,
  execution,
  versionCount,
  nodeIssues,
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

  // A node counts as an "issue" if it carries any error-severity issue.
  const invalidCount = useMemo(
    () => sorted.filter((n) => nodeValidity(nodeIssues.get(n.id)) === "error").length,
    [sorted, nodeIssues],
  );

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
      <div style={{ padding: "18px 18px 16px", borderBottom: `1px solid ${colors.border}` }}>
        <div
          style={{
            fontSize: font.size.lg,
            fontWeight: font.weight.semibold,
            color: colors.text,
            lineHeight: 1.3,
            letterSpacing: -0.2,
          }}
        >
          {workflow.name}
        </div>
        {workflow.campaign && (
          <div style={{ fontSize: font.size.sm, color: colors.textDim, marginTop: 4 }}>
            {workflow.campaign.brand}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <StatusBadge status={workflow.status} small />
          {workflow.latestVersion && (
            <span className="mono" style={{ fontSize: font.size.xs, color: colors.textDim }}>
              v{workflow.latestVersion.version}
            </span>
          )}
        </div>
      </div>

      {/* Quick stats */}
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${colors.border}` }}>
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
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "16px 18px 8px" }}>
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
            <div style={{ fontSize: font.size.sm, color: colors.textDim, padding: "10px 2px", lineHeight: 1.5 }}>
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
                issues={nodeIssues.get(n.id)}
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
          padding: "12px 18px 14px",
          borderTop: `1px solid ${colors.border}`,
          display: "flex",
          flexDirection: "column",
          gap: 5,
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
  issues,
  onClick,
}: {
  node: DraftNode;
  index: number;
  selected: boolean;
  liveCount: number | null;
  issues: ValidationIssue[] | undefined;
  onClick: () => void;
  isLast: boolean;
}) {
  const color = nodeColor(node.type);
  const nodeIssueList = issues && issues.length ? dedupeIssues(issues) : [];
  const validity = nodeValidity(nodeIssueList); // "ok" | "warning" | "error"
  const issueColor = validity === "error" ? colors.danger : colors.warning;
  // Marker a11y label (native title/aria-label handle newlines fine).
  const issueLabel = nodeIssueList.map((iss) => iss.message).join("\n");
  // Tooltip content: the node's actual reason(s) when invalid (one line each,
  // so multi-issue nodes read cleanly), else its plain description.
  const tooltip =
    nodeIssueList.length > 0 ? (
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {nodeIssueList.map((iss, i) => (
          <span key={iss.code + i} style={{ color: issueColor }}>
            {iss.message}
          </span>
        ))}
      </span>
    ) : (
      nodeDescription(node.type)
    );
  return (
    <Tooltip content={tooltip}>
      <button
        onClick={onClick}
        aria-pressed={selected}
        className="ds-focusable ds-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          textAlign: "left",
          padding: "8px 10px",
          background: selected ? `${colors.accent}14` : "transparent",
          border: `1px solid ${selected ? `${colors.accent}66` : "transparent"}`,
          borderRadius: radii.sm + 1,
          cursor: "pointer",
        }}
      >
        <span
          className="nums"
          style={{ fontSize: 10.5, color: colors.textDim, width: 12, flexShrink: 0, textAlign: "right" }}
        >
          {index + 1}
        </span>
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            background: `${color}1c`,
            border: `1px solid ${color}26`,
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
            fontWeight: selected ? font.weight.semibold : font.weight.medium,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {nodeLabel(node.type)}
        </span>
        {validity !== "ok" && (
          <span
            title={issueLabel}
            aria-label={issueLabel}
            style={{ fontSize: 11, color: issueColor, flexShrink: 0 }}
          >
            {validity === "error" ? "⚠" : "○"}
          </span>
        )}
        {liveCount !== null && liveCount > 0 && (
          <span
            className="nums"
            style={{
              fontSize: 10.5,
              fontWeight: font.weight.semibold,
              color,
              background: `${color}1c`,
              border: `1px solid ${color}33`,
              borderRadius: radii.pill,
              padding: "0.5px 7px",
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
        borderRadius: radii.sm + 2,
        padding: "10px 12px",
      }}
    >
      <div
        className="nums"
        style={{
          fontSize: font.size.lg,
          fontWeight: font.weight.semibold,
          color: color ?? colors.text,
          lineHeight: 1.1,
          letterSpacing: -0.3,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: font.weight.medium,
          color: colors.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginTop: 4,
        }}
      >
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
