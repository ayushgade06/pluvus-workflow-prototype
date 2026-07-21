import { useState, useMemo, useRef } from "react";
import {
  useCreators,
  addCreator,
  commitImport,
  discardImport,
  uploadImport,
  useImportBatchDetail,
  useImportBatches,
  enrollCreators,
  useWorkflowExecution,
  useBuilderInvalidator,
} from "../../api/builderClient";
import { colors, radii, font } from "../../theme";
import { Button, Input, Select, StatTile, EmptyState, SkeletonRows } from "../ds";
import { useToast } from "../ds";
import { ImportBatchPicker, type SelectScope } from "./ImportBatchPicker";
import { ImportPreviewPanel } from "./ImportPreviewPanel";
import type {
  EnrollResponse,
  WorkflowDetail,
  CreatorItem,
  ImportDraftResponse,
} from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  onEnrolled: () => void;
}

type SortKey = "followers" | "engagement" | "name";

/**
 * A creator as the list renders them: the creator plus the provenance that
 * makes duplicates and prior enrollments visible BEFORE you click enroll.
 */
interface Row {
  creator: CreatorItem;
  /** True when this import created the creator (not already in the roster). */
  isNewFromBatch: boolean;
  /** Other committed lists this creator also appears in. */
  alsoInBatches: string[];
  isEnrolled: boolean;
}

