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
          fontSize: font.size.xs,
          fontWeight: font.weight.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          color: colors.textDim,
        }}
      >
        {children}
      </span>
      {count !== undefined && (
        <span
          className="nums"
          style={{
            fontSize: font.size.xs,
            fontWeight: font.weight.medium,
            color: colors.textMuted,
            background: colors.panelAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: 999,
            padding: "0 8px",
            lineHeight: 1.7,
          }}
        >
          {count}
        </span>
      )}
      {actions && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>{actions}</div>}
    </div>
  );
}
