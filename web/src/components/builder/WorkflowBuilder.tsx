import { useState, useCallback, useRef } from "react";
import {
  useWorkflow,
  useWorkflowVersions,
  saveDraft,
  publishWorkflow,
  validateWorkflow,
  useBuilderInvalidator,
} from "../../api/builderClient";
import { colors, formatTimestamp } from "../../theme";
import { BuilderCanvas } from "./BuilderCanvas";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { EnrollTab } from "./EnrollTab";
import { LaunchTab } from "./LaunchTab";
import { MonitorTab } from "./MonitorTab";
import { useWorkflowExecution } from "../../api/builderClient";
import type { DraftNode } from "../../api/builderTypes";

type Tab = "build" | "enroll" | "launch" | "monitor";

interface Props {
  workflowId: string;
  onBack: () => void;
}

export function WorkflowBuilder({ workflowId, onBack }: Props) {
  const wfQuery = useWorkflow(workflowId);
  const versionsQuery = useWorkflowVersions(workflowId);
  const execution = useWorkflowExecution(workflowId);
  const inv = useBuilderInvalidator(workflowId);

  const [activeTab, setActiveTab] = useState<Tab>("build");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [localNodes, setLocalNodes] = useState<DraftNode[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [showVersions, setShowVersions] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wf = wfQuery.data;
  // localNodes takes priority over server data (optimistic local editing)
  const nodes = localNodes ?? wf?.draftNodes ?? [];

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const sorted = [...nodes].sort((a, b) => a.order - b.order);
  const selectedIndex = selectedNode ? sorted.findIndex((n) => n.id === selectedNode.id) : -1;

  // Debounced auto-save — fires 1s after last change
  function scheduleSave(updated: DraftNode[]) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void doSave(updated);
    }, 1000);
  }

  async function doSave(nodesToSave: DraftNode[]) {
    setSaving(true);
    setSaveError(null);
    try {
      await saveDraft(workflowId, nodesToSave);
      await inv.invalidateWorkflow();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleNodeUpdate(nodeId: string, config: Record<string, unknown>) {
    const updated = nodes.map((n) =>
      n.id === nodeId ? { ...n, config: config as DraftNode["config"] } : n,
    );
    setLocalNodes(updated);
    scheduleSave(updated);
  }

  function handleDeleteNode(nodeId: string) {
    const updated = nodes
      .filter((n) => n.id !== nodeId)
      .map((n, i) => ({ ...n, order: i }));
    setLocalNodes(updated);
    setSelectedNodeId(null);
    scheduleSave(updated);
  }

  function handleMoveUp(nodeId: string) {
    const s = [...nodes].sort((a, b) => a.order - b.order);
    const idx = s.findIndex((n) => n.id === nodeId);
    if (idx <= 0) return;
    const swapped = [...s];
    const a = swapped[idx - 1];
    const b = swapped[idx];
    if (!a || !b) return;
    swapped[idx - 1] = b;
    swapped[idx] = a;
    const updated = swapped.map((n, i) => ({ ...n, order: i }));
    setLocalNodes(updated);
    scheduleSave(updated);
  }

  function handleMoveDown(nodeId: string) {
    const s = [...nodes].sort((a, b) => a.order - b.order);
    const idx = s.findIndex((n) => n.id === nodeId);
    if (idx < 0 || idx >= s.length - 1) return;
    const swapped = [...s];
    const a = swapped[idx];
    const b = swapped[idx + 1];
    if (!a || !b) return;
    swapped[idx] = b;
    swapped[idx + 1] = a;
    const updated = swapped.map((n, i) => ({ ...n, order: i }));
    setLocalNodes(updated);
    scheduleSave(updated);
  }

  async function handlePublish() {
    setPublishing(true);
    setPublishError(null);
    setValidationErrors([]);
    // Flush any pending save first
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      await doSave(nodes);
    }
    try {
      const validation = await validateWorkflow(workflowId);
      if (!validation.valid) {
        setValidationErrors(validation.errors);
        setPublishing(false);
        return;
      }
      await publishWorkflow(workflowId);
      await Promise.all([inv.invalidateWorkflow(), inv.invalidateVersions()]);
      setLocalNodes(null);
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  }

  const executionCounts = execution.data?.stateCounts;

  if (wfQuery.isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: colors.textMuted,
          fontSize: 13,
        }}
      >
        Loading workflow…
      </div>
    );
  }

  if (wfQuery.isError || !wf) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: colors.danger,
          fontSize: 13,
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div>Failed to load workflow.</div>
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: `1px solid ${colors.border}`,
            color: colors.textMuted,
            padding: "6px 14px",
            borderRadius: 5,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: colors.bg }}>
      {/* Builder header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 18px",
          borderBottom: `1px solid ${colors.border}`,
          background: colors.panel,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            color: colors.textMuted,
            fontSize: 13,
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          ← Back
        </button>
        <div style={{ width: 1, height: 18, background: colors.border }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>
            {wf.name}
          </div>
          {wf.campaign && (
            <div style={{ fontSize: 11.5, color: colors.textDim }}>
              {wf.campaign.brand} · {wf.campaign.name}
            </div>
          )}
        </div>
        <StatusBadge status={wf.status} />
        {wf.latestVersion && (
          <button
            onClick={() => setShowVersions((v) => !v)}
            style={{
              background: "none",
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              color: colors.textMuted,
              fontSize: 11.5,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            v{wf.latestVersion.version}
          </button>
        )}
        {saving && (
          <span style={{ fontSize: 11.5, color: colors.textDim }}>Saving…</span>
        )}
        {saveError && (
          <span style={{ fontSize: 11.5, color: colors.danger }}>{saveError}</span>
        )}
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          borderBottom: `1px solid ${colors.border}`,
          background: colors.panel,
          flexShrink: 0,
        }}
      >
        {(["build", "enroll", "launch", "monitor"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "8px 18px",
              background: "none",
              border: "none",
              borderBottom: `2px solid ${activeTab === tab ? colors.accent : "transparent"}`,
              color: activeTab === tab ? colors.accent : colors.textMuted,
              fontSize: 13,
              fontWeight: activeTab === tab ? 600 : 400,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Versions drawer */}
      {showVersions && (
        <div
          style={{
            padding: "10px 18px",
            borderBottom: `1px solid ${colors.border}`,
            background: colors.panelAlt,
            flexShrink: 0,
            fontSize: 12,
          }}
        >
          <span style={{ color: colors.textMuted, marginRight: 12 }}>Version History:</span>
          {versionsQuery.data?.map((v) => (
            <span
              key={v.id}
              style={{
                marginRight: 12,
                color: v.version === wf.latestVersion?.version ? colors.accent : colors.textDim,
              }}
            >
              v{v.version} ({v.instanceCount} instances) · {formatTimestamp(v.publishedAt)}
            </span>
          ))}
        </div>
      )}

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div
          style={{
            padding: "8px 18px",
            background: "rgba(248,81,73,0.08)",
            borderBottom: `1px solid ${colors.danger}`,
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 12, color: colors.danger, fontWeight: 600, marginBottom: 4 }}>
            Validation errors — fix before publishing:
          </div>
          {validationErrors.map((e, i) => (
            <div key={i} style={{ fontSize: 11.5, color: colors.danger }}>
              · {e}
            </div>
          ))}
        </div>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {activeTab === "build" ? (
          <>
            {/* Canvas */}
            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
              <BuilderCanvas
                nodes={nodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                executionCounts={executionCounts}
              />

              {/* Publish bar */}
              <div
                style={{
                  position: "absolute",
                  bottom: 16,
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  gap: 10,
                  background: colors.panel,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: "8px 14px",
                  boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
                }}
              >
                <button
                  onClick={() => void handlePublish()}
                  disabled={publishing}
                  style={{
                    padding: "7px 18px",
                    background: publishing ? colors.border : colors.accent,
                    color: publishing ? colors.textDim : "#fff",
                    border: "none",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: publishing ? "not-allowed" : "pointer",
                  }}
                >
                  {publishing ? "Publishing…" : "Publish Version"}
                </button>
                {publishError && (
                  <span style={{ fontSize: 12, color: colors.danger, alignSelf: "center" }}>
                    {publishError}
                  </span>
                )}
              </div>
            </div>

            {/* Config panel */}
            {selectedNode && (
              <div
                style={{
                  width: 340,
                  flexShrink: 0,
                  borderLeft: `1px solid ${colors.border}`,
                }}
              >
                <NodeConfigPanel
                  key={selectedNode.id}
                  node={selectedNode}
                  onUpdate={handleNodeUpdate}
                  onDelete={handleDeleteNode}
                  onMoveUp={handleMoveUp}
                  onMoveDown={handleMoveDown}
                  isFirst={selectedIndex === 0}
                  isLast={selectedIndex === sorted.length - 1}
                />
              </div>
            )}
          </>
        ) : activeTab === "enroll" ? (
          <EnrollTab
            workflow={wf}
            onEnrolled={() => {
              void inv.invalidateExecution();
            }}
          />
        ) : activeTab === "launch" ? (
          <LaunchTab
            workflow={wf}
            onLaunched={() => {
              void inv.invalidateExecution();
              setActiveTab("monitor");
            }}
          />
        ) : (
          <MonitorTab workflow={wf} />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "PUBLISHED"
      ? colors.success
      : status === "ARCHIVED"
      ? colors.textDim
      : colors.warning;
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: "2px 7px",
        textTransform: "uppercase",
        letterSpacing: 0.4,
        opacity: 0.9,
      }}
    >
      {status}
    </span>
  );
}
