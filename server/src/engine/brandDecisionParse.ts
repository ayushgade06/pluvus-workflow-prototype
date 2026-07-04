// ---------------------------------------------------------------------------
// Brand-decision reply parsing (MANUAL_ESCALATION_RESOLUTION.md §2.4)
// ---------------------------------------------------------------------------
// The escalation email tells the brand to reply with an explicit cue — APPROVE /
// REJECT / COUNTER <number> / HANDOFF. We parse the reply DETERMINISTICALLY
// first (a matched token wins immediately, no AI hop); only when no token
// matches do we fall back to the AI classifier. This module owns the
// deterministic layer (a pure function) and the shape both layers return.
//
// Pipeline (orchestrated by the executor, not here):
//   1. scanBrandDecisionTokens(body)   → APPROVE | REJECT | COUNTER<n> | HANDOFF | null
//   2. null → agent.classifyBrandDecision(body) (AI fallback; degrades to AMBIGUOUS)
//   3. AMBIGUOUS → re-ask once, then dashboard (MANUAL_REVIEW)

/** The four business actions a brand can take on an escalation, plus the
 *  can't-tell bucket. Persisted verbatim on BrandDecision.decision. */
export type BrandDecisionAction = "APPROVE" | "REJECT" | "COUNTER" | "HANDOFF" | "AMBIGUOUS";

export interface BrandDecisionParse {
  decision: BrandDecisionAction;
  /** The counter amount when decision === "COUNTER". Undefined otherwise. */
  value?: number;
  /** Confidence in [0,1]. Deterministic token matches are 1. The AI fallback
   *  supplies its own; below 0.50 the caller treats the result as AMBIGUOUS. */
  confidence: number;
  /** How the decision was reached — for the audit timeline. */
  source: "token" | "agent";
}

// The deterministic token scanners, in priority order. HANDOFF and REJECT are
// checked before APPROVE so a reply like "no, hand this to a human" resolves to
// HANDOFF rather than tripping a stray APPROVE synonym. COUNTER requires a
// number, so it is matched first when a number is present.
//
// Patterns mirror the cues the escalation email instructs the brand to use
// (spec §2.4), tolerant of natural phrasing around them.
const COUNTER_RE = /\bCOUNTER\b[^0-9$]*\$?\s*([\d,]+(?:\.\d+)?)/i;
const HANDOFF_RE = /\b(HANDOFF|HAND\s*OFF|HUMAN|CALL\s*ME|DASHBOARD|TAKE\s*OVER)\b/i;
const REJECT_RE = /\b(REJECT|DECLINE|PASS|NO\s*DEAL|WALK\s*AWAY)\b/i;
const APPROVE_RE = /\b(APPROVE|APPROVED|ACCEPT|ACCEPTED|AGREE|AGREED|YES|OK|OKAY|GO\s*AHEAD|SOUNDS?\s*GOOD)\b/i;

/** Parse a dollar-ish amount ("$1,200", "1200.50", "480") to a finite number,
 *  or undefined. Kept local so COUNTER extraction never throws on odd input. */
function parseAmount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Deterministic token scan of a brand reply body. Returns a resolved parse when
 * a cue matches (confidence 1, source "token"), or null when no cue is present
 * (the caller then runs the AI fallback).
 *
 * A COUNTER cue WITHOUT a readable number does NOT resolve to COUNTER — we can't
 * act on "counter" with no figure. It falls through to null so the AI fallback /
 * re-ask can clarify the intended number, rather than silently dropping it.
 *
 * Pure and side-effect free: safe to call on the raw or the stripped reply.
 */
export function scanBrandDecisionTokens(body: string): BrandDecisionParse | null {
  const text = body ?? "";

  // COUNTER first, but only when it carries a usable number.
  const counter = text.match(COUNTER_RE);
  if (counter) {
    const value = parseAmount(counter[1]);
    if (value !== undefined) {
      return { decision: "COUNTER", value, confidence: 1, source: "token" };
    }
    // "counter" with no parseable amount → fall through to the AI fallback.
  }

  // HANDOFF and REJECT before APPROVE: an explicit handoff/decline must win over
  // a stray affirmative word elsewhere in the message.
  if (HANDOFF_RE.test(text)) {
    return { decision: "HANDOFF", confidence: 1, source: "token" };
  }
  if (REJECT_RE.test(text)) {
    return { decision: "REJECT", confidence: 1, source: "token" };
  }
  if (APPROVE_RE.test(text)) {
    return { decision: "APPROVE", confidence: 1, source: "token" };
  }

  return null;
}

/** Confidence floor for the AI fallback: at or above this the agent's decision
 *  is trusted; below it the reply is treated as AMBIGUOUS (spec §2.4). */
export const BRAND_DECISION_CONFIDENCE_THRESHOLD = 0.5;
