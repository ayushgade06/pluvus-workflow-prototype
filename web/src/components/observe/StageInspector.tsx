// ---------------------------------------------------------------------------
// StageInspector — the right-hand panel shown when a stage node is selected.
// ---------------------------------------------------------------------------
// Operational detail for one stage, all from real data:
//   • Stage Details — live count, avg duration, oldest creator, incoming /
//     outgoing transitions, and a derived bottleneck flag (honest — labelled).
//   • Recent creators entering — the fetched instance list, most-recent first.
//   • Recent events — the last event per creator (lastEventType/lastEventAt).
// Clicking a creator opens the full InstanceInspector (unchanged).
import { useEffect, useMemo } from "react";
import { X, ArrowRight, ArrowDownRight, Users, Clock, AlertTriangle, Activity } from "lucide-react";
import type { InstanceState, InstanceListItem, WorkflowNodeSummary } from "../../api/types";
import { useInstances } from "../../api/client";
import {
  colors,
  radii,
  font,
  stateColor,
  stateLabel,
  stateDescription,
  formatDuration,
  relativeTime,
} from "../../theme";
import { EmptyState, SkeletonRows } from "../ds";
import { stateIcon } from "./stateIcons";
import { nodeStatus, STATUS_LABEL, oldestWaiter } from "./metrics";
import { transitionsFor } from "./stateGraph";

interface Props {
  state: InstanceState;
  summary: WorkflowNodeSummary | undefined;
  workflowVersionId?: string | null;
  isBottleneck: boolean;
  selectedInstanceId: string | null;
  onSelectInstance: (id: string) => void;
  onClose: () => void;
  /** Report the longest-waiting duration back up so the node card can show it. */
  onOldest?: (state: InstanceState, seconds: number | null) => void;
}

