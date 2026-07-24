// Card — unified panel surface.
//   variant="raised" (default) — bordered + soft shadow. A top-level surface.
//   variant="flat"            — bordered, no shadow. For cards that sit *inside*
//                                another surface, so we don't stack shadow-on-
//                                shadow (the "nested box" slop tell).
//   variant="inset"           — no border, faintly-darker fill. For sub-sections
//                                inside a card: reads as a grouped region via
//                                tone, not another outline.
// `interactive` adds hover lift + pointer.
import type { HTMLAttributes, ReactNode } from "react";
import { colors, radii, shadow } from "../../theme";

type CardVariant = "raised" | "flat" | "inset";

interface Props extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  variant?: CardVariant;
  padding?: number | string;
  children: ReactNode;
}

const variantStyle: Record<CardVariant, React.CSSProperties> = {
  raised: {
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    boxShadow: shadow.sm,
  },
  flat: {
    background: colors.panel,
    border: `1px solid ${colors.border}`,
    boxShadow: "none",
  },
  inset: {
    background: colors.bg,
    border: "none",
    boxShadow: "none",
  },
};

export function Card({
  interactive,
  variant = "raised",
  padding = 0,
  children,
  style,
  className,
  ...rest
}: Props) {
  return (
    <div
      {...rest}
      className={`${interactive ? "ds-card-interactive " : ""}${className ?? ""}`.trim() || undefined}
      style={{
        ...variantStyle[variant],
        borderRadius: radii.md,
        padding,
        cursor: interactive ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
