// StatTile — a labelled metric tile (the recurring "big number + caption"
// pattern used across Enroll / Launch / Monitor / Observability headers).
import type { ReactNode } from "react";
import { colors, radii, font, shadow } from "../../theme";

interface Props {
  label: ReactNode;
  value: ReactNode;
  color?: string | undefined;
  /** Optional sub-line (e.g. a delta or unit). */
  sub?: ReactNode;
  align?: "left" | "center";
}

export function StatTile({ label, value, color, sub, align = "left" }: Props) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: "16px 18px",
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        boxShadow: shadow.sm,
        textAlign: align,
      }}
    >
      <div
        style={{
          fontSize: font.size.xs,
          fontWeight: font.weight.medium,
          color: colors.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        className="nums"
        style={{
          fontSize: font.size.xxl,
          fontWeight: font.weight.semibold,
          color: color ?? colors.text,
          lineHeight: 1.1,
          letterSpacing: -0.5,
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}
