// ---------------------------------------------------------------------------
// NodeDrilldown — the operational queue view for one selected state (Part 3).
// ---------------------------------------------------------------------------
// Lists the creators currently in the selected state with sort + filter, and
// surfaces the operationally-relevant fields (round, dueAt, waiting duration,
// stuck flag). Clicking a row opens the instance inspector.

import { useMemo, useState } from "react";
import type { InstanceState, InstanceListItem } from "../api/types";
import { useInstances } from "../api/client";
import { colors, stateColor, stateLabel, stateDescription, formatDuration, formatTimestamp } from "../theme";
import { Empty, Spinner } from "./ui";

type SortKey = "waiting" | "name" | "round" | "due";

interface Props {
  state: InstanceState;
  selectedInstanceId: string | null;
  onSelectInstance: (id: string) => void;
}

export function NodeDrilldown({ state, selectedInstanceId, onSelectInstance }: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("waiting");
  const { data, isLoading, isError, error } = useInstances({ state, search: search || undefined });

  const items = useMemo(() => {
    const list = [...(data?.items ?? [])];
    list.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.creatorName.localeCompare(b.creatorName);
        case "round":
          return b.negotiationRound - a.negotiationRound;
        case "due":
          return (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
        case "waiting":
        default:
          return b.waitingForSeconds - a.waitingForSeconds;
      }
    });
    return list;
  }, [data, sort]);

  const accent = stateColor[state];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: accent }} />
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: colors.text }}>
            {stateLabel[state]}
          </h2>
          <span style={{ fontSize: 12, color: colors.textMuted }}>
            · {items.length} {items.length === 1 ? "creator" : "creators"}
          </span>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 11.5, color: colors.textDim, lineHeight: 1.4 }}>
          {stateDescription[state]}
        </p>

        {/* Controls */}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name / email / handle…"
            style={{
              flex: 1,
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              color: colors.text,
              fontSize: 12,
              padding: "6px 9px",
              outline: "none",
            }}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            style={{
              background: colors.bg,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              color: colors.text,
              fontSize: 12,
              padding: "6px 9px",
              outline: "none",
            }}
          >
            <option value="waiting">Sort: longest waiting</option>
            <option value="name">Sort: name</option>
            <option value="round">Sort: negotiation round</option>
            <option value="due">Sort: due soonest</option>
          </select>
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "8px 10px" }}>
        {isLoading && <Spinner label="Loading creators…" />}
        {isError && <Empty>Failed to load: {(error as Error)?.message}</Empty>}
        {!isLoading && !isError && items.length === 0 && (
          <Empty>No creators in this state{search ? " matching your filter" : ""}.</Empty>
        )}
        {items.map((it) => (
          <CreatorRow
            key={it.instanceId}
            item={it}
            selected={it.instanceId === selectedInstanceId}
            accent={accent}
            onClick={() => onSelectInstance(it.instanceId)}
          />
        ))}
      </div>
    </div>
  );
}

function CreatorRow({
  item,
  selected,
  accent,
  onClick,
}: {
  item: InstanceListItem;
  selected: boolean;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected ? colors.panelAlt : "transparent",
        border: `1px solid ${selected ? accent : "transparent"}`,
        borderRadius: 7,
        padding: "9px 10px",
        marginBottom: 4,
        color: colors.text,
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = colors.panel;
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{item.creatorName}</span>
        {item.stuck && (
          <span style={{ fontSize: 10, fontWeight: 700, color: colors.warning }}>⚠ stuck</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
        {item.creatorHandle ?? item.creatorEmail}
        {item.platform ? ` · ${item.platform}` : ""}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 10.5, color: colors.textDim, flexWrap: "wrap" }}>
        <span>waiting {formatDuration(item.waitingForSeconds)}</span>
        {item.negotiationRound > 0 && <span>round {item.negotiationRound}</span>}
        {item.followUpCount > 0 && <span>{item.followUpCount} follow-ups</span>}
        {item.dueAt && <span>due {formatTimestamp(item.dueAt)}</span>}
      </div>
    </button>
  );
}
