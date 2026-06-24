// ---------------------------------------------------------------------------
// LogsTrace — the transition trace / end-to-end traceability view (Part 10).
// ---------------------------------------------------------------------------
// Each row is one state transition with the persisted attribution: who
// triggered it (source), which worker performed the write, and the queue job id
// that drove it. This reconstructs "Queue Job → Worker → Transition → Event"
// for a single creator.

import type { LogEntry } from "../api/types";
import { colors, formatTimestamp } from "../theme";
import { SourceBadge, Empty } from "./ui";

export function LogsTrace({ trace }: { trace: LogEntry[] }) {
  if (trace.length === 0) return <Empty>No transitions recorded yet.</Empty>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {trace.map((t, i) => (
        <div
          key={i}
          style={{
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: 7,
            padding: "9px 11px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: colors.text }}>
              {t.fromState ?? "?"}
            </span>
            <span style={{ color: colors.textDim }}>→</span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: colors.accent }}>
              {t.toState ?? "?"}
            </span>
            <span style={{ marginLeft: "auto" }}>
              <SourceBadge source={t.source} />
            </span>
          </div>
          <div
            style={{
              display: "flex",
              gap: 14,
              marginTop: 6,
              fontSize: 10.5,
              color: colors.textDim,
              flexWrap: "wrap",
            }}
          >
            <span>{formatTimestamp(t.occurredAt)}</span>
            {t.worker && (
              <span>
                worker <span className="mono" style={{ color: colors.textMuted }}>{t.worker}</span>
              </span>
            )}
            {t.queueJobId && (
              <span>
                job <span className="mono" style={{ color: colors.textMuted }}>{t.queueJobId}</span>
              </span>
            )}
            {t.nodeId && (
              <span>
                node <span className="mono" style={{ color: colors.textMuted }}>{t.nodeId}</span>
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
