// ---------------------------------------------------------------------------
// Builder API types (Phase 10) — mirrors server DTOs
// ---------------------------------------------------------------------------

export type WorkflowStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type TemplateKey = "affiliate" | "hybrid" | "fixed_fee";

// ---------------------------------------------------------------------------
// Node types + configs
// ---------------------------------------------------------------------------

export type NodeType =
  | "IMPORT_CREATOR_LIST"
  | "INITIAL_OUTREACH"
  | "FOLLOW_UP"
  | "REPLY_DETECTION"
  | "NEGOTIATION"
  | "REWARD_SETUP"
  | "PAYMENT_INFO"
  | "CONTENT_BRIEF"
  | "END";

export interface InitialOutreachConfig {
  subjectTemplate: string;
  bodyTemplate: string;
  delaySeconds: number;
}

export interface FollowUpConfig {
  intervals: number[];
  intervalUnit: "seconds" | "minutes" | "hours" | "days";
  maxCount: number;
  bodyTemplate: string;
  // NOTE: no stopOnReply field. Follow-ups ALWAYS stop when the creator replies
  // — that's hardcoded in the runtime (an inbound reply clears the follow-up
  // dueAt), never read from config. The old toggle was a no-op and was removed.
}

// Reply Detection has NO configurable fields. The classifier's low-confidence
// threshold is a fixed engine constant (0.50) and low-confidence replies always
// route to Manual Review — neither was ever read from node config. The former
// lowConfidenceThreshold / manualReviewOnLowConfidence fields were dead and were
// removed; the type is kept (empty) so the NodeConfig union and node identity
// stay stable.
export type ReplyDetectionConfig = Record<string, never>;

export interface NegotiationConfig {
  /**
   * "Preferred Budget" in the UI (V1 #1). The rate the brand would ideally
   * close at — the agent opens here and concedes up only as needed. Field name
   * kept as minBudget for config compatibility; only the human-facing label
   * changed.
   */
  minBudget: number;
  /**
   * "Maximum Budget" in the UI (V1 #1). Absolute ceiling — the agent never
   * offers above it. Every dollar above the preferred budget is a worse
   * outcome, so $260 in a $200–500 band beats $490. Field name kept as
   * maxBudget for config compatibility.
   */
  maxBudget: number;
  maxRounds: number;
  // NOTE: no approvalMode field. The engine always auto-accepts within budget;
  // the old "manual — human approves final terms" option was never read, so it
  // promised a human gate that didn't exist. The control + field were removed.
  commissionRate?: number;
  /**
   * Phase C (#12): merchant tolerance ABOVE the max budget, as a percent. 0 (or
   * omitted) = zero tolerance — the agent escalates the moment a creator's ask
   * exceeds the max. When > 0, an ask up to maxBudget*(1 + tolerance/100) is
   * countered/closed AT the max (never above it) instead of escalated; anything
   * higher still escalates to a human. V1 applies only to the fixed fee.
   */
  overCeilingTolerance?: number;
}

// Reward Setup finalizes the agreement after a successful negotiation. The final
// fee is the rate the negotiation closed on (resolved at runtime); commission and
// deliverables are stamped from the campaign / negotiation config.
export interface RewardSetupConfig {
  commissionRate?: number;
  deliverables?: string;
  timeline?: string;
}

// Payment Info collects the creator's payout details via a hosted form after
// they confirm the agreement. It needs no builder config today (the form link +
// email are derived at runtime); the interface exists so the node type is fully
// modelled and future payout options can be added without a type change.
export interface PaymentInfoConfig {
  [key: string]: unknown;
}

// Content Brief is the merged post-negotiation node: on ACCEPTED it sends ONE
// email with the finalized offer (fee/commission/deliverables/timeline), a secure
// payout-form link, and the campaign brief (PDF + optional notes), then waits for
// the creator to submit the form. The brand configures the brief fields in the
// builder before launch; the offer fields are stamped from the campaign /
// negotiation config at save/publish (like the legacy Reward Setup node). Only
// the uploaded PDF's stored reference is persisted — never the bytes; the
// original filename is kept for display + the attachment.
//
// NOTE: there is no manual referral-link field. Attribution mints a UNIQUE
// per-creator tracking link (server: partnership.ts) delivered in the welcome
// email; a static brand-typed link here would be redundant and track nothing.
export interface ContentBriefConfig {
  /** Stored reference for the uploaded Campaign Brief PDF (required to launch). */
  briefFileRef?: string;
  /** Original filename of the uploaded PDF, for display + the email attachment. */
  briefFileName?: string;
  /** Optional brand notes shown to the creator in the email body. */
  creatorNotes?: string;
  /** Commission %, stamped from the negotiation node (for display in the builder). */
  commissionRate?: number;
  /** Deliverables scope, stamped from the campaign. */
  deliverables?: string;
  /** Go-live timeline, stamped from the campaign. */
  timeline?: string;
}

export type NodeConfig =
  | InitialOutreachConfig
  | FollowUpConfig
  | ReplyDetectionConfig
  | NegotiationConfig
  | RewardSetupConfig
  | PaymentInfoConfig
  | ContentBriefConfig
  | Record<string, unknown>;

