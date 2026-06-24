// ---------------------------------------------------------------------------
// App — Pluvus Workflow Observability Dashboard (Phase 9)
// ---------------------------------------------------------------------------
// Layout (Part: UX & Product Alignment):
//
//   ┌───────────────────────────────────────────────────────────────┐
//   │ Topbar: workflow name · totals · live indicator                │
//   ├──────────────────┬───────────────────────┬────────────────────┤
//   │  Workflow Canvas │  Node Drilldown        │  Instance          │
//   │  (React Flow)    │  (creators in state)   │  Inspector         │
//   └──────────────────┴───────────────────────┴────────────────────┘
//
// The canvas is the navigation model: click a node → drilldown opens; click a
// creator → inspector opens. Everything polls live.

import { useState } from "react";
import { useWorkflowSummary, POLL_INTERVAL_MS } from "./api/client";
import type { InstanceState } from "./api/types";
import { WorkflowCanvas } from "./components/WorkflowCanvas";
import { NodeDrilldown } from "./components/NodeDrilldown";
import { InstanceInspector } from "./components/InstanceInspector";
import { colors, formatTimestamp } from "./theme";

export default function App() {
  const summary = useWorkflowSummary();
  const [selectedState, setSelectedState] = useState<InstanceState | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  const nodes = summary.data?.nodes ?? [];
  const wf = summary.data?.workflow ?? null;

  function handleSelectState(state: string) {
    setSelectedState(state as InstanceState);
    setSelectedInstanceId(null); // reset inspector when switching states
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: colors.bg }}>
      <Topbar
        name={wf?.name ?? "Workflow"}
        version={wf?.version ?? null}
        total={summary.data?.totalInstances ?? 0}
        nodes={nodes}
        generatedAt={summary.data?.generatedAt ?? null}
        fetching={summary.isFetching}
        error={summary.isError ? (summary.error as Error)?.message : null}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Canvas */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {summary.isLoading ? (
            <Center>Loading workflow…</Center>
          ) : summary.isError ? (
            <Center>
              <span style={{ color: colors.danger }}>
                Could not reach the observability API.<br />
                Is the server running on :3001?
              </span>
            </Center>
          ) : (
            <WorkflowCanvas
              nodes={nodes}
              selectedState={selectedState}
              onSelectState={handleSelectState}
            />
          )}
          <CanvasHint visible={!selectedState && !summary.isLoading && !summary.isError} />
        </div>

        {/* Drilldown */}
        {selectedState && (
          <div
            style={{
              width: 340,
              flexShrink: 0,
              borderLeft: `1px solid ${colors.border}`,
              background: colors.bg,
            }}
          >
            <NodeDrilldown
              state={selectedState}
              selectedInstanceId={selectedInstanceId}
              onSelectInstance={setSelectedInstanceId}
            />
          </div>
        )}

        {/* Inspector */}
        {selectedInstanceId && (
          <div
            style={{
              width: 420,
              flexShrink: 0,
              borderLeft: `1px solid ${colors.border}`,
              background: colors.bg,
            }}
          >
            <InstanceInspector
              instanceId={selectedInstanceId}
              onClose={() => setSelectedInstanceId(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------

function Topbar({
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
  nodes: { active: number; stuck: number; terminal: boolean; count: number }[];
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
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>Pluvus</span>
        <span style={{ fontSize: 12, color: colors.textMuted }}>Workflow Observability</span>
      </div>

      <div style={{ width: 1, height: 22, background: colors.border }} />

      <div style={{ fontSize: 12.5, color: colors.textMuted }}>
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
          <span style={{ fontSize: 11.5, color: colors.danger }}>● disconnected</span>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: colors.textMuted }}>
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
          <span style={{ fontSize: 10.5, color: colors.textDim }}>updated {formatTimestamp(generatedAt)}</span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: color ?? colors.text }}>{value}</span>
      <span style={{ fontSize: 10.5, color: colors.textDim, textTransform: "uppercase", letterSpacing: 0.4 }}>
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
        fontSize: 13,
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
        fontSize: 11.5,
        color: colors.textMuted,
        maxWidth: 230,
        lineHeight: 1.5,
        pointerEvents: "none",
      }}
    >
      Click a state node to see the creators inside it, then a creator to inspect
      its full lifecycle.
    </div>
  );
}
