// Breadcrumbs — navigational trail. Items with an onClick render as buttons;
// the last/plain items render as static text. Uses a nav landmark for a11y.
import { Fragment } from "react";
import { colors, font } from "../../theme";

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      {items.map((c, i) => {
        const isLast = i === items.length - 1;
        return (
          <Fragment key={i}>
            {c.onClick && !isLast ? (
              <button
                onClick={c.onClick}
                className="ds-focusable"
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: colors.textMuted,
                  fontSize: font.size.sm,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 160,
                }}
              >
                {c.label}
              </button>
            ) : (
              <span
                aria-current={isLast ? "page" : undefined}
                style={{
                  fontSize: font.size.sm,
                  color: isLast ? colors.text : colors.textMuted,
                  fontWeight: isLast ? font.weight.semibold : font.weight.regular,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 220,
                }}
              >
                {c.label}
              </span>
            )}
            {!isLast && <span style={{ color: colors.textDim, fontSize: font.size.sm }}>/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
