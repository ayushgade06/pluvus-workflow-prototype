// ---------------------------------------------------------------------------
// NodeDrilldown — the operational queue view for one selected state (Part 3).
// ---------------------------------------------------------------------------
// Lists the creators currently in the selected state with sort + filter, and
// surfaces the operationally-relevant fields (round, dueAt, waiting duration,
// stuck flag). Clicking a row opens the instance inspector.

import { useMemo, useState } from "react";
import type { InstanceState, InstanceListItem } from "../api/types";
import { useInstances } from "../api/client";
import { colors, radii, font, stateColor, stateLabel, stateDescription, formatDuration, formatTimestamp } from "../theme";
import { Input, Select, EmptyState, SkeletonRows } from "./ds";

type SortKey = "waiting" | "name" | "round" | "due";

interface Props {
  state: InstanceState;
  // W-6: scope the creator list to the same workflow version as the summary.
  workflowVersionId?: string | null;
  selectedInstanceId: string | null;
  onSelectInstance: (id: string) => void;
}

export function NodeDrilldown({
  state,
  workflowVersionId,
  selectedInstanceId,
  onSelectInstance,
}: Props) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("waiting");
  const { data, isLoading, isError, error } = useInstances({
    state,
    search: search || undefined,
    workflowVersionId,
  });

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
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: accent }} />
          <h2 style={{ margin: 0, fontSize: font.size.lg, fontWeight: font.weight.bold, color: colors.text }}>
            {stateLabel[state]}
          </h2>
          <span style={{ fontSize: font.size.md, color: colors.textMuted }}>
            · {items.length} {items.length === 1 ? "creator" : "creators"}
          </span>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: font.size.sm, color: colors.textDim, lineHeight: 1.4 }}>
          {stateDescription[state]}
        </p>

        {/* Controls */}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name / email / handle…"
            aria-label="Filter creators"
            style={{ flex: 1, padding: "6px 9px", fontSize: font.size.sm }}
          />
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort creators"
            style={{ width: "auto", padding: "6px 9px", fontSize: font.size.sm }}
          >
            <option value="waiting">Longest waiting</option>
            <option value="name">Name</option>
            <option value="round">Negotiation round</option>
            <option value="due">Due soonest</option>
          </Select>
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "10px" }}>
        {isLoading && <SkeletonRows count={5} height={62} />}
        {isError && (
          <EmptyState compact icon="⚠" title="Failed to load" description={(error as Error)?.message} />
        )}
        {!isLoading && !isError && items.length === 0 && (
          <EmptyState
            compact
            icon="✓"
            title="Empty queue"
            description={`No creators in this state${search ? " matching your filter" : ""}.`}
          />
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
      aria-pressed={selected}
      className="ds-focusable ds-row"
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected ? colors.panelAlt : "transparent",
        border: `1px solid ${selected ? accent : "transparent"}`,
        borderRadius: radii.sm,
        padding: "9px 10px",
        marginBottom: 4,
        color: colors.text,
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: font.size.md, fontWeight: font.weight.semibold }}>{item.creatorName}</span>
        {item.stuck && <span style={{ fontSize: font.size.xs, fontWeight: font.weight.bold, color: colors.warning }}>⚠ stuck</span>}
      </div>
      <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 2 }}>
        {item.creatorHandle ?? item.creatorEmail}
        {item.platform ? ` · ${item.platform}` : ""}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: font.size.xs, color: colors.textDim, flexWrap: "wrap" }}>
        <span>waiting {formatDuration(item.waitingForSeconds)}</span>
        {item.negotiationRound > 0 && <span>round {item.negotiationRound}</span>}
        {item.followUpCount > 0 && <span>{item.followUpCount} follow-ups</span>}
        {item.dueAt && <span>due {formatTimestamp(item.dueAt)}</span>}
      </div>
    </button>
  );
}
