// ---------------------------------------------------------------------------
// Classification adapter — shared types
// ---------------------------------------------------------------------------

export type ReplyIntentValue =
  | "POSITIVE"
  | "NEGATIVE"
  | "QUESTION"
  | "OPT_OUT"
  | "UNKNOWN";

export interface ClassificationRequest {
  message: string;
}

export interface ClassificationResponse {
  intent: ReplyIntentValue;
  confidence: number;
  reasoning?: string;
}
