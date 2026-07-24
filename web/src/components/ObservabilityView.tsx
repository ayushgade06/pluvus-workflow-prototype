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
import type { InstanceState, WorkflowOption } from "../api/types";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { InstanceInspector } from "./InstanceInspector";
import { LlmUsageCard } from "./LlmUsagePanel";
import { AlertTriangle, Search, RadioTower } from "lucide-react";
import { EmptyState, Select, Input } from "./ds";
import { StageInspector } from "./observe/StageInspector";
import { pipelineHealth } from "./observe/metrics";
import { stateLabel } from "../theme";
import { colors, font, radii, formatTimestamp } from "../theme";

export default function ObservabilityView() {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const options = useWorkflowOptions();
  const summary = useWorkflowSummary(selectedVersionId);
  const [selectedState, setSelectedState] = useState<InstanceState | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Longest-waiting seconds per state, lifted from the inspector so node cards
  // can show "Oldest" without every node fetching its own list.
  const [oldestByState, setOldestByState] = useState<Record<string, number | null>>({});

  const allNodes = summary.data?.nodes ?? [];
  const wf = summary.data?.workflow ?? null;
  const scopedVersionId = selectedVersionId ?? wf?.versionId ?? null;

  // Bottleneck is still derived (cheap) so the inspector can flag it — but the
  // health strip itself is gone.
  const bottleneck = useMemo(() => pipelineHealth(allNodes).bottleneck, [allNodes]);

  // All stages always render; search just narrows by label when the operator
  // wants to focus (no lane filters).
  const nodes = useMemo(() => {
    if (!search.trim()) return allNodes;
    const q = search.trim().toLowerCase();
    return allNodes.filter((n) => stateLabel[n.state].toLowerCase().includes(q));
  }, [allNodes, search]);

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
      />

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
              description="No workflow stages match your search."
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

        {/* Right rail. Default = a slim AI-usage panel so the canvas keeps the
            majority of the width. It's replaced by the stage inspector when a
            stage is selected, and the full instance inspector stacks on top when
            a creator is selected. */}
        {!selectedState && (
          <div
            style={{
              width: 248,
              flexShrink: 0,
              borderLeft: `1px solid ${colors.hairline}`,
              background: colors.panel,
              overflowY: "auto",
            }}
          >
            <LlmUsageCard />
          </div>
        )}

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
              isBottleneck={bottleneck === selectedState}
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

      {/* Toolbar row: campaign scope · search */}
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
      </div>
    </div>
  );
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
