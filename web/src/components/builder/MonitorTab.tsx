import { useState } from "react";
import { useWorkflowExecution } from "../../api/builderClient";
import { POLL_INTERVAL_MS } from "../../api/client";
import { colors, stateColor, stateLabel, formatTimestamp } from "../../theme";
import { InstanceInspector } from "../InstanceInspector";
import type { WorkflowDetail } from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
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

const TERMINAL = new Set([
  "ACCEPTED",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
]);

export function MonitorTab({ workflow }: Props) {
  const execution = useWorkflowExecution(workflow.id);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  const data = execution.data;
  const hasVersion = !!workflow.latestVersion;

  if (!hasVersion) {
    return <Blocker message="Publish and launch the workflow to start monitoring." />;
  }
  if (!data || data.totalInstances === 0) {
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
        <div style={{ fontSize: 28 }}>📡</div>
        <div>No creators enrolled yet. Enroll and launch to begin monitoring.</div>
        <div style={{ fontSize: 11, color: colors.textDim }}>
          Auto-refreshes every {POLL_INTERVAL_MS / 1000}s
        </div>
      </div>
    );
  }

  const total = data.totalInstances;
  const active = Object.entries(data.stateCounts)
    .filter(([s]) => !TERMINAL.has(s))
    .reduce((a, [, v]) => a + v, 0);
  const terminal = total - active;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
          padding: "20px 24px",
          gap: 20,
        }}
      >
        {/* Live header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: execution.isFetching ? colors.warning : colors.success,
              boxShadow: `0 0 6px ${execution.isFetching ? colors.warning : colors.success}`,
            }}
          />
          <span style={{ fontSize: 12.5, color: colors.textMuted }}>
            Live · v{workflow.latestVersion?.version} · {POLL_INTERVAL_MS / 1000}s refresh
          </span>
          <span style={{ fontSize: 12, color: colors.textDim, marginLeft: "auto" }}>
            {formatTimestamp(data.generatedAt)}
          </span>
        </div>

        {/* Totals */}
        <div style={{ display: "flex", gap: 12 }}>
          <StatPill label="Total" value={total} />
          <StatPill label="Active" value={active} color={colors.accent} />
          <StatPill label="Terminal" value={terminal} color={colors.success} />
        </div>

        {/* State progress bars */}
        <div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, fontWeight: 600 }}>
            Pipeline Progress
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ALL_STATES.filter((s) => (data.stateCounts[s] ?? 0) > 0 || !TERMINAL.has(s)).map((s) => {
              const count = data.stateCounts[s] ?? 0;
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: count > 0 ? stateColor[s] : colors.border,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ width: 120, fontSize: 12, color: count > 0 ? colors.text : colors.textDim, flexShrink: 0 }}>
                    {stateLabel[s]}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      height: 6,
                      background: colors.bg,
                      borderRadius: 3,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: stateColor[s],
                        borderRadius: 3,
                        transition: "width 0.6s ease",
                      }}
                    />
                  </div>
                  <div
                    style={{
                      width: 30,
                      textAlign: "right",
                      fontSize: 12.5,
                      fontWeight: count > 0 ? 700 : 400,
                      color: count > 0 ? stateColor[s] : colors.textDim,
                      flexShrink: 0,
                    }}
                  >
                    {count}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent transitions */}
        {data.recentEvents.length > 0 && (
          <div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10, fontWeight: 600 }}>
              Recent Transitions
            </div>
            <div
              style={{
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {data.recentEvents.slice(0, 10).map((e) => {
                const payload = e.payload as Record<string, string> | null;
                const from = payload?.["from"] ?? "?";
                const to = payload?.["to"] ?? "?";
                return (
                  <div
                    key={e.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 14px",
                      borderBottom: `1px solid ${colors.border}`,
                      cursor: "pointer",
                    }}
                    onClick={() => setSelectedInstanceId(e.instanceId)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, color: colors.text }}>
                        {e.creatorName}
                      </span>
                      {e.creatorHandle && (
                        <span style={{ fontSize: 11.5, color: colors.textMuted, marginLeft: 6 }}>
                          @{e.creatorHandle}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: colors.textMuted }}>
                      <span style={{ color: stateColor[from as keyof typeof stateColor] ?? colors.textMuted }}>
                        {from}
                      </span>
                      {" → "}
                      <span style={{ color: stateColor[to as keyof typeof stateColor] ?? colors.textMuted }}>
                        {to}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: colors.textDim, flexShrink: 0 }}>
                      {formatTimestamp(e.occurredAt)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Inspector panel */}
      {selectedInstanceId && (
        <div
          style={{
            width: 400,
            flexShrink: 0,
            borderLeft: `1px solid ${colors.border}`,
          }}
        >
          <InstanceInspector
            instanceId={selectedInstanceId}
            onClose={() => setSelectedInstanceId(null)}
          />
        </div>
      )}
    </div>
  );
}

function StatPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        padding: "10px 14px",
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 700, color: color ?? colors.text }}>
        {value}
      </div>
      <div
        style={{
          fontSize: 10,
          color: colors.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {label}
      </div>
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
      <div style={{ fontSize: 28 }}>📡</div>
      <div>{message}</div>
    </div>
  );
}
