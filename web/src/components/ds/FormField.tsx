// FormField — label + control + optional hint/error wrapper.
// Generates an id so the <label htmlFor> properly associates with its control
// (a11y). Pass children that accept an id, or wire it manually.
import type { ReactNode } from "react";
import { colors, font } from "../../theme";

interface Props {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}

export function FormField({ label, htmlFor, hint, error, children }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <label
        htmlFor={htmlFor}
        style={{
          fontSize: font.size.sm,
          fontWeight: font.weight.semibold,
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <span style={{ fontSize: font.size.xs, color: colors.textDim, lineHeight: 1.4 }}>
          {hint}
        </span>
      )}
      {error && (
        <span style={{ fontSize: font.size.xs, color: colors.danger, lineHeight: 1.4 }}>
          {error}
        </span>
      )}
    </div>
  );
}
