import { useState } from "react";
import { useWorkflowExecution } from "../../api/builderClient";
import { POLL_INTERVAL_MS } from "../../api/client";
import { colors, radii, font, stateColor, stateLabel, formatTimestamp } from "../../theme";
import { StatTile, EmptyState, SectionHeader } from "../ds";
import { InstanceInspector } from "../InstanceInspector";
import type { WorkflowDetail } from "../../api/builderTypes";
import type { InstanceState } from "../../api/types";

interface Props {
  workflow: WorkflowDetail;
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

const TERMINAL = new Set<InstanceState>([
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
    return <EmptyState icon="📡" title="Nothing to monitor yet" description="Publish and launch the workflow to start monitoring." />;
  }
  if (!data || data.totalInstances === 0) {
    return (
      <EmptyState
        icon="📡"
        title="No creators enrolled yet"
        description={`Enroll and launch to begin monitoring. Auto-refreshes every ${POLL_INTERVAL_MS / 1000}s.`}
      />
    );
  }

  const total = data.totalInstances;
  const active = Object.entries(data.stateCounts)
    .filter(([s]) => !TERMINAL.has(s as InstanceState))
    .reduce((a, [, v]) => a + v, 0);
  const terminal = total - active;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", padding: "20px 24px", gap: 20 }}>
        {/* Live header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: execution.isFetching ? colors.warning : colors.success,
              boxShadow: `0 0 6px ${execution.isFetching ? colors.warning : colors.success}`,
            }}
          />
          <span style={{ fontSize: font.size.md, color: colors.textMuted }}>
            Live · v{workflow.latestVersion?.version} · {POLL_INTERVAL_MS / 1000}s refresh
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim, marginLeft: "auto" }}>
            {formatTimestamp(data.generatedAt)}
          </span>
        </div>

        {/* Totals */}
        <div style={{ display: "flex", gap: 12 }}>
          <StatTile label="Total" value={total} />
          <StatTile label="Active" value={active} color={colors.accent} />
          <StatTile label="Terminal" value={terminal} color={colors.success} />
        </div>

        {/* Pipeline progress */}
        <div>
          <SectionHeader>Pipeline Progress</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ALL_STATES.filter((s) => (data.stateCounts[s] ?? 0) > 0 || !TERMINAL.has(s)).map((s) => {
              const count = data.stateCounts[s] ?? 0;
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: count > 0 ? stateColor[s] : colors.border, flexShrink: 0 }} />
                  <span style={{ width: 120, fontSize: font.size.md, color: count > 0 ? colors.text : colors.textDim, flexShrink: 0 }}>
                    {stateLabel[s]}
                  </span>
                  <div style={{ flex: 1, height: 6, background: colors.bg, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: stateColor[s], borderRadius: 3, transition: "width 0.6s ease" }} />
                  </div>
                  <span style={{ width: 30, textAlign: "right", fontSize: font.size.md, fontWeight: count > 0 ? font.weight.bold : font.weight.regular, color: count > 0 ? stateColor[s] : colors.textDim, flexShrink: 0 }}>
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent transitions */}
        {data.recentEvents.length > 0 && (
          <div>
            <SectionHeader>Recent Transitions</SectionHeader>
            <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: radii.md, overflow: "hidden" }}>
              {data.recentEvents.slice(0, 10).map((e) => {
                const payload = e.payload as Record<string, string> | null;
                const from = payload?.["from"] ?? "?";
                const to = payload?.["to"] ?? "?";
                return (
                  <button
                    key={e.id}
                    onClick={() => setSelectedInstanceId(e.instanceId)}
                    className="ds-focusable ds-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 14px",
                      borderBottom: `1px solid ${colors.border}`,
                      cursor: "pointer",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      borderBottomColor: colors.border,
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: font.size.md, color: colors.text }}>{e.creatorName}</span>
                      {e.creatorHandle && (
                        <span style={{ fontSize: font.size.sm, color: colors.textMuted, marginLeft: 6 }}>@{e.creatorHandle}</span>
                      )}
                    </span>
                    <span style={{ fontSize: font.size.md, color: colors.textMuted }}>
                      <span style={{ color: stateColor[from as InstanceState] ?? colors.textMuted }}>{from}</span>
                      {" → "}
                      <span style={{ color: stateColor[to as InstanceState] ?? colors.textMuted }}>{to}</span>
                    </span>
                    <span style={{ fontSize: font.size.sm, color: colors.textDim, flexShrink: 0 }}>
                      {formatTimestamp(e.occurredAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Inspector panel */}
      {selectedInstanceId && (
        <div style={{ width: 400, flexShrink: 0, borderLeft: `1px solid ${colors.border}` }}>
          <InstanceInspector instanceId={selectedInstanceId} onClose={() => setSelectedInstanceId(null)} />
        </div>
      )}
    </div>
  );
}
