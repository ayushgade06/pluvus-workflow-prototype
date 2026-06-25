import { useState, useMemo } from "react";
import { useCreators, enrollCreators, useWorkflowExecution } from "../../api/builderClient";
import { colors, radii, font } from "../../theme";
import { Button, Input, StatTile, EmptyState, SkeletonRows } from "../ds";
import { useToast } from "../ds";
import type { EnrollResponse, WorkflowDetail, CreatorItem } from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  onEnrolled: () => void;
}

export function EnrollTab({ workflow, onEnrolled }: Props) {
  const { data: creators, isLoading } = useCreators();
  const { data: execution } = useWorkflowExecution(workflow.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<EnrollResponse | null>(null);
  const toast = useToast();

  const hasVersion = !!workflow.latestVersion;

  const filtered = useMemo(() => {
    if (!creators) return [];
    const q = filter.toLowerCase();
    if (!q) return creators;
    return creators.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        (c.handle ?? "").toLowerCase().includes(q) ||
        (c.platform ?? "").toLowerCase().includes(q) ||
        (c.niche ?? "").toLowerCase().includes(q),
    );
  }, [creators, filter]);

  const enrolledCount = execution?.totalInstances ?? 0;
  const allSelected = selected.size === filtered.length && filtered.length > 0;

  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(filtered.map((c) => c.id)));
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function handleEnroll() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      // Identical payload: array of selected creator ids.
      const r = await enrollCreators(workflow.id, [...selected]);
      setResult(r);
      setSelected(new Set());
      toast.success(
        `Enrolled ${r.enrolled} creator${r.enrolled !== 1 ? "s" : ""}${r.skipped > 0 ? ` · ${r.skipped} skipped` : ""}.`,
      );
      onEnrolled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Enrollment failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!hasVersion) {
    return (
      <EmptyState
        icon="🔒"
        title="Workflow not published"
        description="Publish the workflow before enrolling creators."
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "20px 24px",
        gap: 16,
        overflow: "hidden",
      }}
    >
      {/* Summary tiles */}
      <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
        <StatTile label="Already Enrolled" value={enrolledCount} color={colors.accent} />
        <StatTile label="Selected" value={selected.size} color={selected.size > 0 ? colors.success : undefined} />
        <StatTile label="Total Creators" value={creators?.length ?? 0} />
      </div>

      {result && (
        <Banner color={colors.success}>
          ✓ Enrolled {result.enrolled} creator{result.enrolled !== 1 ? "s" : ""}
          {result.skipped > 0 ? ` · ${result.skipped} skipped (already enrolled)` : ""}
        </Banner>
      )}

      {/* Search + select all */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search creators by name, email, handle, platform…"
          aria-label="Search creators"
          style={{ flex: 1 }}
        />
        <Button variant="secondary" onClick={toggleAll} disabled={filtered.length === 0}>
          {allSelected ? "Deselect all" : "Select all"}
        </Button>
      </div>

      {/* Creator list */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          background: colors.bg,
          minHeight: 0,
        }}
      >
        {isLoading ? (
          <div style={{ padding: 16 }}>
            <SkeletonRows count={6} height={48} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon="🔍"
            title={filter ? "No matching creators" : "No creators available"}
            description={filter ? `Nothing matches “${filter}”.` : "Add creators to your roster first."}
          />
        ) : (
          filtered.map((c) => (
            <CreatorRow key={c.id} creator={c} selected={selected.has(c.id)} onToggle={() => toggleOne(c.id)} />
          ))
        )}
      </div>

      {/* Enroll action */}
      <Button
        variant="primary"
        fullWidth
        disabled={selected.size === 0 || submitting}
        onClick={() => void handleEnroll()}
        style={{ height: 40, flexShrink: 0 }}
      >
        {submitting
          ? "Enrolling…"
          : selected.size === 0
          ? "Select creators to enroll"
          : `Enroll ${selected.size} creator${selected.size !== 1 ? "s" : ""}`}
      </Button>
    </div>
  );
}

function CreatorRow({
  creator,
  selected,
  onToggle,
}: {
  creator: CreatorItem;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className="ds-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderBottom: `1px solid ${colors.border}`,
        cursor: "pointer",
        background: selected ? "rgba(56,139,253,0.06)" : "transparent",
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="ds-focusable"
        aria-label={`Select ${creator.name}`}
        style={{ width: 16, height: 16, accentColor: colors.accent, cursor: "pointer", flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.text }}>
          {creator.name}
          {creator.handle && (
            <span style={{ fontSize: font.size.md, fontWeight: font.weight.regular, color: colors.textMuted, marginLeft: 6 }}>
              @{creator.handle}
            </span>
          )}
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textDim }}>{creator.email}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {creator.platform && <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>{creator.platform}</div>}
        {creator.niche && <div style={{ fontSize: font.size.sm, color: colors.textDim }}>{creator.niche}</div>}
      </div>
    </label>
  );
}

function Banner({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div
      style={{
        padding: "10px 14px",
        background: `${color}1a`,
        border: `1px solid ${color}`,
        borderRadius: radii.md,
        fontSize: font.size.md,
        color,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}
