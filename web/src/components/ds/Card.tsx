// Card — unified panel surface. `interactive` adds hover lift + pointer.
import type { HTMLAttributes, ReactNode } from "react";
import { colors, radii, shadow } from "../../theme";

interface Props extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  padding?: number | string;
  children: ReactNode;
}

export function Card({ interactive, padding = 0, children, style, className, ...rest }: Props) {
  return (
    <div
      {...rest}
      className={`${interactive ? "ds-card-interactive " : ""}${className ?? ""}`.trim() || undefined}
      style={{
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        boxShadow: shadow.sm,
        padding,
        cursor: interactive ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
