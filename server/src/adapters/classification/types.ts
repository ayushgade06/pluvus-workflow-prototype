// ---------------------------------------------------------------------------
// Classification adapter — shared types
// ---------------------------------------------------------------------------

export type ReplyIntentValue =
  | "POSITIVE"
  | "NEGATIVE"
  | "QUESTION"
  | "OPT_OUT"
  | "UNKNOWN"
  // Phase D (#3): the creator replied with no clear commitment either way
  // ("I'll think about it", "circle back next week") — schedules a soft follow-up.
  | "DEFERRED";

export interface ClassificationRequest {
  message: string;
}

export interface ClassificationResponse {
  intent: ReplyIntentValue;
  confidence: number;
  reasoning?: string;
  /**
   * Phase E (#5): an always-escalate topic reason code (e.g. legal_or_contract,
   * dispute_or_hostile, pricing_exception, undefined_terms,
   * usage_rights_or_licensing). When present, the reply must route to
   * MANUAL_REVIEW regardless of intent/confidence, and this is the escalation
   * reason recorded for the Manual Queue.
   */
  escalationReason?: string;
}
