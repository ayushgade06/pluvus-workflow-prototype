// ---------------------------------------------------------------------------
// Closed-deal compensation formatting (PLU-70)
// ---------------------------------------------------------------------------
// Sibling of dealDescription.ts, which describes the deal STRUCTURE before any
// numbers exist ("a hybrid partnership — a fixed fee PLUS commission"). This one
// renders the numbers a deal actually CLOSED on, for the operator surfaces:
// the deal-finalization email and the Manual Queue row.
//
// Lives in the engine rather than in either caller because both need it and
// neither owns it. Pure and dependency-free so it is trivially unit-testable.

/**
 * One-line agreed compensation, e.g.:
 *   "$750 fixed fee + 30% commission"
 *   "30% commission"
 *   "$750 fixed fee"
 *   "—"                            (neither recorded)
 *
 * A null/absent fee is normal, not an error: commission-only campaigns close
 * without one. A zero or negative commission is treated as "no commission"
 * rather than rendered as "0% commission", which would read as a real term.
 */
export function formatAgreedCompensation(
  fixedFee: number | null | undefined,
  commissionRate: number | null | undefined,
): string {
  const parts: string[] = [];
  if (typeof fixedFee === "number" && Number.isFinite(fixedFee) && fixedFee > 0) {
    parts.push(`$${formatAmount(fixedFee)} fixed fee`);
  }
  if (
    typeof commissionRate === "number" &&
    Number.isFinite(commissionRate) &&
    commissionRate > 0
  ) {
    parts.push(`${formatAmount(commissionRate)}% commission`);
  }
  return parts.length > 0 ? parts.join(" + ") : "—";
}

/** Trim a trailing ".0" so a whole number reads as "750", not "750.0". */
function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}
