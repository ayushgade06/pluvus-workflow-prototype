// ---------------------------------------------------------------------------
// ObservabilityView — the Phase 9 dashboard, extracted from App.tsx so it can
// be lazy-loaded (React.lazy) and kept out of the builder's initial bundle.
// Data wiring (useWorkflowSummary + the three-panel selection state) is
// unchanged from the original inline version.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { useWorkflowSummary, useWorkflowOptions, POLL_INTERVAL_MS } from "../api/client";
import type { InstanceState, WorkflowNodeSummary, WorkflowOption } from "../api/types";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { NodeDrilldown } from "./NodeDrilldown";
import { InstanceInspector } from "./InstanceInspector";
import { LlmUsageStrip } from "./LlmUsagePanel";
import { AlertTriangle, GitBranch } from "lucide-react";
import { EmptyState, Select } from "./ds";
import { ObserveInsights } from "./ObserveInsights";
import { colors, font, text, radii, formatTimestamp } from "../theme";

// Sub-tabs shown in the Observability header (matches the reference layout).
// Pipeline Flow is the live graph; the rest surface the same data as focused
// lists so the tab bar isn't decorative.
type ObserveTab = "flow" | "metrics" | "events" | "attention";
const OBSERVE_TABS: { key: ObserveTab; label: string }[] = [
  { key: "flow", label: "Pipeline Flow" },
  { key: "metrics", label: "Metrics" },
  { key: "events", label: "Recent Events" },
  { key: "attention", label: "Needs Attention" },
];

