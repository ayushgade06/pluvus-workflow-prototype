import { useState } from "react";
import { launchWorkflow, useWorkflowExecution } from "../../api/builderClient";
import { colors, stateColor, stateLabel } from "../../theme";
import type { WorkflowDetail, LaunchResponse } from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  onLaunched: () => void;
}

const ALL_STATES = [
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
] as const;

export function LaunchTab({ workflow, onLaunched }: Props) {
  const execution = useWorkflowExecution(workflow.id);
  const [showConfirm, setShowConfirm] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<LaunchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasVersion = !!workflow.latestVersion;
  const data = execution.data;
  const enrolledCount = data?.stateCounts["ENROLLED"] ?? 0;
  const totalInstances = data?.totalInstances ?? 0;
  const hasLaunched = totalInstances > 0 && (data?.stateCounts["OUTREACH_SENT"] ?? 0) > 0;

  async function handleLaunch() {
    setLaunching(true);
    setError(null);
    try {
      const r = await launchWorkflow(workflow.id);
      setResult(r);
      setShowConfirm(false);
      onLaunched();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setLaunching(false);
    }
  }

  if (!hasVersion) {
    return <Blocker message="Publish the workflow before launching." />;
  }
  if (totalInstances === 0) {
    return <Blocker message="Enroll creators before launching." />;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "20px 24px",
        gap: 20,
        overflow: "auto",
      }}
    >
      {/* Version info */}
      <div
        style={{
          padding: "12px 16px",
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          display: "flex",
          gap: 24,
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 11, color: colors.textDim, textTransform: "uppercase", marginBottom: 2 }}>
            Version
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>
            v{workflow.latestVersion?.version}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: colors.textDim, textTransform: "uppercase", marginBottom: 2 }}>
            Enrolled
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: colors.accent }}>
            {totalInstances}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: colors.textDim, textTransform: "uppercase", marginBottom: 2 }}>
            Ready to Launch
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: enrolledCount > 0 ? colors.success : colors.textMuted }}>
            {enrolledCount}
          </div>
        </div>
      </div>

      {/* State breakdown */}
      {data && Object.keys(data.stateCounts).length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, fontWeight: 600 }}>
            Current State Breakdown
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ALL_STATES.filter((s) => (data.stateCounts[s] ?? 0) > 0).map((s) => (
              <div
                key={s}
                style={{ display: "flex", alignItems: "center", gap: 10 }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: stateColor[s],
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1, fontSize: 12.5, color: colors.text }}>
                  {stateLabel[s]}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: stateColor[s],
                    minWidth: 30,
                    textAlign: "right",
                  }}
                >
                  {data.stateCounts[s]}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div
          style={{
            padding: "12px 16px",
            background: "rgba(63,185,80,0.1)",
            border: `1px solid ${colors.success}`,
            borderRadius: 8,
            fontSize: 13,
            color: colors.success,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            ✓ Launched {result.launched} creator{result.launched !== 1 ? "s" : ""}
          </div>
          <div style={{ fontSize: 12 }}>
            Real outreach emails will be sent as the workers process the queue.
            Switch to the Monitor tab to watch progress.
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(248,81,73,0.1)",
            border: `1px solid ${colors.danger}`,
            borderRadius: 6,
            fontSize: 13,
            color: colors.danger,
          }}
        >
          {error}
        </div>
      )}

      {/* Launch button */}
      {enrolledCount > 0 && (
        <button
          onClick={() => setShowConfirm(true)}
          style={{
            padding: "12px",
            background: colors.accent,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 700,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          Launch {enrolledCount} Creator{enrolledCount !== 1 ? "s" : ""} →
        </button>
      )}

      {hasLaunched && enrolledCount === 0 && (
        <div
          style={{
            padding: "12px 16px",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 8,
            fontSize: 13,
            color: colors.textMuted,
          }}
        >
          All enrolled creators have been launched. Enroll more creators to send additional outreach.
        </div>
      )}

      {/* Confirmation modal */}
      {showConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              padding: "24px",
              width: 420,
              maxWidth: "90vw",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: colors.text, marginBottom: 12 }}>
              Confirm Launch
            </div>
            <div
              style={{
                padding: "10px 14px",
                background: "rgba(210,153,34,0.1)",
                border: `1px solid ${colors.warning}`,
                borderRadius: 6,
                fontSize: 12.5,
                color: colors.warning,
                marginBottom: 16,
                lineHeight: 1.5,
              }}
            >
              ⚠ This will enqueue real outreach jobs for {enrolledCount} creator
              {enrolledCount !== 1 ? "s" : ""}. If the server is configured with a live
              email provider, real emails will be sent.
            </div>
            <div style={{ fontSize: 13, color: colors.textMuted, marginBottom: 20 }}>
              Are you sure you want to launch execution for <strong style={{ color: colors.text }}>{workflow.name}</strong>?
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{
                  padding: "8px 16px",
                  background: "none",
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  color: colors.textMuted,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void handleLaunch()}
                disabled={launching}
                style={{
                  padding: "8px 20px",
                  background: launching ? colors.border : colors.accent,
                  color: launching ? colors.textDim : "#fff",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: launching ? "not-allowed" : "pointer",
                }}
              >
                {launching ? "Launching…" : "Launch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Blocker({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: colors.textMuted,
        fontSize: 13,
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 28 }}>🔒</div>
      <div>{message}</div>
    </div>
  );
}
