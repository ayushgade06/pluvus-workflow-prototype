// ---------------------------------------------------------------------------
// ObserveInsights — the right-hand insights column on the Observability screen.
// ---------------------------------------------------------------------------
// Reads the same WorkflowNodeSummary[] the graph uses and surfaces it as four
// focused sticker cards: Pipeline Summary (donut), Stage Distribution (top
// stages by count), Needs Attention (stuck stages), Recent state list. Purely
// presentational; clicking a stage row selects that state in the graph.
import { AlertTriangle } from "lucide-react";
import type { InstanceState, WorkflowNodeSummary } from "../api/types";
import { colors, radii, font, stateColor, stateLabel } from "../theme";
import { Donut, type DonutSlice } from "./ds";

type Focus = "flow" | "metrics" | "events" | "attention";

export function ObserveInsights({
  nodes,
  focus,
  onSelectState,
}: {
  nodes: WorkflowNodeSummary[];
  focus: Focus;
  onSelectState: (state: string) => void;
}) {
  const total = nodes.reduce((a, n) => a + n.count, 0);
  const active = nodes.filter((n) => !n.terminal).reduce((a, n) => a + n.count, 0);
  const terminal = nodes.filter((n) => n.terminal).reduce((a, n) => a + n.count, 0);
  const stuck = nodes.reduce((a, n) => a + n.stuck, 0);

  const distribution: DonutSlice[] = [
    { label: "Active", value: active, color: colors.accent },
    { label: "Completed", value: terminal, color: colors.success },
  ];

  // Stages with creators in them, biggest first.
  const populated = nodes
    .filter((n) => n.count > 0)
    .sort((a, b) => b.count - a.count);

  const stuckStages = nodes.filter((n) => n.stuck > 0).sort((a, b) => b.stuck - a.stuck);

  // When a tab is focused, lead with that section; the rest still follow.
  const order: Focus[] =
    focus === "attention"
      ? ["attention", "metrics", "events"]
      : focus === "events"
      ? ["events", "metrics", "attention"]
      : focus === "metrics"
      ? ["metrics", "attention", "events"]
      : ["metrics", "attention", "events"];

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Pipeline Summary — always at the top */}
      <Section title="Pipeline Summary">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Donut data={distribution} total={total} totalLabel="Total" size={112} />
          <div style={{ display: "flex", flexDirection: "column", gap: 9, flex: 1, minWidth: 0 }}>
            <SummaryRow label="Active" value={active} color={colors.accent} />
            <SummaryRow label="Completed" value={terminal} color={colors.success} />
            <SummaryRow label="Stuck" value={stuck} color={stuck > 0 ? colors.warning : colors.textDim} />
          </div>
        </div>
      </Section>

      {order.map((sec) => {
        if (sec === "metrics") {
          return (
            <Section key="metrics" title="Stage Distribution">
              {populated.length === 0 ? (
                <Empty>No creators enrolled.</Empty>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {populated.slice(0, 8).map((n) => {
                    const pct = total > 0 ? (n.count / total) * 100 : 0;
                    return (
                      <button
                        key={n.state}
                        onClick={() => onSelectState(n.state)}
                        className="ds-focusable ds-row"
                        style={rowBtn}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor[n.state], flexShrink: 0 }} />
                          <span style={{ fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.text, flex: 1, textAlign: "left" }}>
                            {stateLabel[n.state]}
                          </span>
                          <span className="nums" style={{ fontSize: font.size.sm, fontWeight: font.weight.bold, color: colors.text }}>{n.count}</span>
                        </span>
                        <span style={{ display: "block", height: 7, background: colors.panelAlt, border: `1.5px solid ${colors.cardBorder}`, borderRadius: radii.pill, overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", width: `${pct}%`, background: stateColor[n.state] }} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Section>
          );
        }
        if (sec === "attention") {
          return (
            <Section key="attention" title="Blocked · Needs Attention">
              {stuckStages.length === 0 ? (
                <Empty>Nothing stuck. All stages moving.</Empty>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {stuckStages.map((n) => (
                    <button key={n.state} onClick={() => onSelectState(n.state)} className="ds-focusable ds-row" style={rowBtn}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <AlertTriangle size={14} strokeWidth={2.25} color={colors.warning} style={{ flexShrink: 0 }} />
                        <span style={{ fontSize: font.size.sm, fontWeight: font.weight.semibold, color: colors.text, flex: 1, textAlign: "left" }}>
                          {stateLabel[n.state]}
                        </span>
                        <span className="nums" style={{ fontSize: font.size.sm, fontWeight: font.weight.bold, color: colors.warning }}>{n.stuck} stuck</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Section>
          );
        }
        // events — a compact list of populated stages as a recent-state snapshot
        return (
          <Section key="events" title="Stages In Play">
            {populated.length === 0 ? (
              <Empty>No activity yet.</Empty>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                {populated.map((n) => (
                  <button
                    key={n.state}
                    onClick={() => onSelectState(n.state)}
                    className="ds-focusable"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "3px 10px",
                      background: `${stateColor[n.state]}26`,
                      border: `1.5px solid ${colors.cardBorder}`,
                      borderRadius: radii.pill,
                      fontSize: font.size.xs,
                      fontWeight: font.weight.semibold,
                      color: colors.text,
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: stateColor[n.state] }} />
                    {stateLabel[n.state]}
                    <span className="nums">{n.count}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>
        );
      })}
    </div>
  );
}

const rowBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  background: "transparent",
  border: "none",
  borderRadius: radii.sm,
  cursor: "pointer",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: colors.panel,
        border: `2px solid ${colors.cardBorder}`,
        borderRadius: radii.md,
        boxShadow: "3px 3px 0 var(--shadowInk)",
        padding: "14px 15px",
      }}
    >
      <div
        style={{
          fontSize: font.size.xs,
          fontWeight: font.weight.bold,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          color: colors.textMuted,
          marginBottom: 12,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function SummaryRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color, border: `1.5px solid ${colors.cardBorder}`, flexShrink: 0 }} />
      <span style={{ fontSize: font.size.sm, color: colors.textMuted, flex: 1 }}>{label}</span>
      <span className="nums serif" style={{ fontSize: font.size.lg, fontWeight: font.weight.bold, color: colors.text }}>{value}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: font.size.sm, color: colors.textDim, lineHeight: 1.5 }}>{children}</div>;
}

// Re-export the state type so callers don't need a separate import for the cast.
export type { InstanceState };
