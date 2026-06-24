// ---------------------------------------------------------------------------
// App — Pluvus Platform (Phase 10: Workflow Builder + Observability)
// ---------------------------------------------------------------------------
// Views:
//   campaigns  — campaign list + creation wizard
//   builder    — workflow builder (canvas, config, enroll, launch, monitor)
//   observe    — observability dashboard (Phase 9)
//
// Routing is state-based (no react-router dependency).

import { useState } from "react";
import { useWorkflowSummary, POLL_INTERVAL_MS } from "./api/client";
import type { InstanceState } from "./api/types";
import { WorkflowCanvas } from "./components/WorkflowCanvas";
import { NodeDrilldown } from "./components/NodeDrilldown";
import { InstanceInspector } from "./components/InstanceInspector";
import { CampaignList } from "./components/builder/CampaignList";
import { WorkflowBuilder } from "./components/builder/WorkflowBuilder";
import { colors, formatTimestamp } from "./theme";

type View = "campaigns" | "builder" | "observe";

export default function App() {
  const [view, setView] = useState<View>("campaigns");
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);

  function openWorkflow(id: string) {
    setActiveWorkflowId(id);
    setView("builder");
  }

  function backToCampaigns() {
    setView("campaigns");
    setActiveWorkflowId(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: colors.bg }}>
      <AppTopbar view={view} onChangeView={setView} />
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === "campaigns" && (
          <CampaignList onSelectWorkflow={openWorkflow} />
        )}
        {view === "builder" && activeWorkflowId && (
          <WorkflowBuilder workflowId={activeWorkflowId} onBack={backToCampaigns} />
        )}
        {view === "builder" && !activeWorkflowId && (
          <CampaignList onSelectWorkflow={openWorkflow} />
        )}
        {view === "observe" && (
          <ObservabilityView />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App-level topbar with view switcher
// ---------------------------------------------------------------------------

function AppTopbar({ view, onChangeView }: { view: View; onChangeView: (v: View) => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 0,
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel,
        flexShrink: 0,
        height: 44,
      }}
    >
      <div
        style={{
          padding: "0 18px",
          fontSize: 14,
          fontWeight: 700,
          color: colors.text,
          borderRight: `1px solid ${colors.border}`,
          height: "100%",
          display: "flex",
          alignItems: "center",
          letterSpacing: -0.2,
        }}
      >
        Pluvus
      </div>
      {(
        [
          { key: "campaigns", label: "Builder" },
          { key: "observe", label: "Observability" },
        ] as { key: View; label: string }[]
      ).map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChangeView(tab.key)}
          style={{
            height: "100%",
            padding: "0 18px",
            background: "none",
            border: "none",
            borderBottom: `2px solid ${view === tab.key || (tab.key === "campaigns" && view === "builder") ? colors.accent : "transparent"}`,
            color:
              view === tab.key || (tab.key === "campaigns" && view === "builder")
                ? colors.accent
                : colors.textMuted,
            fontSize: 13,
            fontWeight:
              view === tab.key || (tab.key === "campaigns" && view === "builder") ? 600 : 400,
            cursor: "pointer",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Observability view (Phase 9 dashboard, unchanged)
// ---------------------------------------------------------------------------

function ObservabilityView() {
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
// Observability topbar (sub-header inside the observe view)
// ---------------------------------------------------------------------------

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
      <div style={{ fontSize: 12, color: colors.textMuted, fontWeight: 600 }}>Observability</div>

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
