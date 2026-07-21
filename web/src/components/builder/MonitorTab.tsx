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
  "REWARD_PENDING",
  "REWARD_CONFIRMED",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "CONTENT_BRIEF_SENT",
  "NEEDS_DEAL_FINALIZATION",
  "HANDOFF_COMPLETE",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
];

const TERMINAL = new Set<InstanceState>([
  // ACCEPTED, REWARD_CONFIRMED and PAYMENT_RECEIVED auto-advance (Reward Setup /
  // Payment Info / Content Brief), so they're no longer terminal;
  // CONTENT_BRIEF_SENT is the success terminal.
  "CONTENT_BRIEF_SENT",
  // PLU-70: NEEDS_DEAL_FINALIZATION is NOT terminal — it is parked on an
  // operator. HANDOFF_COMPLETE is that branch's success terminal.
  "HANDOFF_COMPLETE",
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

  const needsReview = data.stateCounts["MANUAL_REVIEW"] ?? 0;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div className="ds-fade-in" style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div
          style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "24px 28px 40px",
            display: "flex",
            flexDirection: "column",
            gap: 24,
          }}
        >
        {/* Live header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className={execution.isFetching ? undefined : "ds-pulse"}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: execution.isFetching ? colors.warning : colors.success,
              boxShadow: `0 0 8px ${execution.isFetching ? colors.warning : colors.success}66`,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: font.size.md, fontWeight: font.weight.medium, color: colors.text }}>
            Live
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
            v{workflow.latestVersion?.version} · refreshes every {POLL_INTERVAL_MS / 1000}s
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim, marginLeft: "auto" }}>
            Updated {formatTimestamp(data.generatedAt)}
          </span>
        </div>

        {/* Totals */}
        <div style={{ display: "flex", gap: 14 }}>
          <StatTile label="Total Creators" value={total} />
          <StatTile label="Active" value={active} color={colors.accent} />
          <StatTile label="Completed" value={terminal} color={colors.success} />
          <StatTile
            label="Needs Review"
            value={needsReview}
            color={needsReview > 0 ? colors.warning : colors.textMuted}
          />
        </div>

        {/* Pipeline progress */}
        <div>
          <SectionHeader>Pipeline Progress</SectionHeader>
          <div
            style={{
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              padding: "16px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 11,
            }}
          >
            {ALL_STATES.filter((s) => (data.stateCounts[s] ?? 0) > 0 || !TERMINAL.has(s)).map((s) => {
              const count = data.stateCounts[s] ?? 0;
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: count > 0 ? stateColor[s] : colors.borderStrong, flexShrink: 0 }} />
                  <span style={{ width: 136, fontSize: font.size.sm, fontWeight: font.weight.medium, color: count > 0 ? colors.text : colors.textDim, flexShrink: 0 }}>
                    {stateLabel[s]}
                  </span>
                  <div style={{ flex: 1, height: 6, background: colors.bg, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: stateColor[s], borderRadius: 3, transition: "width 0.6s cubic-bezier(0.25, 1, 0.5, 1)" }} />
                  </div>
                  <span
                    className="nums"
                    style={{ width: 34, textAlign: "right", fontSize: font.size.md, fontWeight: count > 0 ? font.weight.semibold : font.weight.regular, color: count > 0 ? stateColor[s] : colors.textDim, flexShrink: 0 }}
                  >
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
            <SectionHeader>Recent Activity</SectionHeader>
            <div
              style={{
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                overflow: "hidden",
              }}
            >
              {data.recentEvents.slice(0, 10).map((e, i) => {
                const payload = e.payload as Record<string, string> | null;
                const from = payload?.["from"] ?? "?";
                const to = payload?.["to"] ?? "?";
                const fromLabel = stateLabel[from as InstanceState] ?? from;
                const toLabel = stateLabel[to as InstanceState] ?? to;
                return (
                  <button
                    key={e.id}
                    onClick={() => setSelectedInstanceId(e.instanceId)}
                    className="ds-focusable ds-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 16px",
                      cursor: "pointer",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      borderTop: i > 0 ? `1px solid ${colors.border}` : "none",
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: font.size.md, fontWeight: font.weight.medium, color: colors.text }}>{e.creatorName}</span>
                      {e.creatorHandle && (
                        <span style={{ fontSize: font.size.sm, color: colors.textDim, marginLeft: 6 }}>@{e.creatorHandle}</span>
                      )}
                    </span>
                    <span style={{ fontSize: font.size.sm, color: colors.textMuted, whiteSpace: "nowrap" }}>
                      <span style={{ color: stateColor[from as InstanceState] ?? colors.textMuted }}>{fromLabel}</span>
                      <span aria-hidden style={{ color: colors.textDim, margin: "0 6px" }}>→</span>
                      <span style={{ color: stateColor[to as InstanceState] ?? colors.textMuted }}>{toLabel}</span>
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
      </div>

      {/* Inspector panel */}
      {selectedInstanceId && (
        <div
          className="ds-slide-in-right"
          style={{
            width: 400,
            flexShrink: 0,
            borderLeft: `1px solid ${colors.border}`,
            background: colors.panel,
          }}
        >
          <InstanceInspector instanceId={selectedInstanceId} onClose={() => setSelectedInstanceId(null)} />
        </div>
      )}
    </div>
  );
}
