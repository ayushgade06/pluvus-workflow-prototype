// EmptyState — standardised "nothing here yet" placeholder with optional CTA.
import type { ReactNode } from "react";
import { colors, font } from "../../theme";

interface Props {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Compact variant for inline/in-panel empties (vs full-page). */
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, compact }: Props) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: compact ? 10 : 18,
        padding: compact ? "32px 20px" : "72px 24px",
        height: compact ? undefined : "100%",
      }}
    >
      {icon && (
        <div
          aria-hidden
          style={{
            width: compact ? 44 : 56,
            height: compact ? 44 : 56,
            borderRadius: compact ? 12 : 16,
            background: colors.panelAlt,
            border: `1px solid ${colors.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: compact ? 20 : 26,
            lineHeight: 1,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
          }}
        >
          {icon}
        </div>
      )}
      <div>
        <div
          style={{
            fontSize: compact ? font.size.md : font.size.lg,
            fontWeight: font.weight.semibold,
            color: colors.text,
            marginBottom: 6,
            letterSpacing: -0.2,
          }}
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              fontSize: font.size.md,
              color: colors.textMuted,
              maxWidth: 360,
              lineHeight: 1.6,
              margin: "0 auto",
            }}
          >
            {description}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
