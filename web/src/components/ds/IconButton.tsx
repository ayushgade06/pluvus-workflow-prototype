// IconButton — square icon-only button. Always requires an aria-label for a11y.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { colors, radii } from "../../theme";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only controls must be labelled for screen readers. */
  label: string;
  icon: ReactNode;
  size?: number;
}

export function IconButton({ label, icon, size = 28, style, className, ...rest }: Props) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={rest.title ?? label}
      className={`ds-focusable ds-iconbtn ds-btn${className ? ` ${className}` : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        padding: 0,
        background: "transparent",
        border: "none",
        borderRadius: radii.sm,
        color: colors.textMuted,
        fontSize: 14,
        lineHeight: 1,
        ...style,
      }}
    >
      {icon}
    </button>
  );
}
