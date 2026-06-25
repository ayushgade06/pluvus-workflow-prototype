import { useState } from "react";
import { launchWorkflow, useWorkflowExecution } from "../../api/builderClient";
import { colors, radii, font, stateColor, stateLabel } from "../../theme";
import { Button, StatTile, EmptyState, ConfirmDialog, SectionHeader, useToast } from "../ds";
import type { WorkflowDetail, LaunchResponse } from "../../api/builderTypes";
import type { InstanceState } from "../../api/types";

interface Props {
  workflow: WorkflowDetail;
  onLaunched: () => void;
}

const ALL_STATES: InstanceState[] = [
  "ENROLLED",
  "OUTREACH_SENT",
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

export function LaunchTab({ workflow, onLaunched }: Props) {
  const execution = useWorkflowExecution(workflow.id);
  const [showConfirm, setShowConfirm] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<LaunchResponse | null>(null);
  const toast = useToast();

  const hasVersion = !!workflow.latestVersion;
  const data = execution.data;
  const enrolledCount = data?.stateCounts["ENROLLED"] ?? 0;
  const totalInstances = data?.totalInstances ?? 0;
  const hasLaunched = totalInstances > 0 && (data?.stateCounts["OUTREACH_SENT"] ?? 0) > 0;

  async function handleLaunch() {
    setLaunching(true);
    try {
      const r = await launchWorkflow(workflow.id);
      setResult(r);
      setShowConfirm(false);
      toast.success(`Launched ${r.launched} creator${r.launched !== 1 ? "s" : ""}.`);
      onLaunched();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Launch failed");
      setShowConfirm(false);
    } finally {
      setLaunching(false);
    }
  }

  if (!hasVersion) {
    return <EmptyState icon="🔒" title="Workflow not published" description="Publish the workflow before launching." />;
  }
  if (totalInstances === 0) {
    return <EmptyState icon="👥" title="No creators enrolled" description="Enroll creators on the Enroll tab before launching." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "20px 24px", gap: 20, overflow: "auto" }}>
      {/* Headline tiles */}
      <div style={{ display: "flex", gap: 16 }}>
        <StatTile label="Version" value={`v${workflow.latestVersion?.version}`} />
        <StatTile label="Enrolled" value={totalInstances} color={colors.accent} />
        <StatTile
          label="Ready to Launch"
          value={enrolledCount}
          color={enrolledCount > 0 ? colors.success : colors.textMuted}
        />
      </div>

      {result && (
        <div
          style={{
            padding: "12px 16px",
            background: `${colors.success}1a`,
            border: `1px solid ${colors.success}`,
            borderRadius: radii.md,
            fontSize: font.size.md,
            color: colors.success,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: font.weight.bold, marginBottom: 4 }}>
            ✓ Launched {result.launched} creator{result.launched !== 1 ? "s" : ""}
          </div>
          <div style={{ fontSize: font.size.sm }}>
            Real outreach emails will be sent as the workers process the queue. Switch to the Monitor
            tab to watch progress.
          </div>
        </div>
      )}

      {/* State breakdown */}
      {data && Object.keys(data.stateCounts).length > 0 && (
        <div>
          <SectionHeader>Current State Breakdown</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ALL_STATES.filter((s) => (data.stateCounts[s] ?? 0) > 0).map((s) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: stateColor[s], flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: font.size.md, color: colors.text }}>{stateLabel[s]}</span>
                <span style={{ fontSize: font.size.md, fontWeight: font.weight.bold, color: stateColor[s], minWidth: 30, textAlign: "right" }}>
                  {data.stateCounts[s]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Launch action */}
      {enrolledCount > 0 && (
        <Button
          variant="primary"
          onClick={() => setShowConfirm(true)}
          style={{ height: 44, fontSize: font.size.lg }}
          rightIcon="→"
        >
          Launch {enrolledCount} creator{enrolledCount !== 1 ? "s" : ""}
        </Button>
      )}

      {hasLaunched && enrolledCount === 0 && (
        <div
          style={{
            padding: "12px 16px",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            fontSize: font.size.md,
            color: colors.textMuted,
          }}
        >
          All enrolled creators have been launched. Enroll more creators to send additional outreach.
        </div>
      )}

      {showConfirm && (
        <ConfirmDialog
          title="Confirm launch"
          confirmLabel="Launch"
          busy={launching}
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => void handleLaunch()}
          message={
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  padding: "10px 14px",
                  background: `${colors.warning}1a`,
                  border: `1px solid ${colors.warning}`,
                  borderRadius: radii.sm,
                  fontSize: font.size.sm,
                  color: colors.warning,
                  lineHeight: 1.5,
                }}
              >
                ⚠ This will enqueue real outreach jobs for {enrolledCount} creator
                {enrolledCount !== 1 ? "s" : ""}. If the server is configured with a live email
                provider, real emails will be sent.
              </div>
              <div>
                Launch execution for <strong style={{ color: colors.text }}>{workflow.name}</strong>?
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}
