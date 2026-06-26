// ---------------------------------------------------------------------------
// Deal-structure description for outreach copy
// ---------------------------------------------------------------------------
// The first email should explain WHAT KIND of deal this is — fixed fee,
// commission, or both — instead of vague filler. We derive a short, number-free
// sentence from the NEGOTIATION node's config so the draft model states the real
// offer and never has to invent terms.
//
// Deal type is inferred from the config the Workflow Builder templates produce:
//   - commission present AND a fixed-fee budget  -> hybrid  (fee + commission)
//   - commission present, no/zero fixed budget   -> affiliate (commission only)
//   - a fixed-fee budget, no commission          -> fixed fee
// No dollar figures are included — the band/rate is negotiated later, and the
// output guard must never see floor/ceiling here.

export function describeDeal(negotiationConfig: Record<string, unknown> | undefined): string | undefined {
  if (!negotiationConfig) return undefined;

  const commission =
    typeof negotiationConfig["commissionRate"] === "number" && negotiationConfig["commissionRate"] > 0
      ? (negotiationConfig["commissionRate"] as number)
      : undefined;

  // A "fixed fee" exists when the campaign carries a budget band at all
  // (minBudget/maxBudget or termFloor/termCeiling with any positive number).
  const hasFixedFee =
    isPositive(negotiationConfig["maxBudget"]) ||
    isPositive(negotiationConfig["minBudget"]) ||
    isPositive(rateOf(negotiationConfig["termCeiling"])) ||
    isPositive(rateOf(negotiationConfig["termFloor"]));

  if (commission !== undefined && hasFixedFee) {
    return (
      `a hybrid partnership — you receive a fixed fee for your content, ` +
      `PLUS a ${commission}% commission on the sales you drive. ` +
      `(The exact fee is discussed once you reply.)`
    );
  }
  if (commission !== undefined && !hasFixedFee) {
    return (
      `a performance-based affiliate partnership — you earn a ${commission}% ` +
      `commission on every sale you drive through your unique link. ` +
      `(No upfront fee.)`
    );
  }
  if (hasFixedFee) {
    return (
      `a fixed-fee collaboration — a flat fee for an agreed piece of content. ` +
      `(The exact fee is discussed once you reply.)`
    );
  }
  return undefined;
}

function isPositive(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function rateOf(term: unknown): number | undefined {
  if (term && typeof term === "object") {
    const r = (term as Record<string, unknown>)["rate"];
    if (typeof r === "number") return r;
  }
  return undefined;
}
