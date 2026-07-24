// StatTile — a labelled metric tile (the recurring "big number + caption"
// pattern used across Enroll / Launch / Monitor / Observability headers).
// Tano look: sticker card (ink border + hard shadow), serif number, optional
// leading icon and a trend sparkline in the corner.
import type { ReactNode } from "react";
import { colors, radii, font, shadow } from "../../theme";
import { Sparkline } from "./Charts";

interface Props {
  label: ReactNode;
  value: ReactNode;
  color?: string | undefined;
  /** Optional sub-line (e.g. a delta or unit). */
  sub?: ReactNode;
  /** Optional leading icon (lucide element). */
  icon?: ReactNode;
  /** Optional trend series → renders a sparkline in the top-right. */
  trend?: number[];
  align?: "left" | "center";
}

export function StatTile({ label, value, color, sub, icon, trend, align = "left" }: Props) {
  const accent = color ?? colors.accent;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: "16px 18px",
        background: colors.panel,
        border: `2px solid ${colors.cardBorder}`,
        borderRadius: radii.md,
        boxShadow: shadow.md,
        textAlign: align,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {icon && (
            <span
              aria-hidden
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: `${accent}2e`,
                border: `1.5px solid ${colors.cardBorder}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: colors.text,
                flexShrink: 0,
              }}
            >
              {icon}
            </span>
          )}
          <span
            style={{
              fontSize: font.size.xs,
              fontWeight: font.weight.semibold,
              color: colors.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
        </div>
        {trend && trend.length > 1 && <Sparkline data={trend} color={accent} />}
      </div>
      <div
        className="serif nums"
        style={{
          fontSize: font.size.display,
          fontWeight: font.weight.black,
          color: color ?? colors.text,
          lineHeight: 1.05,
          letterSpacing: -0.5,
        }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}
