// SectionHeader — uppercase tracked label with optional count chip and a
// right-aligned actions slot. Consistent section dividers across screens.
import type { ReactNode } from "react";
import { colors, font } from "../../theme";

interface Props {
  children: ReactNode;
  count?: number;
  actions?: ReactNode;
}

export function SectionHeader({ children, count, actions }: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "4px 0 10px",
      }}
    >
      <span
        style={{
          fontSize: font.size.sm,
          fontWeight: font.weight.bold,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          color: colors.textMuted,
        }}
      >
        {children}
      </span>
      {count !== undefined && (
        <span
          style={{
            fontSize: font.size.xs,
            color: colors.textDim,
            background: colors.panelAlt,
            borderRadius: 10,
            padding: "0 7px",
            lineHeight: 1.6,
          }}
        >
          {count}
        </span>
      )}
      {actions && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>{actions}</div>}
    </div>
  );
}
