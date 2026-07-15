import { z } from "zod";

// ---------------------------------------------------------------------------
// Pure logic extracted from attribution.ts for unit-testability.
// ---------------------------------------------------------------------------

export const conversionBodySchema = z
  .object({
    referralCode: z.string().min(1),
    externalId: z.string().min(1),
    amountCents: z.number().int().min(0).optional(),
    amount: z.number().min(0).optional(),
    currency: z.string().optional(),
    customerEmail: z.string().email().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    (d) => d.amountCents !== undefined || d.amount !== undefined,
    { message: "One of amountCents or amount is required" },
  )
  .refine(
    (d) => !(d.amountCents !== undefined && d.amount !== undefined),
    { message: "Provide amountCents or amount, not both" },
  );

export type ConversionBody = z.infer<typeof conversionBodySchema>;

/** Resolve integer cents from the validated body. */
export function resolveValueCents(body: ConversionBody): number {
  return body.amountCents !== undefined
    ? body.amountCents
    : Math.round((body.amount ?? 0) * 100);
}

/** Compute commission cents from valueCents and commissionRate (percent). */
export function computeCommissionCents(
  valueCents: number,
  commissionRate: number | null | undefined,
): number {
  if (!commissionRate) return 0;
  return Math.round((valueCents * commissionRate) / 100);
}
