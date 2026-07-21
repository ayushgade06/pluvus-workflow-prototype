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
import { Button, Select } from "../ds";
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
}

function batchOptionLabel(b: ImportBatch): string {
  const n = b.createdCount + b.updatedCount;
  return `${b.label} (${n})`;
}

export function ImportBatchPicker({
  batches,
  activeBatchId,
  onChangeBatch,
  scopes,
  onClear,
  clearDisabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — a bare dropdown that traps focus is worse
  // than no dropdown.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "9px 13px",
                  background: "transparent",
                  border: "none",
                  borderBottom: `1px solid ${colors.border}`,
                  color: s.count === 0 ? colors.textMuted : colors.text,
                  fontSize: font.size.sm,
                  textAlign: "left",
                  cursor: s.count === 0 ? "default" : "pointer",
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
              style={{
                display: "block",
                width: "100%",
                padding: "9px 13px",
                background: "transparent",
                border: "none",
                color: clearDisabled ? colors.textMuted : colors.textDim,
                fontSize: font.size.sm,
                textAlign: "left",
                cursor: clearDisabled ? "default" : "pointer",
              }}
            >
              Clear selection
            </button>
          </div>
        )}
      </div>
    </>
  );
}
