// ---------------------------------------------------------------------------
// ObservabilityView — an operational observability dashboard for a live
// workflow. React Flow renders the pipeline graph; everything else (header,
// health strip, inspector) is a purpose-built monitoring surface.
// ---------------------------------------------------------------------------
// Layout: premium header (title + description, live/refresh status, campaign
// scope, search, filters) → derived health strip → canvas (~72%) + stage
// inspector (~28%). All metrics are real or honestly derived from the live
// snapshot (see observe/metrics.ts) — no fabricated trends.
import { useCallback, useMemo, useState } from "react";
import { useWorkflowSummary, useWorkflowOptions, POLL_INTERVAL_MS } from "../api/client";
import type { InstanceState, WorkflowNodeSummary, WorkflowOption } from "../api/types";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { InstanceInspector } from "./InstanceInspector";
import { LlmUsageStrip } from "./LlmUsagePanel";
import { AlertTriangle, Activity, Search, RadioTower } from "lucide-react";
import { EmptyState, Select, Input } from "./ds";
import { StageInspector } from "./observe/StageInspector";
import { pipelineHealth } from "./observe/metrics";
import { stateLabel } from "../theme";
import { colors, font, radii, formatTimestamp } from "../theme";

// Node filters — narrow the graph to a lane of interest without losing context.
type NodeFilter = "all" | "active" | "attention" | "terminal";
const FILTERS: { key: NodeFilter; label: string }[] = [
  { key: "all", label: "All stages" },
  { key: "active", label: "Active" },
  { key: "attention", label: "Needs attention" },
  { key: "terminal", label: "Terminal" },
];

const ATTENTION_STATES = new Set<InstanceState>(["MANUAL_REVIEW", "NEEDS_DEAL_FINALIZATION"]);

