// ---------------------------------------------------------------------------
// Design tokens (Phase 9, Part 12)
// ---------------------------------------------------------------------------
// Operational visibility over marketing polish. A restrained near-black
// neutral palette with a single indigo accent, generous whitespace, and
// monospace for ids. Think: Linear/Vercel-grade runtime inspector, not a
// landing page.

import type { InstanceState } from "./api/types";

export const colors = {
  bg: "#0b0c0f",
  panel: "#131418",
  panelAlt: "#1b1c22",
  border: "#22242c",
  borderStrong: "#32343e",
  text: "#f2f3f5",
  textMuted: "#9da3ae",
  textDim: "#5f6470",
  accent: "#6e7cf5",
  accentDim: "#5a68e8",
  warning: "#d9a03f",
  danger: "#f2555f",
  success: "#3ecf8e",
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
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

// Layered, soft elevation — depth comes from shadow + surface tint, not from
// heavier borders.
export const shadow = {
  sm: "0 1px 2px rgba(0,0,0,0.4)",
  md: "0 2px 6px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.28)",
  lg: "0 4px 16px rgba(0,0,0,0.4), 0 24px 64px rgba(0,0,0,0.5)",
  focus: `0 0 0 3px ${"#6e7cf5"}40`,
} as const;

export const font = {
  size: {
    xs: 11,
    sm: 12,
    md: 13,
    lg: 15,
    xl: 18,
    xxl: 26,
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

// Semantic colour per workflow state. Active states are indigo, positive
// terminals green, negative terminals red/grey, review amber.
export const stateColor: Record<InstanceState, string> = {
  ENROLLED: "#6a7080", // neutral — just entered
  OUTREACH_SENT: "#8b96f8", // active indigo (light)
  AWAITING_REPLY: "#6e7cf5", // active indigo
  FOLLOWED_UP: "#a78bfa", // purple — re-engagement
  REPLY_RECEIVED: "#57d9a3", // a reply came in
  NEGOTIATING: "#d9a03f", // amber — in play
  ACCEPTED: "#3ecf8e", // success — negotiation agreed
  REWARD_PENDING: "#6e7cf5", // active indigo — awaiting creator confirmation
  REWARD_CONFIRMED: "#2eb67d", // deep green — agreement confirmed
  PAYMENT_PENDING: "#6e7cf5", // active indigo — awaiting payout form submission
  PAYMENT_RECEIVED: "#27a06c", // deep green — payout info received
  CONTENT_BRIEF_SENT: "#34b378", // green — campaign brief sent (terminal success)
  REJECTED: "#f2555f", // failure
  OPTED_OUT: "#e0784a", // opted out
  NO_RESPONSE: "#6a7080", // timed out
  MANUAL_REVIEW: "#e5b454", // needs a human
};

export const stateLabel: Record<InstanceState, string> = {
  ENROLLED: "Enrolled",
  OUTREACH_SENT: "Outreach Sent",
  AWAITING_REPLY: "Awaiting Reply",
  FOLLOWED_UP: "Followed Up",
  REPLY_RECEIVED: "Reply Received",
  NEGOTIATING: "Negotiating",
  ACCEPTED: "Accepted",
  REWARD_PENDING: "Awaiting Confirmation",
  REWARD_CONFIRMED: "Confirmed",
  PAYMENT_PENDING: "Awaiting Payout Info",
  PAYMENT_RECEIVED: "Payout Info Received",
  CONTENT_BRIEF_SENT: "Brief Sent",
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
  ACCEPTED: "Negotiation agreed — finalizing the agreement in Reward Setup.",
  REWARD_PENDING: "Agreement email sent; waiting on the creator to confirm.",
  REWARD_CONFIRMED: "Creator confirmed — collecting payout info in Payment Info.",
  PAYMENT_PENDING: "Payout form emailed; waiting on the creator to submit it.",
  PAYMENT_RECEIVED: "Creator submitted payout info — sending the campaign brief.",
  CONTENT_BRIEF_SENT: "Campaign brief emailed to the creator — terminal success state.",
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
  scheduler: { label: "Scheduler", color: "#a78bfa" },
  "node-execution-worker": { label: "Worker", color: "#8b96f8" },
  "inbound-email-worker": { label: "Inbound Worker", color: "#57d9a3" },
  "inbound-email": { label: "Inbound Email", color: "#57d9a3" },
  "classification-agent": { label: "Classifier AI", color: "#d9a03f" },
  "negotiation-agent": { label: "Negotiator AI", color: "#e5b454" },
  "payment-form": { label: "Payout Form", color: "#3ecf8e" },
  manual: { label: "Manual", color: "#9da3ae" },
  system: { label: "System", color: "#6a7080" },
};

export function sourceInfo(source: string | null): { label: string; color: string } {
  if (!source) return { label: "—", color: colors.textDim };
  return sourceMeta[source] ?? { label: source, color: colors.textMuted };
}