export function EnrollTab({ workflow, onEnrolled }: Props) {
  const { data: creators, isLoading } = useCreators();
  const { data: execution } = useWorkflowExecution(workflow.id);
  const { data: batches } = useImportBatches();
  const {
    invalidateCreators,
    invalidateImportBatches,
    invalidateExecution,
  } = useBuilderInvalidator(workflow.id);

  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const { data: batchDetail, isLoading: batchLoading } = useImportBatchDetail(activeBatchId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("followers");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<EnrollResponse | null>(null);
  const [draft, setDraft] = useState<ImportDraftResponse | null>(null);
  const [importing, setImporting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ email: "", name: "", handle: "", platform: "" });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const hasVersion = !!workflow.latestVersion;

  const enrolledIds = useMemo(
    () => new Set(execution?.enrolledCreatorIds ?? []),
    [execution?.enrolledCreatorIds],
  );

  // --- upload (phase 1: parse + preview, writes nothing) --------------------

  async function handleFile(file: File) {
    setImporting(true);
    setDraft(null);
    setResult(null);
    try {
      const res = await uploadImport(file);
      setDraft(res);
      await invalidateImportBatches();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "CSV import failed");
    } finally {
      setImporting(false);
      // Reset the input so re-selecting the same file re-triggers onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // --- commit (phase 2: the roster actually changes) ------------------------

  async function handleCommit() {
    if (!draft) return;
    setCommitting(true);
    try {
      const res = await commitImport(draft.batch.id);
      await Promise.all([invalidateCreators(), invalidateImportBatches()]);
      // Scope the view to what was just imported and preselect the new ones —
      // the common next action is "enroll the people I just added".
      setActiveBatchId(res.batch.id);
      setDraft(null);
      const parts = [`${res.created} new`, `${res.updated} updated`];
      if (res.batch.skippedCount > 0) parts.push(`${res.batch.skippedCount} skipped`);
      toast.success(`Imported ${res.creators.length} creator(s) · ${parts.join(", ")}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setCommitting(false);
    }
  }

  async function handleDiscard() {
    if (!draft) return;
    const id = draft.batch.id;
    setDraft(null);
    try {
      await discardImport(id);
      await invalidateImportBatches();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not discard the draft");
    }
  }

  // --- single-creator add ---------------------------------------------------

  async function handleAdd() {
    const email = addForm.email.trim();
    if (!email) return;
    setAdding(true);
    setResult(null);
    try {
      const res = await addCreator({
        email,
        ...(addForm.name.trim() ? { name: addForm.name.trim() } : {}),
        ...(addForm.handle.trim() ? { handle: addForm.handle.trim() } : {}),
        ...(addForm.platform.trim() ? { platform: addForm.platform.trim() } : {}),
      });
      await invalidateCreators();
      setSelected((prev) => new Set(prev).add(res.creator.id));
      toast.success(`Added ${res.creator.name} — pre-selected below.`);
      setAddForm({ email: "", name: "", handle: "", platform: "" });
      setShowAdd(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Add creator failed");
    } finally {
      setAdding(false);
    }
  }

  // --- the visible rows -----------------------------------------------------
  // Either the whole roster, or one import batch's members. Batch mode is what
  // keeps yesterday's list separate from today's.

  const rows = useMemo<Row[]>(() => {
    if (activeBatchId) {
      return (batchDetail?.members ?? [])
        .filter((m) => m.creator !== null)
        .map((m) => ({
          creator: m.creator!,
          isNewFromBatch: m.outcome === "CREATED",
          alsoInBatches: m.alsoInBatches,
          isEnrolled: enrolledIds.has(m.creator!.id),
        }));
    }
    return (creators ?? []).map((c) => ({
      creator: c,
      isNewFromBatch: false,
      alsoInBatches: [],
      isEnrolled: enrolledIds.has(c.id),
    }));
  }, [activeBatchId, batchDetail, creators, enrolledIds]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? rows.filter(({ creator: c }) =>
          [c.name, c.email, c.handle, c.platform, c.niche, c.location]
            .some((v) => (v ?? "").toLowerCase().includes(q)),
        )
      : rows;

    // Sort a copy — `rows` is memoized upstream.
    return [...matched].sort((a, b) => {
      if (sortKey === "name") return a.creator.name.localeCompare(b.creator.name);
      const key = sortKey === "followers" ? "followerCount" : "engagementRate";
      const av = a.creator[key];
      const bv = b.creator[key];
      // NULL means UNKNOWN, so unknowns sort last rather than as zero.
      if (av === null && bv === null) return a.creator.name.localeCompare(b.creator.name);
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }, [rows, filter, sortKey]);

  // --- selection scopes -----------------------------------------------------
  // Each is a predicate over `filtered`. This is the whole answer to "how do we
  // only select the new ones".

  function selectAll(list: Row[]) {
    setSelected(new Set(list.map((r) => r.creator.id)));
  }

  const newRows = filtered.filter((r) => r.isNewFromBatch);
  const unenrolledRows = filtered.filter((r) => !r.isEnrolled);

  const scopes: SelectScope[] = [
    {
      key: "all",
      label: activeBatchId ? "Select all in this list" : "Select all matching",
      count: filtered.length,
      apply: filtered.length > 0 ? () => selectAll(filtered) : null,
    },
    {
      key: "new",
      label: "Select only the new ones",
      count: newRows.length,
      // Only meaningful in batch mode: "new" is defined relative to an import.
      apply: activeBatchId && newRows.length > 0 ? () => selectAll(newRows) : null,
    },
    {
      key: "unenrolled",
      label: "Select those not yet enrolled here",
      count: unenrolledRows.length,
      apply: unenrolledRows.length > 0 ? () => selectAll(unenrolledRows) : null,
    },
  ];

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
      const r = await enrollCreators(workflow.id, [...selected]);
      setResult(r);
      setSelected(new Set());
      await invalidateExecution();
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

  const listLoading = activeBatchId ? batchLoading : isLoading;

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
        <StatTile
          label="Already Enrolled"
          value={execution?.totalInstances ?? 0}
          color={(execution?.totalInstances ?? 0) > 0 ? colors.accent : undefined}
        />
        <StatTile
          label="Selected"
          value={selected.size}
          color={selected.size > 0 ? colors.success : undefined}
        />
        <StatTile label={activeBatchId ? "In This List" : "Total Creators"} value={rows.length} />
      </div>

      {result && (
        <Banner color={colors.success}>
          ✓ Enrolled {result.enrolled} creator{result.enrolled !== 1 ? "s" : ""}
          {result.skipped > 0 ? ` · ${result.skipped} skipped (already enrolled)` : ""}
        </Banner>
      )}

      {draft && (
        <ImportPreviewPanel
          draft={draft}
          committing={committing}
          onCommit={() => void handleCommit()}
          onDiscard={() => void handleDiscard()}
        />
      )}

      {/* Source list + search + sort + import + select */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0, flexWrap: "wrap" }}>
        <ImportBatchPicker
          batches={batches ?? []}
          activeBatchId={activeBatchId}
          onChangeBatch={(id) => {
            setActiveBatchId(id);
            // Selection is scoped to what you can see; carrying it across lists
            // would silently enroll people who scrolled out of view.
            setSelected(new Set());
          }}
          scopes={scopes}
          onClear={() => setSelected(new Set())}
          clearDisabled={selected.size === 0}
        />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search name, email, handle, platform, location…"
          aria-label="Search creators"
          style={{ flex: 1, minWidth: 200 }}
        />
        <Select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          aria-label="Sort creators"
          style={{ maxWidth: 170, flexShrink: 0 }}
        >
          <option value="followers">Sort: Followers</option>
          <option value="engagement">Sort: Engagement</option>
          <option value="name">Sort: Name</option>
        </Select>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <Button variant="secondary" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? "Close" : "Add creator"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing || !!draft}
        >
          {importing ? "Reading…" : "Upload CSV"}
        </Button>
      </div>

      {/* Inline single-creator add form */}
      {showAdd && (
        <form
          className="ds-fade-in"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexShrink: 0,
            padding: "12px 14px",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
          }}
        >
          <Input
            value={addForm.email}
            onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="email@example.com"
            aria-label="New creator email"
            type="email"
            required
            autoFocus
            style={{ flex: 2 }}
          />
          <Input
            value={addForm.name}
            onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Name (optional)"
            aria-label="New creator name"
            style={{ flex: 2 }}
          />
          <Input
            value={addForm.handle}
            onChange={(e) => setAddForm((f) => ({ ...f, handle: e.target.value }))}
            placeholder="Handle (optional)"
            aria-label="New creator handle"
            style={{ flex: 1 }}
          />
          <Input
            value={addForm.platform}
            onChange={(e) => setAddForm((f) => ({ ...f, platform: e.target.value }))}
            placeholder="Platform (optional)"
            aria-label="New creator platform"
            style={{ flex: 1 }}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={adding || !addForm.email.trim()}
            style={{ flexShrink: 0 }}
          >
            {adding ? "Adding…" : "Add"}
          </Button>
        </form>
      )}

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
        {listLoading ? (
          <div style={{ padding: 16 }}>
            <SkeletonRows count={6} height={48} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon="🔍"
            title={filter ? "No matching creators" : "No creators here"}
            description={
              filter
                ? `Nothing matches “${filter}”.`
                : activeBatchId
                ? "This import list has no creators."
                : "Upload a CSV or add a creator to get started."
            }
          />
        ) : (
          filtered.map((row) => (
            <CreatorRow
              key={row.creator.id}
              row={row}
              selected={selected.has(row.creator.id)}
              onToggle={() => toggleOne(row.creator.id)}
            />
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

function formatFollowers(n: number | null): string | null {
  if (n === null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function CreatorRow({
  row,
  selected,
  onToggle,
}: {
  row: Row;
  selected: boolean;
  onToggle: () => void;
}) {
  const { creator, isNewFromBatch, alsoInBatches, isEnrolled } = row;
  const tint = avatarColor(creator.name);
  const followers = formatFollowers(creator.followerCount);

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
            <span
              style={{
                fontSize: font.size.sm,
                fontWeight: font.weight.regular,
                color: colors.textDim,
                marginLeft: 7,
              }}
            >
              @{creator.handle}
            </span>
          )}
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textDim, marginTop: 1 }}>
          {creator.email}
          {alsoInBatches.length > 0 && (
            <span style={{ color: colors.textMuted }}> · also in {alsoInBatches[0]}</span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {followers && <Pill color={colors.textMuted}>{followers}</Pill>}
        {creator.engagementRate !== null && (
          <Pill color={colors.textMuted}>{creator.engagementRate.toFixed(1)}%</Pill>
        )}
        {creator.platform && <Pill color={colors.textMuted}>{creator.platform}</Pill>}
        {creator.niche && <Pill color={colors.textDim}>{creator.niche}</Pill>}
        {/* Provenance badges: the answer to "how do we check". */}
        {isNewFromBatch && <Pill color={colors.success}>NEW</Pill>}
        {alsoInBatches.length > 0 && !isNewFromBatch && <Pill color={colors.textDim}>DUPLICATE</Pill>}
        {isEnrolled && <Pill color={colors.accent}>ENROLLED</Pill>}
      </div>
    </label>
  );
}

function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      style={{
        fontSize: font.size.xs,
        fontWeight: font.weight.medium,
        color,
        background: colors.panelAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.pill,
        padding: "2px 9px",
        lineHeight: 1.5,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
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