export function StageInspector({
  state,
  summary,
  workflowVersionId,
  isBottleneck,
  selectedInstanceId,
  onSelectInstance,
  onClose,
  onOldest,
}: Props) {
  const { data, isLoading, isError } = useInstances({ state, workflowVersionId });
  const items = data?.items ?? [];
  const accent = stateColor[state];
  const Icon = stateIcon(state);
  const status = summary ? nodeStatus(summary) : "idle";

  const oldest = useMemo(() => oldestWaiter(items), [items]);
  useEffect(() => {
    onOldest?.(state, oldest?.waitingForSeconds ?? null);
  }, [state, oldest, onOldest]);

  const { incoming, outgoing } = transitionsFor(state);

  // Recent entrants = most recently updated first (a proxy for "just entered"
  // given the snapshot API — updatedAt moves when the instance transitions in).
  const recent = useMemo(
    () => [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 6),
    [items],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: "16px 16px 14px", borderBottom: `1px solid ${colors.hairline}` }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
          <span
            aria-hidden
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: `${accent}1c`,
              border: `1px solid ${accent}33`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: accent,
              flexShrink: 0,
            }}
          >
            <Icon size={17} strokeWidth={2.1} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: font.size.lg, fontWeight: font.weight.bold, color: colors.text }}>
                {stateLabel[state]}
              </h2>
              <span
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: accent,
                  background: `${accent}1a`,
                  border: `1px solid ${accent}33`,
                  borderRadius: 999,
                  padding: "2px 8px",
                }}
              >
                {STATUS_LABEL[status]}
              </span>
            </div>
            <p style={{ margin: "5px 0 0", fontSize: font.size.sm, color: colors.textDim, lineHeight: 1.45 }}>
              {stateDescription[state]}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ds-focusable ds-iconbtn"
            style={{ background: "none", border: "none", color: colors.textMuted, cursor: "pointer", borderRadius: 7, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <X size={16} />
          </button>
        </div>

        {isBottleneck && (
          <div
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              background: `${colors.warning}14`,
              border: `1px solid ${colors.warning}40`,
              borderRadius: radii.sm,
              fontSize: font.size.sm,
              color: colors.warning,
              fontWeight: font.weight.semibold,
            }}
          >
            <AlertTriangle size={14} strokeWidth={2.25} />
            Current pipeline bottleneck
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {/* Stage Details metrics grid */}
        <Section title="Stage Details">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <MetricCell icon={<Users size={13} />} label="Current creators" value={String(summary?.count ?? items.length)} />
            <MetricCell
              icon={<Clock size={13} />}
              label="Avg duration"
              value={summary?.avgTimeInStateSeconds != null ? formatDuration(summary.avgTimeInStateSeconds) : "—"}
            />
            <MetricCell
              icon={<Clock size={13} />}
              label="Oldest creator"
              value={oldest ? formatDuration(oldest.waitingForSeconds) : "—"}
              sub={oldest?.creatorName}
            />
            <MetricCell
              icon={<AlertTriangle size={13} />}
              label="Stuck"
              value={String(summary?.stuck ?? 0)}
              danger={(summary?.stuck ?? 0) > 0}
            />
          </div>

          {/* Transitions */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
            <TransitionRow icon={<ArrowRight size={13} />} label="Incoming from" states={incoming} />
            <TransitionRow icon={<ArrowDownRight size={13} />} label="Outgoing to" states={outgoing} />
          </div>
        </Section>

        {/* Recent creators entering */}
        <Section title="Recent creators">
          {isLoading ? (
            <SkeletonRows count={3} height={44} />
          ) : isError ? (
            <EmptyState compact icon={<AlertTriangle size={22} strokeWidth={1.75} color={colors.warning} />} title="Failed to load" description="" />
          ) : recent.length === 0 ? (
            <IdleLine>No creators currently in this stage.</IdleLine>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {recent.map((it) => (
                <CreatorRow
                  key={it.instanceId}
                  item={it}
                  accent={accent}
                  selected={it.instanceId === selectedInstanceId}
                  onClick={() => onSelectInstance(it.instanceId)}
                />
              ))}
            </div>
          )}
        </Section>

        {/* Recent events (last event per creator in this stage) */}
        <Section title="Recent events" last>
          {(() => {
            const evented = items
              .filter((it) => it.lastEventType && it.lastEventAt)
              .sort((a, b) => Date.parse(b.lastEventAt!) - Date.parse(a.lastEventAt!))
              .slice(0, 6);
            if (evented.length === 0) return <IdleLine>No recent events in this stage.</IdleLine>;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {evented.map((it) => (
                  <div key={it.instanceId} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <Activity size={13} color={accent} style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: font.size.sm, color: colors.textMuted, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: colors.text, fontWeight: font.weight.medium }}>{it.creatorName}</span>
                      {" · "}
                      {formatEventType(it.lastEventType!)}
                    </span>
                    <span style={{ fontSize: font.size.xs, color: colors.textDim, flexShrink: 0 }}>{relativeTime(it.lastEventAt)}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>
      </div>
    </div>
  );
}

// -- sub-components ----------------------------------------------------------

function Section({ title, children, last }: { title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: last ? "none" : `1px solid ${colors.hairline}` }}>
      <div
        style={{
          fontSize: font.size.xs,
          fontWeight: font.weight.bold,
          textTransform: "uppercase",
          letterSpacing: 0.7,
          color: colors.textDim,
          marginBottom: 11,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function MetricCell({
  icon,
  label,
  value,
  sub,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string | undefined;
  danger?: boolean | undefined;
}) {
  return (
    <div
      style={{
        background: colors.panelAlt,
        border: `1px solid ${colors.hairline}`,
        borderRadius: radii.sm,
        padding: "9px 11px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 5, color: colors.textDim, fontSize: 10.5 }}>
        <span style={{ display: "inline-flex" }}>{icon}</span>
        <span style={{ textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</span>
      </div>
      <div className="nums" style={{ fontSize: font.size.lg, fontWeight: font.weight.bold, color: danger ? colors.warning : colors.text, marginTop: 4, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: font.size.xs, color: colors.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function TransitionRow({ icon, label, states }: { icon: React.ReactNode; label: string; states: InstanceState[] }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span style={{ display: "inline-flex", color: colors.textDim, marginTop: 3 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: colors.textDim, fontWeight: 600, marginBottom: 5 }}>{label}</div>
        {states.length === 0 ? (
          <span style={{ fontSize: font.size.sm, color: colors.textDim }}>—</span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {states.map((s) => (
              <span
                key={s}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: font.size.xs,
                  fontWeight: font.weight.medium,
                  color: colors.textMuted,
                  background: colors.panelAlt,
                  border: `1px solid ${colors.hairline}`,
                  borderRadius: 999,
                  padding: "2px 9px",
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: stateColor[s] }} />
                {stateLabel[s]}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CreatorRow({
  item,
  accent,
  selected,
  onClick,
}: {
  item: InstanceListItem;
  accent: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      className="ds-focusable ds-row"
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected ? colors.panelAlt : "transparent",
        border: `1px solid ${selected ? accent : "transparent"}`,
        borderRadius: radii.sm,
        padding: "8px 10px",
        color: colors.text,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: font.size.sm, fontWeight: font.weight.semibold, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.creatorName}
        </span>
        <span style={{ fontSize: font.size.xs, color: colors.textDim, flexShrink: 0 }}>
          {item.stuck ? <span style={{ color: colors.warning, fontWeight: 700 }}>stuck</span> : `${formatDuration(item.waitingForSeconds)}`}
        </span>
      </div>
      <div style={{ fontSize: font.size.xs, color: colors.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.creatorHandle ?? item.creatorEmail}
      </div>
    </button>
  );
}

function IdleLine({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: font.size.sm, color: colors.textDim, lineHeight: 1.5 }}>{children}</div>;
}

// Humanise an event type constant (e.g. STATE_TRANSITION → "State transition").
function formatEventType(t: string): string {
  const s = t.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
