import type { Campaign } from "@prisma/client";

// ---------------------------------------------------------------------------
// Campaign → node-config brand-context fallback (H5)
// ---------------------------------------------------------------------------
// Brand context (senderName / brandName / brandDescription / deliverables /
// timeline / rewardDescription / shipsPhysicalProduct) is normally STAMPED into
// every node's config when a campaign is instantiated through the UI. But
// imported/legacy workflows can reach the LLM with those fields MISSING from the
// node config — and then the agent falls back to "Pluvus Partnerships" /
// "a brand partnership", signing blind even though the campaign row HAS the data.
//
// mergeCampaignFallback overlays the campaign's brand fields onto a node config
// ONLY for keys the config doesn't already carry. Node config always WINS (it is
// the stamped, workflow-specific value); the campaign only fills genuine gaps.
// A null/absent campaign (seeded/legacy workflows) is a no-op.

// The brand-context keys the LLM reads, mapped from Campaign columns.
const BRAND_KEYS = [
  "senderName",
  "brandName",
  "brandDescription",
  "deliverables",
  "timeline",
  "rewardDescription",
  "shipsPhysicalProduct",
] as const;

function campaignValueFor(campaign: Campaign, key: (typeof BRAND_KEYS)[number]): unknown {
  switch (key) {
    // The campaign's brand name is the sender/brand identity for the emails.
    case "senderName":
    case "brandName":
      return campaign.brand || undefined;
    case "brandDescription":
      return campaign.brandDescription ?? undefined;
    case "deliverables":
      return campaign.deliverables ?? undefined;
    case "timeline":
      return campaign.timeline ?? undefined;
    case "rewardDescription":
      return campaign.rewardDescription ?? undefined;
    case "shipsPhysicalProduct":
      return campaign.shipsPhysicalProduct;
  }
}

// True when a config already carries a usable value for a key (non-empty string,
// or a boolean/number). Empty strings count as "missing" so a blank stamp still
// falls back to the campaign.
function configHasValue(config: Record<string, unknown>, key: string): boolean {
  const v = config[key];
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true; // boolean / number present
}

/**
 * Return a shallow copy of `config` with campaign brand fields filled in for any
 * key the config is missing. Node config always wins; the campaign only fills
 * gaps. A null/undefined campaign returns the config unchanged (shallow copy).
 */
export function mergeCampaignFallback(
  config: Record<string, unknown>,
  campaign: Campaign | null | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...config };
  if (!campaign) return merged;

  for (const key of BRAND_KEYS) {
    if (configHasValue(merged, key)) continue; // node config wins
    const value = campaignValueFor(campaign, key);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * L4: resolve the brand name to put in a creator-facing email, trying node
 * config first, then the parent campaign. Returns undefined when neither has a
 * real brand name — the caller must then fail loud (route to MANUAL_REVIEW)
 * rather than email a creator the literal filler "your brand". restampBrand
 * normally always sets brandName, so undefined only happens for a genuinely
 * mis-stamped / orphaned instance that a human should fix.
 */
export function resolveBrandName(
  config: Record<string, unknown>,
  campaign: Campaign | null | undefined,
): string | undefined {
  const fromConfig = config["brandName"] ?? config["senderName"];
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig;
  }
  if (campaign && campaign.brand && campaign.brand.trim().length > 0) {
    return campaign.brand;
  }
  return undefined;
}
