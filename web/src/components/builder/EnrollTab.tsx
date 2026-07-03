import { useState, useMemo, useRef } from "react";
import {
  useCreators,
  enrollCreators,
  importCreators,
  useWorkflowExecution,
  useBuilderInvalidator,
} from "../../api/builderClient";
import { parseCsv } from "../../lib/parseCsv";
import { colors, radii, font } from "../../theme";
import { Button, Input, StatTile, EmptyState, SkeletonRows } from "../ds";
import { useToast } from "../ds";
import type {
  EnrollResponse,
  WorkflowDetail,
  CreatorItem,
  CreatorImportResponse,
} from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  onEnrolled: () => void;
}

export function EnrollTab({ workflow, onEnrolled }: Props) {
  const { data: creators, isLoading } = useCreators();
  const { data: execution } = useWorkflowExecution(workflow.id);
  const { invalidateCreators } = useBuilderInvalidator(workflow.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<EnrollResponse | null>(null);
  const [importResult, setImportResult] = useState<CreatorImportResponse | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const hasVersion = !!workflow.latestVersion;

  async function handleFile(file: File) {
    setImporting(true);
    setImportResult(null);
    setResult(null);
    try {
      const text = await file.text();
      const { rows, missingEmailColumn } = parseCsv(text);
      if (rows.length === 0) {
        toast.error("That CSV has no data rows.");
        return;
      }
      if (missingEmailColumn) {
        toast.error('CSV needs an "email" column.');
        return;
      }
      const res = await importCreators(rows);
      setImportResult(res);
      // Refetch the roster so the new creators appear, then pre-select them.
      await invalidateCreators();
      setSelected((prev) => {
        const next = new Set(prev);
        for (const c of res.creators) next.add(c.id);
        return next;
      });
      const parts = [`${res.created} new`, `${res.updated} updated`];
      if (res.skipped > 0) parts.push(`${res.skipped} skipped`);
      toast.success(`Imported ${res.creators.length} creator${res.creators.length !== 1 ? "s" : ""} · ${parts.join(", ")}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "CSV import failed");
    } finally {
      setImporting(false);
      // Reset the input so re-selecting the same file re-triggers onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

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
      className="ds-fade-in"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "24px 28px",
        gap: 18,
        overflow: "hidden",
        maxWidth: 1080,
        margin: "0 auto",
        width: "100%",
      }}
    >
      {/* Summary tiles */}
      <div style={{ display: "flex", gap: 14, flexShrink: 0 }}>
        <StatTile label="Already Enrolled" value={enrolledCount} color={enrolledCount > 0 ? colors.accent : undefined} />
        <StatTile label="Selected" value={selected.size} color={selected.size > 0 ? colors.success : undefined} />
        <StatTile label="Total Creators" value={creators?.length ?? 0} />
      </div>

      {result && (
        <Banner color={colors.success}>
          ✓ Enrolled {result.enrolled} creator{result.enrolled !== 1 ? "s" : ""}
          {result.skipped > 0 ? ` · ${result.skipped} skipped (already enrolled)` : ""}
        </Banner>
      )}

      {importResult && (
        <Banner color={importResult.errors.length > 0 ? colors.warning : colors.success}>
          <div>
            ✓ Imported {importResult.created + importResult.updated} creator
            {importResult.created + importResult.updated !== 1 ? "s" : ""}
            {" "}({importResult.created} new · {importResult.updated} updated
            {importResult.skipped > 0 ? ` · ${importResult.skipped} skipped` : ""}) — pre-selected below.
          </div>
          {importResult.errors.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: "pointer" }}>
                {importResult.errors.length} row{importResult.errors.length !== 1 ? "s" : ""} skipped
              </summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {importResult.errors.slice(0, 20).map((e) => (
                  <li key={e.row}>Row {e.row}: {e.reason}</li>
                ))}
                {importResult.errors.length > 20 && (
                  <li>…and {importResult.errors.length - 20} more</li>
                )}
              </ul>
            </details>
          )}
        </Banner>
      )}

      {/* Search + import + select all */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search creators by name, email, handle, platform…"
          aria-label="Search creators"
          style={{ flex: 1 }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <Button
          variant="secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
        >
          {importing ? "Importing…" : "Upload CSV"}
        </Button>
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
          background: colors.panel,
          boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexShrink: 0,
          paddingBottom: 4,
        }}
      >
        <span style={{ fontSize: font.size.sm, color: colors.textDim, flex: 1 }}>
          {selected.size === 0
            ? "Select creators above to enroll them into this workflow."
            : `${selected.size} creator${selected.size !== 1 ? "s" : ""} selected`}
        </span>
        <Button
          variant="primary"
          disabled={selected.size === 0 || submitting}
          onClick={() => void handleEnroll()}
          style={{ height: 40, padding: "0 22px", flexShrink: 0 }}
        >
          {submitting
            ? "Enrolling…"
            : selected.size === 0
            ? "Select creators to enroll"
            : `Enroll ${selected.size} creator${selected.size !== 1 ? "s" : ""}`}
        </Button>
      </div>
    </div>
  );
}

// Deterministic avatar tint per creator (pure presentation — derived from the
// name we already render).
const AVATAR_COLORS = ["#6e7cf5", "#a78bfa", "#57d9a3", "#d9a03f", "#e0784a", "#8b96f8"];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
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
  const tint = avatarColor(creator.name);
  return (
    <label
      className="ds-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 16px",
        borderBottom: `1px solid ${colors.border}`,
        cursor: "pointer",
        background: selected ? `${colors.accent}0f` : "transparent",
        boxShadow: selected ? `inset 2px 0 0 ${colors.accent}` : "none",
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
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: `${tint}1c`,
          border: `1px solid ${tint}33`,
          color: tint,
          fontSize: 11,
          fontWeight: font.weight.semibold,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          letterSpacing: 0.3,
        }}
      >
        {initials(creator.name)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: font.size.md, fontWeight: font.weight.medium, color: colors.text }}>
          {creator.name}
          {creator.handle && (
            <span style={{ fontSize: font.size.sm, fontWeight: font.weight.regular, color: colors.textDim, marginLeft: 7 }}>
              @{creator.handle}
            </span>
          )}
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textDim, marginTop: 1 }}>{creator.email}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {creator.platform && (
          <span
            style={{
              fontSize: font.size.xs,
              fontWeight: font.weight.medium,
              color: colors.textMuted,
              background: colors.panelAlt,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.pill,
              padding: "2px 9px",
              lineHeight: 1.5,
            }}
          >
            {creator.platform}
          </span>
        )}
        {creator.niche && (
          <span
            style={{
              fontSize: font.size.xs,
              fontWeight: font.weight.medium,
              color: colors.textDim,
              background: colors.panelAlt,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.pill,
              padding: "2px 9px",
              lineHeight: 1.5,
            }}
          >
            {creator.niche}
          </span>
        )}
      </div>
    </label>
  );
}

function Banner({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div
      className="ds-fade-in"
      style={{
        padding: "12px 16px",
        background: `${color}12`,
        border: `1px solid ${color}40`,
        borderRadius: radii.md,
        fontSize: font.size.md,
        color,
        lineHeight: 1.55,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}
