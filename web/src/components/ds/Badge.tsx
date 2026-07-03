// Badge / Chip — small labelled tokens.
//   Badge: status pill, tinted from a single colour (with optional dot).
//   Chip:  neutral config token (e.g. "delay 0s", "3 follow-ups").
// StatusBadge maps an API status string straight to the right colour + label.
import type { ReactNode } from "react";
import { colors, radii, font, statusColor, statusKey, type StatusKey } from "../../theme";

export function Badge({
  children,
  color = colors.textMuted,
  dot,
  small,
}: {
  children: ReactNode;
  color?: string | undefined;
  dot?: boolean | undefined;
  small?: boolean | undefined;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: small ? font.size.xs : font.size.sm,
        fontWeight: font.weight.medium,
        color,
        background: `${color}17`,
        border: `1px solid ${color}2e`,
        borderRadius: radii.pill,
        padding: small ? "1.5px 8px" : "3px 10px",
        whiteSpace: "nowrap",
        lineHeight: 1.5,
        letterSpacing: 0,
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />}
      {children}
    </span>
  );
}

export function Chip({
  children,
  color,
  title,
}: {
  children: ReactNode;
  color?: string;
  title?: string;
}) {
  const c = color ?? colors.textMuted;
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: font.size.xs,
        fontWeight: font.weight.medium,
        color: c,
        background: colors.panelAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.pill,
        padding: "1.5px 9px",
        whiteSpace: "nowrap",
        lineHeight: 1.6,
        maxWidth: 180,
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {children}
    </span>
  );
}

const STATUS_LABEL: Record<StatusKey, string> = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
  invalid: "Invalid",
};

export function StatusBadge({ status, small }: { status: string; small?: boolean }) {
  const key = statusKey(status);
  return (
    <Badge color={statusColor[key]} dot small={small}>
      {STATUS_LABEL[key]}
    </Badge>
  );
}
