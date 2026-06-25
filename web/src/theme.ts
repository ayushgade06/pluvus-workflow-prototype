// ---------------------------------------------------------------------------
// Design tokens (Phase 9, Part 12)
// ---------------------------------------------------------------------------
// Operational visibility over marketing polish. A restrained dark palette,
// one accent per state semantic-group, generous whitespace, monospace for ids.
// Think: workflow runtime inspector, not a landing page.

import type { InstanceState } from "./api/types";

export const colors = {
  bg: "#0d1117",
  panel: "#161b22",
  panelAlt: "#1c2230",
  border: "#2d333b",
  borderStrong: "#3d444d",
  text: "#e6edf3",
  textMuted: "#9198a1",
  textDim: "#6e7681",
  accent: "#388bfd",
  accentDim: "#1f6feb",
  warning: "#d29922",
  danger: "#f85149",
  success: "#3fb950",
};

// ---------------------------------------------------------------------------
// Design-system scales (Phase A — additive, presentational only)
// ---------------------------------------------------------------------------
// One source of truth for spacing / radii / shadows / typography / z-index, so
// primitives and screens stop hard-coding magic numbers. Nothing here changes
// data flow — it's pure visual vocabulary.

// 4px base spacing scale. Use `space[3]` instead of literal `12`.
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radii = {
  sm: 5,
  md: 8,
  lg: 12,
  pill: 999,
} as const;

export const shadow = {
  sm: "0 1px 2px rgba(0,0,0,0.30)",
  md: "0 4px 12px rgba(0,0,0,0.35)",
  lg: "0 8px 28px rgba(0,0,0,0.45)",
  focus: `0 0 0 3px ${colors.accent}33`,
} as const;

export const font = {
  size: {
    xs: 10.5,
    sm: 11.5,
    md: 13,
    lg: 15,
    xl: 18,
    xxl: 24,
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
} as const;

export const z = {
  canvas: 0,
  panel: 10,
  sticky: 20,
  overlay: 900,
  modal: 1000,
  toast: 1100,
} as const;

// Semantic status colour keyed by the workflow/version status strings the API
// already returns. Centralises the ad-hoc ternaries scattered across screens.
export type StatusKey = "draft" | "published" | "archived" | "invalid";

export const statusColor: Record<StatusKey, string> = {
  draft: colors.warning,
  published: colors.success,
  archived: colors.textDim,
  invalid: colors.danger,
};

// Map an API status string (e.g. "PUBLISHED", "DRAFT") to a StatusKey.
export function statusKey(status: string): StatusKey {
  switch (status.toUpperCase()) {
    case "PUBLISHED":
      return "published";
    case "ARCHIVED":
      return "archived";
    case "INVALID":
      return "invalid";
    default:
      return "draft";
  }
}

// Semantic colour per workflow state. Active states are blue-ish, positive
// terminals green, negative terminals red/grey, review amber.
export const stateColor: Record<InstanceState, string> = {
  ENROLLED: "#6e7681", // neutral — just entered
  OUTREACH_SENT: "#58a6ff", // active blue
  AWAITING_REPLY: "#388bfd", // active blue
  FOLLOWED_UP: "#a371f7", // purple — re-engagement
  REPLY_RECEIVED: "#56d364", // a reply came in
  NEGOTIATING: "#d29922", // amber — in play
  ACCEPTED: "#3fb950", // success
  REJECTED: "#f85149", // failure
  OPTED_OUT: "#db6d28", // opted out
  NO_RESPONSE: "#6e7681", // timed out
  MANUAL_REVIEW: "#e3b341", // needs a human
};

export const stateLabel: Record<InstanceState, string> = {
  ENROLLED: "Enrolled",
  OUTREACH_SENT: "Outreach Sent",
  AWAITING_REPLY: "Awaiting Reply",
  FOLLOWED_UP: "Followed Up",
  REPLY_RECEIVED: "Reply Received",
  NEGOTIATING: "Negotiating",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  OPTED_OUT: "Opted Out",
  NO_RESPONSE: "No Response",
  MANUAL_REVIEW: "Manual Review",
};

// Plain-English "what does this state mean" for non-engineers (node tooltips).
export const stateDescription: Record<InstanceState, string> = {
  ENROLLED: "Imported into the campaign; outreach not yet sent.",
  OUTREACH_SENT: "First email sent; waiting to mark as awaiting reply.",
  AWAITING_REPLY: "Outreach delivered; waiting on the creator to respond.",
  FOLLOWED_UP: "A follow-up nudge was sent; waiting on a response.",
  REPLY_RECEIVED: "A reply arrived and is being classified by the AI.",
  NEGOTIATING: "In an active back-and-forth on terms with the AI agent.",
  ACCEPTED: "Deal accepted — terminal success state.",
  REJECTED: "Creator declined — terminal state.",
  OPTED_OUT: "Creator asked to stop being contacted — terminal state.",
  NO_RESPONSE: "All follow-ups exhausted with no reply — terminal state.",
  MANUAL_REVIEW: "Needs a human: low-confidence reply or escalated negotiation.",
};

export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return `${formatDuration(secs)} ago`;
}

// Map a transition source string to a short, human label + colour.
export const sourceMeta: Record<string, { label: string; color: string }> = {
  scheduler: { label: "Scheduler", color: "#a371f7" },
  "node-execution-worker": { label: "Worker", color: "#58a6ff" },
  "inbound-email-worker": { label: "Inbound Worker", color: "#56d364" },
  "inbound-email": { label: "Inbound Email", color: "#56d364" },
  "classification-agent": { label: "Classifier AI", color: "#d29922" },
  "negotiation-agent": { label: "Negotiator AI", color: "#e3b341" },
  manual: { label: "Manual", color: "#9198a1" },
  system: { label: "System", color: "#6e7681" },
};

export function sourceInfo(source: string | null): { label: string; color: string } {
  if (!source) return { label: "—", color: colors.textDim };
  return sourceMeta[source] ?? { label: source, color: colors.textMuted };
}
