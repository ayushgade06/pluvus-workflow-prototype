// ---------------------------------------------------------------------------
// Import draft preview (PLU-109)
// ---------------------------------------------------------------------------
// Shown after a CSV is uploaded and BEFORE anything is written to the roster.
// When you are adding 500 unfamiliar rows, seeing what the import will do —
// how many are new, how many you already have, which rows were rejected and
// why — matters more than saving a click.

import { colors, radii, font } from "../../theme";
import { Button } from "../ds";
import type { ImportDraftResponse } from "../../api/builderTypes";

interface Props {
  draft: ImportDraftResponse;
  committing: boolean;
  onCommit: () => void;
  onDiscard: () => void;
}

function formatCount(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function ImportPreviewPanel({ draft, committing, onCommit, onDiscard }: Props) {
  const { batch, rowCount, newCount, existingCount, skippedCount, errors, preview } = draft;
  const delimiterLabel =
    draft.delimiter === "\t" ? "tab" : draft.delimiter === ";" ? "semicolon" : "comma";

  return (
    <div
      className="ds-fade-in"
      style={{
        border: `1px solid ${colors.accent}55`,
        background: `${colors.accent}0d`,
        borderRadius: radii.md,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        flexShrink: 0,
        maxHeight: "45%",
        overflow: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: font.size.md, color: colors.text }}>
          Ready to import — nothing saved yet
        </strong>
        <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
          {batch.sourceFilename} · {delimiterLabel}-separated
        </span>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: font.size.md }}>
        <Stat label="rows" value={rowCount} />
        <Stat label="new" value={newCount} color={colors.success} />
        <Stat label="already in roster" value={existingCount} color={colors.textDim} />
        <Stat
          label="skipped"
          value={skippedCount}
          color={skippedCount > 0 ? colors.warning : colors.textDim}
        />
      </div>

      {preview.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: font.size.sm,
              minWidth: 620,
            }}
          >
            <thead>
              <tr style={{ color: colors.textMuted, textAlign: "left" }}>
                <Th>#</Th>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>Platform</Th>
                <Th>Niche</Th>
                <Th align="right">Followers</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {preview.map((r) => (
                <tr key={r.row} style={{ borderTop: `1px solid ${colors.border}` }}>
                  <Td muted>{r.row}</Td>
                  <Td>{r.email}</Td>
                  <Td>{r.name}</Td>
                  <Td muted>{r.platform ?? "—"}</Td>
                  <Td muted>{r.niche ?? "—"}</Td>
                  <Td align="right">{formatCount(r.followerCount)}</Td>
                  <Td>
                    <span
                      style={{
                        fontSize: font.size.xs,
                        color: r.isNew ? colors.success : colors.textDim,
                      }}
                    >
                      {r.isNew ? "NEW" : "existing"}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          {rowCount > preview.length && (
            <div style={{ fontSize: font.size.xs, color: colors.textMuted, marginTop: 6 }}>
              Showing the first {preview.length} of {rowCount} rows.
            </div>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: font.size.sm, color: colors.warning }}>
            {errors.length} row{errors.length !== 1 ? "s" : ""} will be skipped
          </summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: font.size.sm }}>
            {errors.slice(0, 50).map((e) => (
              <li key={e.row} style={{ color: colors.textDim }}>
                Row {e.row}: {e.reason}
              </li>
            ))}
            {errors.length > 50 && <li>…and {errors.length - 50} more</li>}
          </ul>
        </details>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Button variant="primary" onClick={onCommit} disabled={committing || newCount + existingCount === 0}>
          {committing ? "Importing…" : `Import ${newCount + existingCount} creator${newCount + existingCount !== 1 ? "s" : ""}`}
        </Button>
        <Button variant="secondary" onClick={onDiscard} disabled={committing}>
          Discard
        </Button>
        {newCount + existingCount === 0 && (
          <span style={{ fontSize: font.size.sm, color: colors.warning }}>
            No importable rows — every row was skipped.
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span style={{ color: colors.textDim }}>
      <strong style={{ color: color ?? colors.text, fontWeight: font.weight.semibold }}>
        {value}
      </strong>{" "}
      {label}
    </span>
  );
}

function Th({ children, align }: { children?: React.ReactNode; align?: "right" }) {
  return (
    <th style={{ padding: "4px 8px", fontWeight: font.weight.medium, textAlign: align ?? "left" }}>
      {children}
    </th>
  );
}

function Td({
  children,
  muted,
  align,
}: {
  children?: React.ReactNode;
  muted?: boolean;
  align?: "right";
}) {
  return (
    <td
      style={{
        padding: "5px 8px",
        color: muted ? colors.textDim : colors.text,
        textAlign: align ?? "left",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
