// ---------------------------------------------------------------------------
// ObservabilityView — the Phase 9 dashboard, extracted from App.tsx so it can
// be lazy-loaded (React.lazy) and kept out of the builder's initial bundle.
// Data wiring (useWorkflowSummary + the three-panel selection state) is
// unchanged from the original inline version.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { useWorkflowSummary, POLL_INTERVAL_MS } from "../api/client";
import type { InstanceState, WorkflowNodeSummary } from "../api/types";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { NodeDrilldown } from "./NodeDrilldown";
import { InstanceInspector } from "./InstanceInspector";
import { EmptyState } from "./ds";
import { colors, font, formatTimestamp } from "../theme";

export default function ObservabilityView() {
  const summary = useWorkflowSummary();
  const [selectedState, setSelectedState] = useState<InstanceState | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  const nodes = summary.data?.nodes ?? [];
  const wf = summary.data?.workflow ?? null;

  function handleSelectState(state: string) {
    setSelectedState(state as InstanceState);
    setSelectedInstanceId(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: colors.bg }}>
      <ObserveTopbar
        name={wf?.name ?? "Workflow"}
        version={wf?.version ?? null}
        total={summary.data?.totalInstances ?? 0}
        nodes={nodes}
        generatedAt={summary.data?.generatedAt ?? null}
        fetching={summary.isFetching}
        error={summary.isError ? (summary.error as Error)?.message : null}
      />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {summary.isLoading ? (
            <Center>Loading workflow…</Center>
          ) : summary.isError ? (
            <EmptyState
              icon="⚠"
              title="Couldn't reach the observability API"
              description="Is the server running on :3001?"
            />
          ) : (
            <WorkflowCanvas nodes={nodes} selectedState={selectedState} onSelectState={handleSelectState} />
          )}
          <CanvasHint visible={!selectedState && !summary.isLoading && !summary.isError} />
        </div>
        {selectedState && (
          <div style={{ width: 340, flexShrink: 0, borderLeft: `1px solid ${colors.border}`, background: colors.bg }}>
            <NodeDrilldown
              state={selectedState}
              selectedInstanceId={selectedInstanceId}
              onSelectInstance={setSelectedInstanceId}
            />
          </div>
        )}
        {selectedInstanceId && (
          <div style={{ width: 420, flexShrink: 0, borderLeft: `1px solid ${colors.border}`, background: colors.bg }}>
            <InstanceInspector instanceId={selectedInstanceId} onClose={() => setSelectedInstanceId(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

function ObserveTopbar({
  name,
  version,
  total,
  nodes,
  generatedAt,
  fetching,
  error,
}: {
  name: string;
  version: number | null;
  total: number;
  nodes: WorkflowNodeSummary[];
  generatedAt: string | null;
  fetching: boolean;
  error: string | null;
}) {
  const active = nodes.filter((n) => !n.terminal).reduce((a, n) => a + n.count, 0);
  const terminal = nodes.filter((n) => n.terminal).reduce((a, n) => a + n.count, 0);
  const stuck = nodes.reduce((a, n) => a + n.stuck, 0);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "10px 18px",
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel,
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: font.size.sm, color: colors.textMuted, fontWeight: font.weight.semibold }}>
        Observability
      </div>
      <div style={{ width: 1, height: 22, background: colors.border }} />
      <div style={{ fontSize: font.size.md, color: colors.textMuted }}>
        {name}
        {version !== null && <span style={{ color: colors.textDim }}> · v{version}</span>}
      </div>
      <div style={{ display: "flex", gap: 16, marginLeft: 8 }}>
        <Stat label="total" value={total} />
        <Stat label="active" value={active} color={colors.accent} />
        <Stat label="terminal" value={terminal} />
        {stuck > 0 && <Stat label="stuck" value={stuck} color={colors.warning} />}
      </div>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        {error ? (
          <span style={{ fontSize: font.size.sm, color: colors.danger }}>● disconnected</span>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.size.sm, color: colors.textMuted }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: fetching ? colors.warning : colors.success,
                boxShadow: `0 0 6px ${fetching ? colors.warning : colors.success}`,
              }}
            />
            live · {POLL_INTERVAL_MS / 1000}s
          </span>
        )}
        {generatedAt && (
          <span style={{ fontSize: font.size.xs, color: colors.textDim }}>updated {formatTimestamp(generatedAt)}</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
      <span style={{ fontSize: font.size.lg, fontWeight: font.weight.bold, color: color ?? colors.text }}>{value}</span>
      <span style={{ fontSize: font.size.xs, color: colors.textDim, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </span>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: colors.textMuted,
        fontSize: font.size.md,
        textAlign: "center",
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

function CanvasHint({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: "absolute",
        bottom: 18,
        right: 18,
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: "9px 13px",
        fontSize: font.size.sm,
        color: colors.textMuted,
        maxWidth: 230,
        lineHeight: 1.5,
        pointerEvents: "none",
      }}
    >
      Click a state node to see the creators inside it, then a creator to inspect its full lifecycle.
    </div>
  );
}
