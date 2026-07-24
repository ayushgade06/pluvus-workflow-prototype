import { useState, useMemo, useRef } from "react";
import { Lock, Search } from "lucide-react";
import {
  useCreators,
  addCreator,
  commitImport,
  deleteCreators,
  deleteImportBatch,
  updateImportBatch,
  uploadImport,
  useImportBatchDetail,
  useImportBatches,
  enrollCreators,
  useWorkflowExecution,
  useBuilderInvalidator,
} from "../../api/builderClient";
import { colors, radii, font } from "../../theme";
import { Button, ConfirmDialog, Input, Modal, Select, StatTile, EmptyState, SkeletonRows } from "../ds";
import { useToast } from "../ds";
import { ImportBatchPicker, type SelectScope } from "./ImportBatchPicker";
import { ImportPreviewPanel } from "./ImportPreviewPanel";
import {
  CreatorTableHeader,
  CreatorTableRow,
  CREATOR_MIN_WIDTH,
  type CreatorRowData,
  type SortDir,
  type SortKey,
} from "./CreatorTable";
import type {
  EnrollResponse,
  PostAcceptanceMode,
  WorkflowDetail,
  CreatorDeleteBlock,
  ImportBatch,
  ImportDraftResponse,
} from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
  onEnrolled: () => void;
}

/**
 * What a destructive confirm is currently asking about. Null = no dialog.
 * Modelled as a discriminated union so the dialog copy can be exact about what
 * will happen rather than generically scary.
 */
type PendingDelete =
  | { kind: "creators"; ids: string[]; label: string }
  | { kind: "list"; batch: ImportBatch };

/** PLU-70: short labels for the post-acceptance modes, shown at enrollment. */
const MODE_LABEL: Record<PostAcceptanceMode, string> = {
  local_payment: "Local payment flow",
  operator_handoff: "Operator onboarding",
};

