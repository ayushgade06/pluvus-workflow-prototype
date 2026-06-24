// Small shared presentational primitives.
import type { ReactNode } from "react";
import type { InstanceState } from "../api/types";
import { colors, stateColor, stateLabel, sourceInfo } from "../theme";

export function StateBadge({ state, small }: { state: InstanceState; small?: boolean }) {
  const c = stateColor[state];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: small ? 10.5 : 11.5,
        fontWeight: 600,
        color: c,
        background: `${c}1a`,
        border: `1px solid ${c}55`,
        borderRadius: 5,
        padding: small ? "1px 6px" : "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c }} />
      {stateLabel[state]}
    </span>
  );
}

export function SourceBadge({ source }: { source: string | null }) {
  const info = sourceInfo(source);
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: info.color,
        background: `${info.color}1a`,
        border: `1px solid ${info.color}44`,
        borderRadius: 4,
        padding: "1px 5px",
        whiteSpace: "nowrap",
      }}
    >
      {info.label}
    </span>
  );
}

export function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: colors.textDim }}>
        {label}
      </span>
      <span
        className={mono ? "mono" : undefined}
        style={{ fontSize: mono ? 11.5 : 13, color: colors.text, wordBreak: "break-word" }}
      >
        {value ?? "—"}
      </span>
    </div>
  );
}

export function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color: colors.textMuted,
        margin: "4px 0 10px",
      }}
    >
      {children}
      {count !== undefined && (
        <span
          style={{
            fontSize: 10,
            color: colors.textDim,
            background: colors.panelAlt,
            borderRadius: 10,
            padding: "0 7px",
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 12.5, color: colors.textDim, padding: "12px 2px", fontStyle: "italic" }}>
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div style={{ fontSize: 12.5, color: colors.textMuted, padding: "16px 2px" }}>
      {label ?? "Loading…"}
    </div>
  );
}