export default function ObservabilityView() {
  // W-6: an explicit workflow scope. null → "let the server pick the newest
  // published version" (the historical default). Picking one scopes BOTH the
  // summary and the drilldown so the counts and the creator list agree.
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const options = useWorkflowOptions();
  const summary = useWorkflowSummary(selectedVersionId);
  const [selectedState, setSelectedState] = useState<InstanceState | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [tab, setTab] = useState<ObserveTab>("flow");

  const nodes = summary.data?.nodes ?? [];
  const wf = summary.data?.workflow ?? null;
  // The version the drilldown must match: the explicit pick, else whatever the
  // summary resolved to (so both views stay on the same campaign).
  const scopedVersionId = selectedVersionId ?? wf?.versionId ?? null;

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
        options={options.data?.workflows ?? []}
        selectedVersionId={scopedVersionId}
        onSelectVersion={(id) => {
          setSelectedVersionId(id);
          setSelectedState(null);
          setSelectedInstanceId(null);
        }}
        tab={tab}
        onTab={setTab}
      />
      <LlmUsageStrip />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {summary.isLoading ? (
            <Center>Loading workflow…</Center>
          ) : summary.isError ? (
            <EmptyState
              icon={<AlertTriangle size={24} strokeWidth={1.75} color={colors.warning} />}
              title="Couldn't reach the observability API"
              description="Is the server running on :3001?"
            />
          ) : (
            <WorkflowCanvas nodes={nodes} selectedState={selectedState} onSelectState={handleSelectState} />
          )}
          <CanvasHint visible={!selectedState && !summary.isLoading && !summary.isError && tab === "flow"} />
        </div>

        {/* Right insights column — Pipeline Summary, Stage Distribution,
            Needs Attention, Recent Events (matches the reference layout). Its
            active section follows the header tab. Hidden while a drilldown or
            inspector panel is open so the canvas keeps room. */}
        {!selectedState && !selectedInstanceId && !summary.isLoading && !summary.isError && (
          <div
            className="ds-slide-in-right"
            style={{
              width: 320,
              flexShrink: 0,
              borderLeft: `2px solid ${colors.cardBorder}`,
              background: colors.bg,
              overflow: "auto",
            }}
          >
            <ObserveInsights nodes={nodes} focus={tab} onSelectState={handleSelectState} />
          </div>
        )}

        {selectedState && (
          <div
            className="ds-slide-in-right"
            style={{ width: 340, flexShrink: 0, borderLeft: `2px solid ${colors.cardBorder}`, background: colors.panel }}
          >
            <NodeDrilldown
              state={selectedState}
              workflowVersionId={scopedVersionId}
              selectedInstanceId={selectedInstanceId}
              onSelectInstance={setSelectedInstanceId}
            />
          </div>
        )}
        {selectedInstanceId && (
          <div
            className="ds-slide-in-right"
            style={{ width: 420, flexShrink: 0, borderLeft: `2px solid ${colors.cardBorder}`, background: colors.panel }}
          >
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
  options,
  selectedVersionId,
  onSelectVersion,
  tab,
  onTab,
}: {
  name: string;
  version: number | null;
  total: number;
  nodes: WorkflowNodeSummary[];
  generatedAt: string | null;
  fetching: boolean;
  error: string | null;
  options: WorkflowOption[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
  tab: ObserveTab;
  onTab: (t: ObserveTab) => void;
}) {
  const active = nodes.filter((n) => !n.terminal).reduce((a, n) => a + n.count, 0);
  const terminal = nodes.filter((n) => n.terminal).reduce((a, n) => a + n.count, 0);
  const stuck = nodes.reduce((a, n) => a + n.stuck, 0);

  return (
    <div
      style={{
        borderBottom: `2px solid ${colors.cardBorder}`,
        background: colors.panel,
        flexShrink: 0,
      }}
    >
      {/* Row 1 — title, scope, live stats */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "12px 18px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <GitBranch size={17} strokeWidth={2.25} color={colors.accent} />
          <span style={{ ...text.title, fontSize: font.size.xl }}>Observability</span>
        </div>
        <div style={{ width: 2, height: 20, background: colors.hairline }} />
        {options.length > 1 ? (
          <Select
            value={selectedVersionId ?? ""}
            onChange={(e) => onSelectVersion(e.target.value || null)}
            aria-label="Workflow scope"
            style={{ width: "auto", padding: "5px 8px", fontSize: font.size.sm }}
          >
            {options.map((o) => (
              <option key={o.latestVersionId} value={o.latestVersionId}>
                {o.workflowName} · v{o.latestVersion} ({o.instanceCount})
              </option>
            ))}
          </Select>
        ) : (
          <div style={{ fontSize: font.size.md, color: colors.textMuted }}>
            {name}
            {version !== null && <span style={{ color: colors.textDim }}> · v{version}</span>}
          </div>
        )}
        <div style={{ display: "flex", gap: 16, marginLeft: 8 }}>
          <Stat label="total" value={total} />
          <Stat label="active" value={active} color={colors.accent} />
          <Stat label="terminal" value={terminal} color={colors.success} />
          {stuck > 0 && <Stat label="stuck" value={stuck} color={colors.warning} />}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {error ? (
            <span style={{ fontSize: font.size.sm, color: colors.danger }}>● disconnected</span>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.size.sm, color: colors.textMuted }}>
              <span
                className={fetching ? undefined : "ds-pulse"}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: fetching ? colors.warning : colors.success,
                  boxShadow: `0 0 8px ${fetching ? colors.warning : colors.success}66`,
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

      {/* Row 2 — sub-tabs */}
      <div style={{ display: "flex", gap: 4, padding: "0 14px" }} role="tablist">
        {OBSERVE_TABS.map((t) => {
          const activeTab = t.key === tab;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={activeTab}
              onClick={() => onTab(t.key)}
              className="ds-focusable"
              style={{
                appearance: "none",
                background: "none",
                border: "none",
                borderBottom: `2px solid ${activeTab ? colors.accent : "transparent"}`,
                padding: "8px 10px",
                marginBottom: -2,
                fontSize: font.size.sm,
                fontWeight: activeTab ? font.weight.bold : font.weight.medium,
                color: activeTab ? colors.text : colors.textMuted,
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
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
        border: `1px solid ${colors.borderStrong}`,
        borderRadius: 10,
        padding: "10px 14px",
        fontSize: font.size.sm,
        color: colors.textMuted,
        maxWidth: 240,
        lineHeight: 1.55,
        pointerEvents: "none",
        boxShadow: "0 2px 6px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.28)",
      }}
    >
      Click a state node to see the creators inside it, then a creator to inspect its full lifecycle.
    </div>
  );
}
