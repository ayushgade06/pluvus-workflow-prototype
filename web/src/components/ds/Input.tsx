// Input / Textarea / Select — design-system form controls.
// They forward every native prop (value, onChange, onBlur, etc.) untouched, so
// dropping them into existing forms changes appearance only, never behaviour.
// Input and Textarea also forward a `ref` to the underlying element (via
// forwardRef) so callers that need the DOM node — e.g. caret-aware variable
// insertion in the outreach composer — can reach it. Callers that don't pass a
// ref are unaffected.
import { forwardRef } from "react";
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

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ invalid, style, className, ...rest }, ref) {
  return (
    <input
      {...rest}
      ref={ref}
      className={`ds-input ds-focusable${className ? ` ${className}` : ""}`}
      style={{
        ...base,
        ...(invalid ? { borderColor: colors.danger } : null),
        ...style,
      }}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ invalid, style, className, ...rest }, ref) {
  return (
    <textarea
      {...rest}
      ref={ref}
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
});

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