export default function ObservabilityView() {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const options = useWorkflowOptions();
  const summary = useWorkflowSummary(selectedVersionId);
  const [selectedState, setSelectedState] = useState<InstanceState | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<NodeFilter>("all");
  // Longest-waiting seconds per state, lifted from the inspector so node cards
  // can show "Oldest" without every node fetching its own list.
  const [oldestByState, setOldestByState] = useState<Record<string, number | null>>({});

  const allNodes = summary.data?.nodes ?? [];
  const wf = summary.data?.workflow ?? null;
  const scopedVersionId = selectedVersionId ?? wf?.versionId ?? null;

  const health = useMemo(() => pipelineHealth(allNodes), [allNodes]);

  // Apply the node filter + search to what the canvas renders.
  const nodes = useMemo(() => {
    let ns = allNodes;
    if (filter === "active") ns = ns.filter((n) => !n.terminal);
    else if (filter === "terminal") ns = ns.filter((n) => n.terminal);
    else if (filter === "attention") ns = ns.filter((n) => n.stuck > 0 || ATTENTION_STATES.has(n.state));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      ns = ns.filter((n) => stateLabel[n.state].toLowerCase().includes(q));
    }
    return ns;
  }, [allNodes, filter, search]);

  const selectedSummary = useMemo(
    () => allNodes.find((n) => n.state === selectedState),
    [allNodes, selectedState],
  );

  const handleSelectState = useCallback((state: string) => {
    setSelectedState(state as InstanceState);
    setSelectedInstanceId(null);
  }, []);

  const handleOldest = useCallback((state: InstanceState, seconds: number | null) => {
    setOldestByState((prev) => (prev[state] === seconds ? prev : { ...prev, [state]: seconds }));
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: colors.bg }}>
      <ObserveHeader
        name={wf?.name ?? "Workflow"}
        version={wf?.version ?? null}
        total={summary.data?.totalInstances ?? 0}
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
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
      />

      <HealthStrip nodes={allNodes} health={health} onSelectState={handleSelectState} />

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
          ) : nodes.length === 0 ? (
            <EmptyState
              icon={<RadioTower size={24} strokeWidth={1.75} color={colors.textMuted} />}
              title="No stages match"
              description="No workflow stages match the current filter or search."
            />
          ) : (
            <WorkflowCanvas
              nodes={nodes}
              selectedState={selectedState}
              onSelectState={handleSelectState}
              oldestByState={oldestByState}
            />
          )}
          <CanvasHint visible={!selectedState && !summary.isLoading && !summary.isError && nodes.length > 0} />
        </div>

        {/* Stage inspector — opens on node select */}
        {selectedState && (
          <div
            className="ds-slide-in-right"
            style={{
              width: 372,
              flexShrink: 0,
              borderLeft: `1px solid ${colors.hairline}`,
              background: colors.panel,
            }}
          >
            <StageInspector
              state={selectedState}
              summary={selectedSummary}
              workflowVersionId={scopedVersionId}
              isBottleneck={health.bottleneck === selectedState}
              selectedInstanceId={selectedInstanceId}
              onSelectInstance={setSelectedInstanceId}
              onClose={() => setSelectedState(null)}
              onOldest={handleOldest}
            />
          </div>
        )}

        {/* Full instance inspector — opens on creator select */}
        {selectedInstanceId && (
          <div
            className="ds-slide-in-right"
            style={{ width: 420, flexShrink: 0, borderLeft: `1px solid ${colors.hairline}`, background: colors.panel }}
          >
            <InstanceInspector instanceId={selectedInstanceId} onClose={() => setSelectedInstanceId(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

// -- Header ------------------------------------------------------------------

function ObserveHeader({
  name,
  version,
  total,
  generatedAt,
  fetching,
  error,
  options,
  selectedVersionId,
  onSelectVersion,
  search,
  onSearch,
  filter,
  onFilter,
}: {
  name: string;
  version: number | null;
  total: number;
  generatedAt: string | null;
  fetching: boolean;
  error: string | null;
  options: WorkflowOption[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
  search: string;
  onSearch: (v: string) => void;
  filter: NodeFilter;
  onFilter: (f: NodeFilter) => void;
}) {
  return (
    <div style={{ borderBottom: `1px solid ${colors.hairline}`, background: colors.panel, flexShrink: 0 }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, padding: "16px 22px 12px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1
            className="serif"
            style={{ margin: 0, fontSize: 24, fontWeight: font.weight.bold, letterSpacing: -0.5, color: colors.text, lineHeight: 1.1 }}
          >
            Observability
          </h1>
          <p style={{ margin: "4px 0 0", fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.4 }}>
            Live health of your creator pipeline — {total} {total === 1 ? "creator" : "creators"} across the workflow.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
          {error ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.size.sm, color: colors.danger }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: colors.danger }} />
              Disconnected
            </span>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: font.size.sm, color: colors.textMuted }}>
              <span
                className={fetching ? undefined : "ds-pulse"}
                style={{ width: 7, height: 7, borderRadius: "50%", background: fetching ? colors.warning : colors.success, boxShadow: `0 0 8px ${fetching ? colors.warning : colors.success}88` }}
              />
              {fetching ? "Refreshing…" : "Live"}
              <span style={{ color: colors.textDim }}>· auto {POLL_INTERVAL_MS / 1000}s</span>
            </span>
          )}
          {generatedAt && (
            <span style={{ fontSize: font.size.xs, color: colors.textDim }}>updated {formatTimestamp(generatedAt)}</span>
          )}
        </div>
      </div>

      {/* Toolbar row: campaign scope · search · filters */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 22px 14px", flexWrap: "wrap" }}>
        {options.length > 1 ? (
          <Select
            value={selectedVersionId ?? ""}
            onChange={(e) => onSelectVersion(e.target.value || null)}
            aria-label="Campaign scope"
            style={{ width: "auto", padding: "6px 10px", fontSize: font.size.sm }}
          >
            {options.map((o) => (
              <option key={o.latestVersionId} value={o.latestVersionId}>
                {o.workflowName} · v{o.latestVersion} ({o.instanceCount})
              </option>
            ))}
          </Select>
        ) : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "6px 12px",
              fontSize: font.size.sm,
              color: colors.text,
              background: colors.panelAlt,
              border: `1px solid ${colors.hairline}`,
              borderRadius: radii.sm,
              fontWeight: font.weight.medium,
            }}
          >
            {name}
            {version !== null && <span style={{ color: colors.textDim }}>· v{version}</span>}
          </span>
        )}

        <div style={{ position: "relative", width: 220 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: colors.textDim, pointerEvents: "none" }} />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search stages…"
            aria-label="Search stages"
            style={{ width: "100%", padding: "6px 10px 6px 30px", fontSize: font.size.sm }}
          />
        </div>

        {/* Filter segmented control */}
        <div style={{ display: "flex", gap: 2, padding: 3, background: colors.panelAlt, border: `1px solid ${colors.hairline}`, borderRadius: radii.md }}>
          {FILTERS.map((f) => {
            const active = f.key === filter;
            return (
              <button
                key={f.key}
                onClick={() => onFilter(f.key)}
                className="ds-focusable"
                style={{
                  padding: "5px 11px",
                  fontSize: font.size.sm,
                  fontWeight: active ? font.weight.semibold : font.weight.medium,
                  color: active ? colors.text : colors.textMuted,
                  background: active ? colors.panel : "transparent",
                  border: active ? `1px solid ${colors.hairline}` : "1px solid transparent",
                  borderRadius: radii.sm,
                  cursor: "pointer",
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// -- Health strip ------------------------------------------------------------

function HealthStrip({
  nodes,
  health,
  onSelectState,
}: {
  nodes: WorkflowNodeSummary[];
  health: ReturnType<typeof pipelineHealth>;
  onSelectState: (s: string) => void;
}) {
  const bandColor =
    health.band === "healthy" ? colors.success : health.band === "watch" ? colors.warning : colors.danger;
  const bandLabel = health.band === "healthy" ? "Healthy" : health.band === "watch" ? "Watch" : "Degraded";

  // Longest-waiting stage overall (by avg time in state), for a quick read.
  const slowest = useMemo(() => {
    let out: WorkflowNodeSummary | null = null;
    for (const n of nodes) {
      if (n.terminal || n.count === 0 || n.avgTimeInStateSeconds == null) continue;
      if (!out || (n.avgTimeInStateSeconds ?? 0) > (out.avgTimeInStateSeconds ?? 0)) out = n;
    }
    return out;
  }, [nodes]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 22,
        padding: "10px 22px",
        borderBottom: `1px solid ${colors.hairline}`,
        background: colors.bg,
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      {/* Health score */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ position: "relative", width: 34, height: 34, flexShrink: 0 }}>
          <svg width="34" height="34" viewBox="0 0 34 34" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="17" cy="17" r="14" fill="none" stroke={colors.panelAlt} strokeWidth="4" />
            <circle
              cx="17" cy="17" r="14" fill="none" stroke={bandColor} strokeWidth="4" strokeLinecap="round"
              strokeDasharray={`${(health.score / 100) * 2 * Math.PI * 14} ${2 * Math.PI * 14}`}
            />
          </svg>
          <span className="nums" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 700, color: colors.text }}>
            {health.score}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: colors.textDim, fontWeight: 600 }}>
            Pipeline health <span title="Derived from live stuck-ratio + concentration; not a historical metric" style={{ cursor: "help" }}>ⓘ</span>
          </div>
          <div style={{ fontSize: font.size.sm, fontWeight: font.weight.bold, color: bandColor }}>{bandLabel}</div>
        </div>
      </div>

      <Divider />

      <HealthStat icon={<Activity size={14} color={colors.accent} />} label="In pipeline" value={String(health.activeInPipeline)} />
      <HealthStat
        icon={<AlertTriangle size={14} color={health.totalStuck > 0 ? colors.warning : colors.textDim} />}
        label="Stuck"
        value={String(health.totalStuck)}
        danger={health.totalStuck > 0}
      />

      {health.bottleneck && (
        <>
          <Divider />
          <button
            onClick={() => onSelectState(health.bottleneck!)}
            className="ds-focusable"
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: colors.textDim, fontWeight: 600 }}>Bottleneck</span>
            <span
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.text,
                background: `${colors.warning}14`, border: `1px solid ${colors.warning}40`,
                borderRadius: 999, padding: "2px 10px",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: colors.warning }} />
              {stateLabel[health.bottleneck]}
            </span>
          </button>
        </>
      )}

      {slowest && (
        <>
          <Divider />
          <HealthStat
            icon={<Activity size={14} color={colors.textMuted} />}
            label="Slowest stage"
            value={stateLabel[slowest.state]}
          />
        </>
      )}
    </div>
  );
}

function HealthStat({ icon, label, value, danger }: { icon: React.ReactNode; label: string; value: string; danger?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ display: "inline-flex", flexShrink: 0 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: colors.textDim, fontWeight: 600 }}>{label}</div>
        <div className="nums" style={{ fontSize: font.size.sm, fontWeight: font.weight.bold, color: danger ? colors.warning : colors.text }}>{value}</div>
      </div>
    </div>
  );
}

function Divider() {
  return <div aria-hidden style={{ width: 1, height: 26, background: colors.hairline, flexShrink: 0 }} />;
}

// -- misc --------------------------------------------------------------------

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
        border: `1px solid ${colors.hairline}`,
        borderRadius: 10,
        padding: "10px 14px",
        fontSize: font.size.sm,
        color: colors.textMuted,
        maxWidth: 240,
        lineHeight: 1.55,
        pointerEvents: "none",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      }}
    >
      Click a stage to inspect its creators, metrics, and recent events.
    </div>
  );
}
