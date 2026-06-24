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
