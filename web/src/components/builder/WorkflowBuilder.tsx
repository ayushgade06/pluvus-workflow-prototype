import { useState, useCallback, useRef } from "react";
import {
  useWorkflow,
  useWorkflowVersions,
  saveDraft,
  publishWorkflow,
  validateWorkflow,
  useBuilderInvalidator,
  useWorkflowExecution,
} from "../../api/builderClient";
import { colors, radii, font, formatTimestamp } from "../../theme";
import { BuilderCanvas } from "./BuilderCanvas";
import { BuilderLeftSidebar } from "./BuilderLeftSidebar";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { EnrollTab } from "./EnrollTab";
import { LaunchTab } from "./LaunchTab";
import { MonitorTab } from "./MonitorTab";
import {
  Button,
  IconButton,
  Breadcrumbs,
  Tabs,
  StatusBadge,
  EmptyState,
  Tooltip,
  useToast,
  useMediaQuery,
  bp,
  type Crumb,
} from "../ds";
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
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("build");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [localNodes, setLocalNodes] = useState<DraftNode[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [showVersions, setShowVersions] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compact = useMediaQuery(bp.laptop);

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
      const res = await saveDraft(workflowId, nodesToSave);
      await inv.invalidateWorkflow();
      setSavedAt(res.updatedAt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      toast.error(`Couldn't save draft: ${msg}`);
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
    const updated = nodes.filter((n) => n.id !== nodeId).map((n, i) => ({ ...n, order: i }));
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
        toast.error("Validation failed — fix the highlighted issues before publishing.");
        return;
      }
      const res = await publishWorkflow(workflowId);
      await Promise.all([inv.invalidateWorkflow(), inv.invalidateVersions()]);
      setLocalNodes(null);
      toast.success(`Published version v${res.version}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Publish failed";
      setPublishError(msg);
      toast.error(`Publish failed: ${msg}`);
    } finally {
      setPublishing(false);
    }
  }

  const executionCounts = execution.data?.stateCounts;

  // -- loading / error states --------------------------------------------
  if (wfQuery.isLoading) {
    return (
      <div style={centerStyle}>
        <span style={{ color: colors.textMuted, fontSize: font.size.md }}>Loading workflow…</span>
      </div>
    );
  }

  if (wfQuery.isError || !wf) {
    return (
      <EmptyState
        icon="⚠"
        title="Failed to load workflow"
        description="The workflow could not be loaded. It may have been deleted, or the server is unreachable."
        action={
          <Button variant="secondary" onClick={onBack} leftIcon="←">
            Back to campaigns
          </Button>
        }
      />
    );
  }

  const isPublished = wf.status === "PUBLISHED";

  const crumbs: Crumb[] = [
    { label: "Campaigns", onClick: onBack },
    ...(wf.campaign ? [{ label: wf.campaign.name }] : []),
    { label: wf.name },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: colors.bg }}>
      {/* Builder header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: `1px solid ${colors.border}`,
          background: colors.panel,
          flexShrink: 0,
        }}
      >
        <IconButton label="Back to campaigns" icon="←" onClick={onBack} />
        <div style={{ width: 1, height: 18, background: colors.border }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Breadcrumbs items={crumbs} />
        </div>
        <StatusBadge status={wf.status} />
        {wf.latestVersion && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowVersions((v) => !v)}
            aria-expanded={showVersions}
          >
            v{wf.latestVersion.version}
          </Button>
        )}
        <SaveStatus saving={saving} error={saveError} savedAt={savedAt} />
      </div>

      {/* Tab bar */}
      <div style={{ flexShrink: 0 }}>
        <Tabs<Tab>
          active={activeTab}
          onChange={setActiveTab}
          items={[
            { key: "build", label: "Build" },
            { key: "enroll", label: "Enroll" },
            { key: "launch", label: "Launch" },
            { key: "monitor", label: "Monitor" },
          ]}
        />
      </div>

      {/* Versions drawer */}
      {showVersions && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: `1px solid ${colors.border}`,
            background: colors.panelAlt,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: colors.textMuted, fontSize: font.size.sm, fontWeight: font.weight.semibold }}>
            Version history
          </span>
          {versionsQuery.data?.length
            ? versionsQuery.data.map((v) => (
                <span
                  key={v.id}
                  style={{
                    fontSize: font.size.sm,
                    color: v.version === wf.latestVersion?.version ? colors.accent : colors.textDim,
                  }}
                >
                  v{v.version} · {v.instanceCount} instances · {formatTimestamp(v.publishedAt)}
                </span>
              ))
            : (
              <span style={{ fontSize: font.size.sm, color: colors.textDim }}>No published versions yet.</span>
            )}
        </div>
      )}

      {/* Validation errors */}
      {validationErrors.length > 0 && (
        <div
          style={{
            padding: "9px 16px",
            background: "rgba(248,81,73,0.08)",
            borderBottom: `1px solid ${colors.danger}`,
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: font.size.md, color: colors.danger, fontWeight: font.weight.semibold, marginBottom: 4 }}>
            Validation errors — fix before publishing:
          </div>
          {validationErrors.map((e, i) => (
            <div key={i} style={{ fontSize: font.size.sm, color: colors.danger }}>
              · {e}
            </div>
          ))}
        </div>
      )}

      {/* Main area */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {activeTab === "build" ? (
          <>
            {/* Left sidebar */}
            {!compact && (
              <div style={{ width: 260, flexShrink: 0, borderRight: `1px solid ${colors.border}` }}>
                <BuilderLeftSidebar
                  workflow={wf}
                  nodes={nodes}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                  execution={execution.data}
                  versionCount={versionsQuery.data?.length ?? 0}
                />
              </div>
            )}

            {/* Canvas */}
            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
              <BuilderCanvas
                nodes={nodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                executionCounts={executionCounts}
                published={isPublished}
              />

              {/* Publish bar */}
              <div
                style={{
                  position: "absolute",
                  bottom: 18,
                  left: "50%",
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  background: colors.panel,
                  border: `1px solid ${colors.border}`,
                  borderRadius: radii.lg,
                  padding: "8px 10px 8px 16px",
                  boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
                }}
              >
                <span style={{ fontSize: font.size.sm, color: colors.textMuted }}>
                  {isPublished ? "Re-publish to apply draft changes" : "Ready to go live?"}
                </span>
                <Button variant="primary" onClick={() => void handlePublish()} disabled={publishing}>
                  {publishing ? "Publishing…" : "Publish version"}
                </Button>
                {publishError && (
                  <span style={{ fontSize: font.size.sm, color: colors.danger }}>{publishError}</span>
                )}
              </div>
            </div>

            {/* Config panel — always present so the canvas doesn't reflow */}
            <div
              style={{
                width: 340,
                flexShrink: 0,
                borderLeft: `1px solid ${colors.border}`,
                background: colors.panel,
              }}
            >
              {selectedNode ? (
                <NodeConfigPanel
                  key={selectedNode.id}
                  node={selectedNode}
                  onUpdate={handleNodeUpdate}
                  onDelete={handleDeleteNode}
                  onMoveUp={handleMoveUp}
                  onMoveDown={handleMoveDown}
                  isFirst={selectedIndex === 0}
                  isLast={selectedIndex === sorted.length - 1}
                  saving={saving}
                  saveError={saveError}
                  savedAt={savedAt}
                />
              ) : (
                <EmptyState
                  compact
                  icon="⚙"
                  title="No step selected"
                  description="Select a step on the canvas or from the left panel to edit its configuration."
                />
              )}
            </div>
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

function SaveStatus({
  saving,
  error,
  savedAt,
}: {
  saving: boolean;
  error: string | null;
  savedAt: string | null;
}) {
  if (error) {
    return (
      <Tooltip content={error}>
        <span style={{ fontSize: font.size.sm, color: colors.danger, display: "inline-flex", alignItems: "center", gap: 5 }}>
          ● Save failed
        </span>
      </Tooltip>
    );
  }
  if (saving) {
    return <span style={{ fontSize: font.size.sm, color: colors.textDim }}>Saving…</span>;
  }
  if (savedAt) {
    return (
      <span style={{ fontSize: font.size.sm, color: colors.textDim, display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ color: colors.success }}>✓</span> Saved
      </span>
    );
  }
  return null;
}

const centerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
};
