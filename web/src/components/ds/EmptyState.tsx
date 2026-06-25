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
      {icon && <div style={{ fontSize: compact ? 28 : 40, lineHeight: 1 }}>{icon}</div>}
      <div>
        <div
          style={{
            fontSize: compact ? font.size.md : font.size.lg,
            fontWeight: font.weight.semibold,
            color: colors.text,
            marginBottom: 6,
          }}
        >
          {title}
        </div>
        {description && (
          <div
            style={{
              fontSize: font.size.md,
              color: colors.textMuted,
              maxWidth: 340,
              lineHeight: 1.5,
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