export function EnrollTab({ workflow, onEnrolled }: Props) {
  const { data: creators, isLoading } = useCreators();
  const { data: execution } = useWorkflowExecution(workflow.id);
  const { data: batches } = useImportBatches();
  const {
    invalidateCreators,
    invalidateImportBatches,
    invalidateImportBatch,
    invalidateExecution,
  } = useBuilderInvalidator(workflow.id);

  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const { data: batchDetail, isLoading: batchLoading } = useImportBatchDetail(activeBatchId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("followers");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [blocked, setBlocked] = useState<CreatorDeleteBlock[]>([]);
  // Rename uses a real dialog rather than window.prompt: prompt() is blocked in
  // sandboxed iframes (the Replit preview pane is one), so it would silently do
  // nothing there.
  const [renaming, setRenaming] = useState<{ batch: ImportBatch; value: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<EnrollResponse | null>(null);
  // PLU-70: the campaign's mode is the DEFAULT; the operator confirms or
  // overrides it here, and the override applies only to the executions created
  // by this enrollment. null = "use the campaign default" (nothing sent).
  const [modeOverride, setModeOverride] = useState<PostAcceptanceMode | null>(null);
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

  const activeBatch = useMemo(
    () => (batches ?? []).find((b) => b.id === activeBatchId) ?? null,
    [batches, activeBatchId],
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
      await deleteImportBatch(id);
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

  const rows = useMemo<CreatorRowData[]>(() => {
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
    const dir = sortDir === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      if (sortKey === "name") return a.creator.name.localeCompare(b.creator.name) * dir;
      const key = sortKey === "followers" ? "followerCount" : "engagementRate";
      const av = a.creator[key];
      const bv = b.creator[key];
      // NULL means UNKNOWN. Unknowns sort last in BOTH directions — flipping the
      // sort should not promote "we don't know" to the top of the list.
      if (av === null && bv === null) return a.creator.name.localeCompare(b.creator.name);
      if (av === null) return 1;
      if (bv === null) return -1;
      return (av - bv) * dir;
    });
  }, [rows, filter, sortKey, sortDir]);

  /** Click a column: same column flips direction, new column starts sensibly. */
  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Names read naturally A→Z; audience numbers read naturally biggest-first.
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  // --- selection scopes -----------------------------------------------------
  // Each is a predicate over `filtered`. This is the whole answer to "how do we
  // only select the new ones".

  function selectAll(list: CreatorRowData[]) {
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

  // --- deletion -------------------------------------------------------------
  // Both paths funnel through one confirm dialog so nothing destructive happens
  // without the operator reading what it will do.

  async function runDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      if (pendingDelete.kind === "creators") {
        const res = await deleteCreators(pendingDelete.ids);
        // Anyone enrolled or partnered is KEPT — surface that rather than
        // letting the count quietly come up short.
        setBlocked(res.blocked);
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of res.deleted) next.delete(id);
          return next;
        });
        await Promise.all([invalidateCreators(), invalidateImportBatches()]);
        if (activeBatchId) await invalidateImportBatch(activeBatchId);
        if (res.deletedCount > 0) {
          toast.success(
            `Removed ${res.deletedCount} creator${res.deletedCount !== 1 ? "s" : ""}` +
              (res.blockedCount > 0 ? ` · ${res.blockedCount} kept` : "."),
          );
        } else {
          toast.error(`Nothing removed — ${res.blockedCount} kept, see the note above.`);
        }
      } else {
        const res = await deleteImportBatch(pendingDelete.batch.id);
        setActiveBatchId(null);
        setSelected(new Set());
        await Promise.all([invalidateImportBatches(), invalidateCreators()]);
        toast.success(
          `Deleted “${res.deletedBatch.label}” (${res.memberCount} row${res.memberCount !== 1 ? "s" : ""}). Its creators stay in your roster.`,
        );
      }
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function submitRename() {
    if (!renaming) return;
    const label = renaming.value.trim();
    if (!label || label === renaming.batch.label) {
      setRenaming(null);
      return;
    }
    try {
      await updateImportBatch(renaming.batch.id, { label });
      await invalidateImportBatches();
      toast.success(`Renamed to “${label}”.`);
      setRenaming(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
    }
  }

  async function handleArchiveList() {
    if (!activeBatch) return;
    try {
      await updateImportBatch(activeBatch.id, { archived: true });
      setActiveBatchId(null);
      setSelected(new Set());
      await invalidateImportBatches();
      toast.success(`Archived “${activeBatch.label}” — its creators stay in your roster.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed");
    }
  }

  async function handleEnroll() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const r = await enrollCreators(workflow.id, [...selected], modeOverride ?? undefined);
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
        icon={<Lock size={24} strokeWidth={1.75} color={colors.textMuted} />}
        title="Workflow not published"
        description="Publish the workflow before enrolling creators."
      />
    );
  }

  const listLoading = activeBatchId ? batchLoading : isLoading;
  // The campaign default unless the operator overrode it for this batch.
  const effectiveMode: PostAcceptanceMode =
    modeOverride ?? workflow.campaign?.postAcceptanceMode ?? "local_payment";

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
          {` · post-acceptance: ${MODE_LABEL[result.postAcceptanceMode]}`}
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
          activeBatch={activeBatch}
          onRenameList={() =>
            activeBatch && setRenaming({ batch: activeBatch, value: activeBatch.label })
          }
          onArchiveList={() => void handleArchiveList()}
          onDeleteList={() =>
            activeBatch && setPendingDelete({ kind: "list", batch: activeBatch })
          }
        />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search name, email, handle, platform, location…"
          aria-label="Search creators"
          style={{ flex: 1, minWidth: 200 }}
        />
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

      {/* Creators kept back by a delete, with the reason. */}
      {blocked.length > 0 && (
        <Banner color={colors.warning}>
          <div>
            {blocked.length} creator{blocked.length !== 1 ? "s were" : " was"} kept — removing
            them would destroy execution or payout history.
          </div>
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer" }}>Show which</summary>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {blocked.map((b) => (
                <li key={b.id}>
                  {b.name} ({b.email}) — {b.reason}
                </li>
              ))}
            </ul>
          </details>
          <button
            onClick={() => setBlocked([])}
            style={{
              marginTop: 8,
              background: "transparent",
              border: "none",
              padding: 0,
              color: colors.textDim,
              fontSize: font.size.sm,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Dismiss
          </button>
        </Banner>
      )}

      {/* Creator table. The container scrolls in BOTH axes: vertically through
          rows, horizontally when the viewport is narrower than the columns
          need — better than letting the columns crush and lose alignment. */}
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
            <SkeletonRows count={6} height={44} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon={<Search size={24} strokeWidth={1.75} color={colors.textMuted} />}
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
          <div style={{ minWidth: CREATOR_MIN_WIDTH }}>
            <CreatorTableHeader
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              allSelected={filtered.length > 0 && filtered.every((r) => selected.has(r.creator.id))}
              someSelected={filtered.some((r) => selected.has(r.creator.id))}
              onToggleAll={() =>
                filtered.every((r) => selected.has(r.creator.id))
                  ? setSelected(new Set())
                  : selectAll(filtered)
              }
            />
            {filtered.map((row) => (
              <CreatorTableRow
                key={row.creator.id}
                row={row}
                selected={selected.has(row.creator.id)}
                onToggle={() => toggleOne(row.creator.id)}
                onDelete={() =>
                  setPendingDelete({
                    kind: "creators",
                    ids: [row.creator.id],
                    label: row.creator.name,
                  })
                }
                showBatchStatus={!!activeBatchId}
              />
            ))}
          </div>
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

        {/*
          PLU-70: state the post-acceptance behavior these creators will be
          enrolled under, BEFORE enrollment — it is locked onto each execution at
          creation and a later campaign edit cannot change it, so this is the
          last moment it can be chosen.
        */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: font.size.sm,
            color: colors.textDim,
            flexShrink: 0,
          }}
        >
          Post-acceptance:
          <Select
            value={effectiveMode}
            onChange={(e) => setModeOverride(e.target.value as PostAcceptanceMode)}
            aria-label="Post-acceptance behavior for these enrollments"
            style={{ height: 40, width: 210 }}
          >
            <option value="local_payment">{MODE_LABEL.local_payment}</option>
            <option value="operator_handoff">{MODE_LABEL.operator_handoff}</option>
          </Select>
        </label>
        {selected.size > 0 && (
          <Button
            variant="secondary"
            onClick={() =>
              setPendingDelete({
                kind: "creators",
                ids: [...selected],
                label: `${selected.size} creator${selected.size !== 1 ? "s" : ""}`,
              })
            }
            style={{ height: 40, color: colors.danger, borderColor: `${colors.danger}55` }}
          >
            Remove {selected.size}
          </Button>
        )}
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

      {pendingDelete && (
        <ConfirmDialog
          destructive
          busy={deleting}
          title={
            pendingDelete.kind === "creators"
              ? `Remove ${pendingDelete.label}?`
              : `Delete “${pendingDelete.batch.label}”?`
          }
          confirmLabel={pendingDelete.kind === "creators" ? "Remove" : "Delete list"}
          message={
            pendingDelete.kind === "creators" ? (
              <>
                This permanently removes them from your roster.
                <br />
                <br />
                Anyone enrolled in a workflow or holding a partnership will be{" "}
                <strong>kept</strong> and listed afterwards — removing them would destroy
                execution and payout history.
              </>
            ) : (
              <>
                This removes the list and its import history.
                <br />
                <br />
                The{" "}
                <strong>
                  {pendingDelete.batch.createdCount + pendingDelete.batch.updatedCount} creator
                  {pendingDelete.batch.createdCount + pendingDelete.batch.updatedCount !== 1
                    ? "s"
                    : ""}
                </strong>{" "}
                it added <strong>stay in your roster</strong>. To hide the list but keep it,
                archive it instead.
              </>
            )
          }
          onConfirm={() => void runDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {renaming && (
        <Modal
          title="Rename list"
          width={420}
          onClose={() => setRenaming(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => void submitRename()}
                disabled={!renaming.value.trim()}
              >
                Rename
              </Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitRename();
            }}
            style={{ padding: "18px 22px" }}
          >
            <Input
              value={renaming.value}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              aria-label="List name"
              autoFocus
              style={{ width: "100%" }}
            />
          </form>
        </Modal>
      )}
    </div>
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
