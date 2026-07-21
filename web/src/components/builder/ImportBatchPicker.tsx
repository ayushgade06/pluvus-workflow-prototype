// ---------------------------------------------------------------------------
// Source-list picker + scoped select-all (PLU-109)
// ---------------------------------------------------------------------------
// The answer to "if I select all, how do I make sure I only get the new ones".
//
// Every scope below is a predicate over the SAME already-loaded array — this is
// one dropdown, not four features. What makes them possible is that the batch
// endpoint returns a per-row outcome (CREATED = first seen by this import) and
// the workflow returns its enrolled creator ids.

import { useEffect, useRef, useState } from "react";
import { colors, radii, font } from "../../theme";
import { Button, IconButton, Select } from "../ds";
import type { ImportBatch } from "../../api/builderTypes";

export interface SelectScope {
  key: string;
  label: string;
  /** Number of creators this scope would select right now. */
  count: number;
  /** Null when the scope does not apply to the current view. */
  apply: (() => void) | null;
}

interface Props {
  batches: ImportBatch[];
  activeBatchId: string | null;
  onChangeBatch: (id: string | null) => void;
  scopes: SelectScope[];
  onClear: () => void;
  clearDisabled: boolean;
  /** List management — only offered while a list is selected. */
  activeBatch: ImportBatch | null;
  onRenameList: () => void;
  onArchiveList: () => void;
  onDeleteList: () => void;
}

function batchOptionLabel(b: ImportBatch): string {
  const n = b.createdCount + b.updatedCount;
  return `${b.label} (${n})`;
}

/** Shared dismiss behaviour: a bare dropdown that ignores Escape is worse than none. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

const menuItemStyle = (enabled: boolean, danger?: boolean) =>
  ({
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "9px 13px",
    background: "transparent",
    border: "none",
    color: !enabled ? colors.textMuted : danger ? colors.danger : colors.text,
    fontSize: font.size.sm,
    textAlign: "left" as const,
    cursor: enabled ? "pointer" : "default",
  });

export function ImportBatchPicker({
  batches,
  activeBatchId,
  onChangeBatch,
  scopes,
  onClear,
  clearDisabled,
  activeBatch,
  onRenameList,
  onArchiveList,
  onDeleteList,
}: Props) {
  const [open, setOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const menuRef = useDismiss(open, () => setOpen(false));
  const listRef = useDismiss(listOpen, () => setListOpen(false));

  const usable = scopes.filter((s) => s.apply !== null);

  return (
    <>
      <Select
        value={activeBatchId ?? ""}
        onChange={(e) => onChangeBatch(e.target.value || null)}
        aria-label="Filter creators by import list"
        style={{ maxWidth: 260, flexShrink: 0 }}
      >
        <option value="">All creators</option>
        {batches.map((b) => (
          <option key={b.id} value={b.id}>
            {batchOptionLabel(b)}
          </option>
        ))}
      </Select>

      {/* List management — only meaningful once a list is chosen. */}
      {activeBatch && (
        <div ref={listRef} style={{ position: "relative", flexShrink: 0 }}>
          <IconButton
            label={`Manage list “${activeBatch.label}”`}
            icon="⋯"
            onClick={() => setListOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={listOpen}
            style={{ border: `1px solid ${colors.border}`, height: 34, width: 34 }}
          />
          {listOpen && (
            <div
              role="menu"
              className="ds-fade-in"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                zIndex: 20,
                minWidth: 210,
                background: colors.panel,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
                overflow: "hidden",
              }}
            >
              <button
                role="menuitem"
                className="ds-row ds-focusable"
                onClick={() => {
                  setListOpen(false);
                  onRenameList();
                }}
                style={{ ...menuItemStyle(true), borderBottom: `1px solid ${colors.border}` }}
              >
                Rename list…
              </button>
              <button
                role="menuitem"
                className="ds-row ds-focusable"
                onClick={() => {
                  setListOpen(false);
                  onArchiveList();
                }}
                style={{ ...menuItemStyle(true), borderBottom: `1px solid ${colors.border}` }}
              >
                Archive list
                <span style={{ color: colors.textMuted, fontSize: font.size.xs }}>hide, keep</span>
              </button>
              <button
                role="menuitem"
                className="ds-row ds-focusable"
                onClick={() => {
                  setListOpen(false);
                  onDeleteList();
                }}
                style={menuItemStyle(true, true)}
              >
                Delete list…
                <span style={{ color: colors.textMuted, fontSize: font.size.xs }}>
                  keeps creators
                </span>
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
        <Button
          variant="secondary"
          onClick={() => setOpen((v) => !v)}
          disabled={usable.length === 0}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          Select ▾
        </Button>

        {open && (
          <div
            role="menu"
            className="ds-fade-in"
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              zIndex: 20,
              minWidth: 280,
              background: colors.panel,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              overflow: "hidden",
            }}
          >
            {usable.map((s) => (
              <button
                key={s.key}
                role="menuitem"
                className="ds-row ds-focusable"
                onClick={() => {
                  s.apply!();
                  setOpen(false);
                }}
                disabled={s.count === 0}
                style={{
                  ...menuItemStyle(s.count > 0),
                  borderBottom: `1px solid ${colors.border}`,
                }}
              >
                <span>{s.label}</span>
                <span style={{ color: colors.textDim, fontVariantNumeric: "tabular-nums" }}>
                  {s.count}
                </span>
              </button>
            ))}
            <button
              role="menuitem"
              className="ds-row ds-focusable"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              disabled={clearDisabled}
              style={menuItemStyle(!clearDisabled)}
            >
              Clear selection
            </button>
          </div>
        )}
      </div>
    </>
  );
}
