// Slider — thin wrapper over a native range input with accent theming and
// optional min/max captions. Forwards onMouseUp/onTouchEnd/onChange untouched.
import type { InputHTMLAttributes, ReactNode } from "react";
import { colors } from "../../theme";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  minLabel?: ReactNode;
  maxLabel?: ReactNode;
}

export function Slider({ minLabel, maxLabel, style, className, ...rest }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <input
        {...rest}
        type="range"
        className={`ds-focusable${className ? ` ${className}` : ""}`}
        style={{ width: "100%", accentColor: colors.accent, ...style }}
      />
      {(minLabel || maxLabel) && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10.5,
            color: colors.textDim,
          }}
        >
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
    </div>
  );
}
