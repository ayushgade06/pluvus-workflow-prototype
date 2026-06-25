// StatTile — a labelled metric tile (the recurring "big number + caption"
// pattern used across Enroll / Launch / Monitor / Observability headers).
import type { ReactNode } from "react";
import { colors, radii, font } from "../../theme";

interface Props {
  label: ReactNode;
  value: ReactNode;
  color?: string | undefined;
  /** Optional sub-line (e.g. a delta or unit). */
  sub?: ReactNode;
  align?: "left" | "center";
}

export function StatTile({ label, value, color, sub, align = "center" }: Props) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: "12px 16px",
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        textAlign: align,
      }}
    >
      <div style={{ fontSize: font.size.xxl, fontWeight: font.weight.bold, color: color ?? colors.text, lineHeight: 1.1 }}>
        {value}
      </div>
      <div
        style={{
          fontSize: font.size.xs,
          color: colors.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          marginTop: 3,
        }}
      >
        {label}
      </div>
      {sub && <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
