// Toggle — accessible switch built on a real checkbox input (visually hidden),
// so it's keyboard-operable and screen-reader-correct while looking custom.
import { useId } from "react";
import { colors, radii } from "../../theme";

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: Props) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ position: "relative", display: "inline-flex" }}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="ds-focusable"
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            margin: 0,
            opacity: 0,
            cursor: "inherit",
          }}
        />
        <span
          aria-hidden
          style={{
            width: 34,
            height: 20,
            borderRadius: radii.pill,
            background: checked ? colors.accent : colors.border,
            transition: "background 0.15s ease",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.15s ease",
          }}
        />
      </span>
      {label && (
        <span style={{ fontSize: 12, color: colors.textMuted, lineHeight: 1.4 }}>{label}</span>
      )}
    </label>
  );
}
