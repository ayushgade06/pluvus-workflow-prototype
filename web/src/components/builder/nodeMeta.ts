// ---------------------------------------------------------------------------
// Node presentation metadata (Phase B) — single source of truth for how each
// node TYPE renders: label, icon, accent colour, one-line summary, config
// chips, validity hint, and the execution state it maps to.
//
// Pure presentation derived from the existing DraftNode.config shapes. No data
// is mutated and no config field names change — this only READS config.
// ---------------------------------------------------------------------------
import type { DraftNode, NodeType } from "../../api/builderTypes";
import { colors } from "../../theme";

export const NODE_LABEL: Record<NodeType, string> = {
  INITIAL_OUTREACH: "Initial Outreach",
  FOLLOW_UP: "Follow-Up",
  REPLY_DETECTION: "Reply Detection",
  NEGOTIATION: "Negotiation",
  END: "End",
  IMPORT_CREATOR_LIST: "Import Creators",
};

export const NODE_ICON: Record<NodeType, string> = {
  INITIAL_OUTREACH: "✉",
  FOLLOW_UP: "🔔",
  REPLY_DETECTION: "🤖",
  NEGOTIATION: "💬",
  END: "✓",
  IMPORT_CREATOR_LIST: "👥",
};

export const NODE_COLOR: Record<NodeType, string> = {
  INITIAL_OUTREACH: "#388bfd",
  FOLLOW_UP: "#a371f7",
  REPLY_DETECTION: "#56d364",
  NEGOTIATION: "#d29922",
  END: "#3fb950",
  IMPORT_CREATOR_LIST: "#6e7681",
};

// Plain-English description of what each node does (node tooltips / a11y).
export const NODE_DESCRIPTION: Record<NodeType, string> = {
  IMPORT_CREATOR_LIST: "Entry point — creators enrolled into the campaign land here.",
  INITIAL_OUTREACH: "The first email sent to each creator.",
  FOLLOW_UP: "Automated follow-up nudges sent at set intervals until a reply.",
  REPLY_DETECTION: "AI classifies each reply (positive, negative, question, opt-out).",
  NEGOTIATION: "AI negotiates terms within your budget, escalating when needed.",
  END: "Terminal node — marks the creator's journey complete.",
};

export function nodeLabel(type: string): string {
  return NODE_LABEL[type as NodeType] ?? type;
}
export function nodeIcon(type: string): string {
  return NODE_ICON[type as NodeType] ?? "◆";
}
export function nodeColor(type: string): string {
  return NODE_COLOR[type as NodeType] ?? colors.textMuted;
}
export function nodeDescription(type: string): string {
  return NODE_DESCRIPTION[type as NodeType] ?? "";
}

// One-line human summary (mirrors the prior configSummary in BuilderNode).
export function configSummary(node: DraftNode): string {
  const cfg = node.config as Record<string, unknown>;
  switch (node.type) {
    case "INITIAL_OUTREACH": {
      const subj = cfg["subjectTemplate"] as string | undefined;
      return subj ? `“${subj.slice(0, 40)}${subj.length > 40 ? "…" : ""}”` : "No subject set";
    }
    case "FOLLOW_UP": {
      const count = cfg["maxCount"] as number | undefined;
      const unit = cfg["intervalUnit"] as string | undefined;
      const intervals = cfg["intervals"] as number[] | undefined;
      if (count && intervals) {
        return `${count} follow-up${count !== 1 ? "s" : ""} · every ${intervals.join(", ")} ${unit ?? "days"}`;
      }
      return "Not configured";
    }
    case "REPLY_DETECTION": {
      const threshold = cfg["lowConfidenceThreshold"] as number | undefined;
      return threshold !== undefined
        ? `Confidence threshold ${Math.round(threshold * 100)}%`
        : "Not configured";
    }
    case "NEGOTIATION": {
      const min = cfg["minBudget"] as number | undefined;
      const max = cfg["maxBudget"] as number | undefined;
      const rounds = cfg["maxRounds"] as number | undefined;
      if (min !== undefined && max !== undefined) {
        return `$${min}–$${max} budget · ${rounds ?? "?"} rounds`;
      }
      return "Not configured";
    }
    case "END":
      return "Terminal node";
    case "IMPORT_CREATOR_LIST":
      return "Workflow entry point";
    default:
      return "—";
  }
}

// Compact config "chips" surfaced in the node body. Derived purely from config.
export function configChips(node: DraftNode): string[] {
  const cfg = node.config as Record<string, unknown>;
  switch (node.type) {
    case "INITIAL_OUTREACH": {
      const chips: string[] = [];
      const delay = cfg["delaySeconds"] as number | undefined;
      if (cfg["subjectTemplate"]) chips.push("subject");
      if (cfg["bodyTemplate"]) chips.push("body");
      if (delay !== undefined) chips.push(delay === 0 ? "no delay" : `delay ${delay}s`);
      return chips;
    }
    case "FOLLOW_UP": {
      const chips: string[] = [];
      const max = cfg["maxCount"] as number | undefined;
      const unit = cfg["intervalUnit"] as string | undefined;
      if (max !== undefined) chips.push(`max ${max}`);
      if (unit) chips.push(unit);
      if (cfg["stopOnReply"]) chips.push("stop on reply");
      return chips;
    }
    case "REPLY_DETECTION": {
      const chips: string[] = [];
      const t = cfg["lowConfidenceThreshold"] as number | undefined;
      if (t !== undefined) chips.push(`≥ ${Math.round(t * 100)}%`);
      if (cfg["manualReviewOnLowConfidence"]) chips.push("manual review");
      return chips;
    }
    case "NEGOTIATION": {
      const chips: string[] = [];
      const rounds = cfg["maxRounds"] as number | undefined;
      const mode = cfg["approvalMode"] as string | undefined;
      const commission = cfg["commissionRate"] as number | undefined;
      if (rounds !== undefined) chips.push(`${rounds} rounds`);
      if (mode) chips.push(mode === "auto" ? "auto-approve" : "manual approve");
      if (commission && commission > 0) chips.push(`${commission}% commission`);
      return chips;
    }
    default:
      return [];
  }
}

// Returns a warning string when a node is missing required configuration, else
// null. Mirrors the "Not configured" signals already surfaced in the summary.
export function nodeWarning(node: DraftNode): string | null {
  const cfg = node.config as Record<string, unknown>;
  switch (node.type) {
    case "INITIAL_OUTREACH":
      if (!cfg["subjectTemplate"]) return "Missing subject line";
      if (!cfg["bodyTemplate"]) return "Missing email body";
      return null;
    case "FOLLOW_UP":
      if (!cfg["bodyTemplate"]) return "Missing follow-up body";
      if (!Array.isArray(cfg["intervals"]) || (cfg["intervals"] as unknown[]).length === 0)
        return "No intervals set";
      return null;
    case "NEGOTIATION": {
      const min = cfg["minBudget"] as number | undefined;
      const max = cfg["maxBudget"] as number | undefined;
      if (min === undefined || max === undefined) return "Budget not set";
      if (max < min) return "Max budget below min";
      return null;
    }
    default:
      return null;
  }
}

// Execution state a node TYPE corresponds to (for live counts).
const TYPE_TO_STATE: Record<string, string> = {
  INITIAL_OUTREACH: "OUTREACH_SENT",
  FOLLOW_UP: "FOLLOWED_UP",
  REPLY_DETECTION: "REPLY_RECEIVED",
  NEGOTIATION: "NEGOTIATING",
  END: "ACCEPTED",
};

export function nodeTypeToState(type: string): string | null {
  return TYPE_TO_STATE[type] ?? null;
}
