// Tabs — accessible tablist. Controlled: parent owns the active key, so this
// is a drop-in for the existing string-state tab switchers (no logic change).
import type { ReactNode } from "react";
import { colors, font } from "../../theme";

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
  /** Optional trailing count/badge. */
  badge?: ReactNode;
  disabled?: boolean;
}

interface Props<K extends string> {
  items: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
}

export function Tabs<K extends string>({ items, active, onChange }: Props<K>) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel,
      }}
    >
      {items.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={selected}
            disabled={t.disabled}
            onClick={() => onChange(t.key)}
            className="ds-focusable"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "11px 16px",
              background: "none",
              border: "none",
              borderBottom: `2px solid ${selected ? colors.accent : "transparent"}`,
              marginBottom: -1,
              color: t.disabled ? colors.textDim : selected ? colors.text : colors.textMuted,
              fontSize: font.size.md,
              fontWeight: selected ? font.weight.semibold : font.weight.medium,
              cursor: t.disabled ? "not-allowed" : "pointer",
              textTransform: "capitalize",
            }}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}
