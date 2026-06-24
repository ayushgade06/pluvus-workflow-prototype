// ---------------------------------------------------------------------------
// Timeline — chronological event stream for one instance (Part 5).
// ---------------------------------------------------------------------------
// Vertical timeline. State transitions are emphasised (they're the spine of the
// lifecycle); other events sit as lighter nodes. Each entry shows what happened,
// what triggered it (source), and when.

import type { TimelineEntry } from "../api/types";
import { colors, formatTimestamp } from "../theme";
import { SourceBadge, Empty } from "./ui";

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <Empty>No events recorded yet.</Empty>;

  return (
    <div style={{ position: "relative", paddingLeft: 18 }}>
      {/* Spine */}
      <div
        style={{
          position: "absolute",
          left: 5,
          top: 4,
          bottom: 4,
          width: 2,
          background: colors.border,
        }}
      />
      {entries.map((e) => {
        const isTransition = e.type === "STATE_TRANSITION";
        const dotColor = isTransition ? colors.accent : colors.borderStrong;
        return (
          <div key={e.id} style={{ position: "relative", paddingBottom: 16 }}>
            <span
              style={{
                position: "absolute",
                left: -16,
                top: 3,
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: isTransition ? dotColor : colors.panel,
                border: `2px solid ${dotColor}`,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: isTransition ? 600 : 500,
                  color: isTransition ? colors.text : colors.textMuted,
                }}
              >
                {e.summary}
              </span>
              {e.source && <SourceBadge source={e.source} />}
            </div>
            <div style={{ fontSize: 10.5, color: colors.textDim, marginTop: 3 }}>
              {formatTimestamp(e.occurredAt)}
              <span style={{ margin: "0 6px", opacity: 0.4 }}>·</span>
              <span className="mono">{e.type}</span>
              {e.nodeId && (
                <>
                  <span style={{ margin: "0 6px", opacity: 0.4 }}>·</span>
                  <span className="mono">{e.nodeId}</span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
