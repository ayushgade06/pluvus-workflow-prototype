// Input / Textarea / Select — design-system form controls.
// They forward every native prop (value, onChange, onBlur, etc.) untouched, so
// dropping them into existing forms changes appearance only, never behaviour.
import type {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
} from "react";
import { colors, radii, font } from "../../theme";

const base: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.sm + 1,
  color: colors.text,
  fontSize: font.size.md,
  fontFamily: "inherit",
  lineHeight: 1.45,
  outline: "none",
  boxSizing: "border-box",
};

export function Input({
  invalid,
  style,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...rest}
      className={`ds-input ds-focusable${className ? ` ${className}` : ""}`}
      style={{
        ...base,
        ...(invalid ? { borderColor: colors.danger } : null),
        ...style,
      }}
    />
  );
}

export function Textarea({
  invalid,
  style,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      {...rest}
      className={`ds-input ds-focusable${className ? ` ${className}` : ""}`}
      style={{
        ...base,
        resize: "vertical",
        lineHeight: 1.5,
        ...(invalid ? { borderColor: colors.danger } : null),
        ...style,
      }}
    />
  );
}

export function Select({
  invalid,
  style,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; children: ReactNode }) {
  return (
    <select
      {...rest}
      className={`ds-input ds-focusable${className ? ` ${className}` : ""}`}
      style={{
        ...base,
        cursor: "pointer",
        appearance: "none",
        ...(invalid ? { borderColor: colors.danger } : null),
        ...style,
      }}
    >
      {children}
    </select>
  );
}
