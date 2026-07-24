// Card — sticker surface (Tano look).
//   variant="raised" (default) — thick ink border + hard offset drop-shadow.
//                                A top-level surface that reads like cut paper.
//   variant="flat"            — thick ink border, no shadow. For cards that sit
//                                *inside* another surface (no shadow-on-shadow).
//   variant="inset"           — no border, faintly-warmer fill. A grouped
//                                sub-region: reads via tone, not another outline.
// `accent` fills the card with a candy block colour (coral/butter/mint/…),
//   à la Tano's sticky-notes — border + text stay ink.
// `interactive` adds the sticker hover-lift + pointer.
import type { HTMLAttributes, ReactNode } from "react";
import { colors, radii, shadow } from "../../theme";

type CardVariant = "raised" | "flat" | "inset";

interface Props extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  variant?: CardVariant;
  /** Solid candy fill (e.g. accents.mint). Border/text stay ink. */
  accent?: string;
  padding?: number | string;
  children: ReactNode;
}

function variantStyle(variant: CardVariant, accent?: string): React.CSSProperties {
  switch (variant) {
    case "flat":
      return {
        background: accent ?? colors.panel,
        border: `2px solid ${colors.cardBorder}`,
        boxShadow: "none",
      };
    case "inset":
      return {
        background: accent ?? colors.panelAlt,
        border: "none",
        boxShadow: "none",
      };
    case "raised":
    default:
      return {
        background: accent ?? colors.panel,
        border: `2px solid ${colors.cardBorder}`,
        boxShadow: shadow.md,
      };
  }
}

export function Card({
  interactive,
  variant = "raised",
  accent,
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
        ...variantStyle(variant, accent),
        borderRadius: radii.md,
        padding,
        cursor: interactive ? "pointer" : undefined,
        // When a card is accent-filled, force ink text so candy fills stay legible.
        color: accent ? colors.text : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