export interface DraftNode {
  id: string;
  type: NodeType;
  order: number;
  config: NodeConfig;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

export interface CampaignListItem {
  id: string;
  name: string;
  brand: string;
  objective: string | null;
  notes: string | null;
  notifyEmail: string | null;
  brandDescription: string | null;
  deliverables: string | null;
  timeline: string | null;
  /** Free-text product/sample reward blurb woven into the email copy. */
  rewardDescription: string | null;
  /** When true, the payment form also collects a shipping address. */
  shipsPhysicalProduct: boolean;
  createdAt: string;
  updatedAt: string;
  workflowCount: number;
}

export interface CampaignWorkflowItem {
  id: string;
  name: string;
  status: WorkflowStatus;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignDetail {
  id: string;
  name: string;
  brand: string;
  objective: string | null;
  notes: string | null;
  notifyEmail: string | null;
  brandDescription: string | null;
  deliverables: string | null;
  timeline: string | null;
  /** Free-text product/sample reward blurb woven into the email copy. */
  rewardDescription: string | null;
  /** When true, the payment form also collects a shipping address. */
  shipsPhysicalProduct: boolean;
  createdAt: string;
  updatedAt: string;
  workflows: CampaignWorkflowItem[];
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export interface WorkflowCampaign {
  id: string;
  name: string;
  brand: string;
}

export interface WorkflowLatestVersion {
  id: string;
  version: number;
  publishedAt: string;
}

export interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  campaignId: string | null;
  campaign: WorkflowCampaign | null;
  draftNodes: DraftNode[];
  latestVersion: WorkflowLatestVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVersion {
  id: string;
  version: number;
  publishedAt: string;
  instanceCount: number;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RecentExecutionEvent {
  id: string;
  instanceId: string;
  creatorName: string;
  creatorHandle: string | null;
  payload: Record<string, unknown> | null;
  occurredAt: string;
}

export interface WorkflowExecutionSummary {
  versionId: string | null;
  version: number | null;
  totalInstances: number;
  stateCounts: Record<string, number>;
  recentEvents: RecentExecutionEvent[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Creator (enrollment)
// ---------------------------------------------------------------------------

export interface CreatorItem {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  platform: string | null;
  niche: string | null;
}

/** One parsed CSV row sent to POST /creators/import. `email` is required. */
export interface CreatorImportRow {
  email: string;
  name?: string;
  handle?: string;
  platform?: string;
  niche?: string;
  /** Any CSV columns that don't map to a known field, preserved as JSON. */
  metadata?: Record<string, string>;
}

export interface CreatorImportResponse {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
  /** Upserted creators, for immediate pre-selection in the enroll list. */
  creators: CreatorItem[];
}

// ---------------------------------------------------------------------------
// Publish / Enroll / Launch responses
// ---------------------------------------------------------------------------

export interface PublishResponse {
  versionId: string;
  version: number;
  publishedAt: string;
  notes: string | null;
}

export interface EnrollResponse {
  enrolled: number;
  skipped: number;
  versionId: string;
}

export interface LaunchResponse {
  launched: number;
  versionId: string;
  totalInstances: number;
}

/** One structured validation issue as returned by the server. Mirrors the
 * frontend ValidationIssue shape (web/src/workflow/graphValidation.ts) so
 * publish/validate errors can stay tied to their node for click-to-focus. */
export interface ServerValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  severity: "error" | "warning";
}

export interface ValidationResponse {
  valid: boolean;
  errors: string[];
  /** Structured issues (added Phase 17); `errors` kept for back-compat. */
  issues?: ServerValidationIssue[];
}

// ---------------------------------------------------------------------------
// Manual Queue (Phase 11)
// ---------------------------------------------------------------------------

export type BrandNotificationStatus = "SENT" | "FAILED" | "SKIPPED";

export interface ManualQueueNotification {
  status: BrandNotificationStatus;
  recipient: string;
  error: string | null;
  sentAt: string;
}

export interface ManualQueueItem {
  instanceId: string;
  creatorId: string;
  creatorName: string;
  creatorEmail: string;
  creatorHandle: string | null;
  platform: string | null;
  niche: string | null;
  negotiationRound: number;
  reason: string;
  reasonLabel: string;
  escalatedAt: string | null;
  updatedAt: string;
  /** E6: deep-link to the email thread holding the full conversation, or null when
   *  the provider can't build one (mock / unconfigured) or the instance hasn't
   *  threaded yet. The UI shows a link only when present. */
  threadUrl: string | null;
  /** Content-links escalation: the URLs the creator submitted (empty for every
   *  other escalation reason). Rendered as an openable list in the queue row. */
  submittedUrls: string[];
  /** Convenience count of submittedUrls (0 for non-content-links escalations). */
  linkCount: number;
  notification: ManualQueueNotification | null;
}

export interface ManualQueueResponse {
  workflowId: string;
  versionId?: string;
  version?: number;
  items: ManualQueueItem[];
  total: number;
  generatedAt: string;
}

export interface NotifyResult {
  instanceId: string;
  reason: string;
  status: "SENT" | "FAILED" | "SKIPPED" | "ALREADY_NOTIFIED";
  recipient: string | null;
}
