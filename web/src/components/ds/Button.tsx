// Button — design-system primitive (Phase A, presentational only).
// Variants map to .ds-btn-* classes in index.css for hover/active/focus states
// that inline styles can't express. No data/logic here.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { colors, radii, font } from "../../theme";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

const SIZES: Record<ButtonSize, { padding: string; fontSize: number; height: number }> = {
  sm: { padding: "0 12px", fontSize: font.size.sm, height: 28 },
  md: { padding: "0 18px", fontSize: font.size.md, height: 34 },
};

function variantStyle(variant: ButtonVariant): React.CSSProperties {
  switch (variant) {
    case "primary":
      return { background: colors.accent, color: "#fff", border: "1px solid transparent" };
    case "secondary":
      return { background: colors.panel, color: colors.text, border: `1px solid ${colors.border}` };
    case "danger":
      return { background: "transparent", color: colors.danger, border: `1px solid ${colors.danger}` };
    case "ghost":
    default:
      return { background: "transparent", color: colors.textMuted, border: "1px solid transparent" };
  }
}

export function Button({
  variant = "secondary",
  size = "md",
  leftIcon,
  rightIcon,
  fullWidth,
  children,
  style,
  className,
  ...rest
}: Props) {
  const s = SIZES[size];
  return (
    <button
      {...rest}
      className={`ds-focusable ds-btn ds-btn-${variant}${className ? ` ${className}` : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: s.padding,
        height: s.height,
        width: fullWidth ? "100%" : undefined,
        borderRadius: radii.sm,
        fontSize: s.fontSize,
        fontWeight: font.weight.semibold,
        lineHeight: 1,
        whiteSpace: "nowrap",
        ...variantStyle(variant),
        ...style,
      }}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
}
