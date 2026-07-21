// ---------------------------------------------------------------------------
// Creator field mapping (PLU-109)
// ---------------------------------------------------------------------------
// Maps one parsed row (a record keyed by ORIGINAL header) onto creator fields.
// Pure — no DB, no Express, no I/O — so the whole contract is unit-testable.
//
// Two shapes of file have to work through the same code path:
//
//   1. A hand-made list:   email,name,handle,platform,niche
//   2. A creator-discovery VENDOR EXPORT of ~80 columns, which has no `name`,
//      `platform`, `handle`, or `niche` column at all — it has per-network
//      blocks (instagram_*, tiktok_*, youtube_*, twitter_*, twitch_*).
//
// Shape 2 is why derivation exists. `platform` and `niche` are interpolated
// straight into the outreach prompt (agent/app/routes/negotiate.py:2411 —
// "Write a {purpose} email to the creator {name} on {platform} ({niche})"),
// and `niche` otherwise falls back to the generic "content creation". Imported
// flat, every creator from a vendor export would get bland, identical outreach.
//
// Header matching is fuzzy (lowercased, spaces/underscores/hyphens stripped) so
// `Email Address`, `email_address`, and `e-mail` all resolve identically, and
// column ORDER is irrelevant. Anything unrecognized is preserved verbatim under
// its original header in `metadata` — no column is ever silently dropped.

/** Normalize a header for alias lookup: lowercase, strip spaces/_/-. */
export function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_\-]/g, "").trim();
}

// ---------------------------------------------------------------------------
// Scalar aliases
// ---------------------------------------------------------------------------
// ORDER MATTERS: the first alias that resolves wins. `full_name` must beat
// `first_name`, so a vendor row with both yields "Ada Lovelace", not "Ada".

const SCALAR_ALIASES = {
  email: ["email", "emailaddress", "e-mail", "mail"],
  name: ["name", "fullname", "creatorname", "displayname", "firstname"],
  handle: ["handle", "username", "user", "@"],
  platform: ["platform", "channel", "network", "socialplatform"],
  niche: ["niche", "category", "vertical", "topic"],
  profileUrl: ["url", "link", "profileurl", "profile", "profilelink"],
  location: ["location", "country", "city", "region"],
  language: ["language", "lang"],
  bio: ["personalintro", "bio", "biography", "about", "description"],
} as const satisfies Record<string, readonly string[]>;

type ScalarField = keyof typeof SCALAR_ALIASES;

/** Every normalized header consumed by a scalar alias — used to build metadata. */
const SCALAR_ALIAS_KEYS = new Set<string>();
for (const aliases of Object.values(SCALAR_ALIASES)) {
  for (const a of aliases) SCALAR_ALIAS_KEYS.add(normalizeHeader(a));
}

// ---------------------------------------------------------------------------
// Per-network specs
// ---------------------------------------------------------------------------

/**
 * A column reference: one header, or several accepted spellings.
 *
 * `link` and `username` take alias lists because a hand-made list writes
 * `instagram_url` where the vendor export writes `instagram_link` — both are
 * obviously the same column, and rejecting one would be pedantry.
 */
type ColumnRef = string | readonly string[];

export interface NetworkSpec {
  /** Key used in socialLinks / platformStats JSON. */
  key: string;
  /** Human label written to Creator.platform (what the LLM prompt sees). */
  label: string;
  followers: ColumnRef;
  username?: ColumnRef;
  link?: ColumnRef;
  engagement?: ColumnRef;
  bio?: ColumnRef;
  avgLikes?: ColumnRef;
  avgComments?: ColumnRef;
  postCount?: ColumnRef;
  lastPostDate?: ColumnRef;
  postingFrequency?: ColumnRef;
}

export const NETWORKS: readonly NetworkSpec[] = [
  {
    key: "instagram",
    label: "Instagram",
    followers: "instagram_follower_count",
    username: ["instagram_username", "instagram_handle"],
    link: ["instagram_link", "instagram_url"],
    engagement: "instagram_engagement_percent",
    bio: "instagram_biography",
    avgLikes: "instagram_avg_likes",
    avgComments: "instagram_avg_comments",
    postCount: "instagram_media_count",
    lastPostDate: "instagram_most_recent_post_date",
    postingFrequency: "instagram_posting_frequency_recent_months",
  },
  {
    key: "tiktok",
    label: "TikTok",
    followers: "tiktok_follower_count",
    username: ["tiktok_username", "tiktok_handle"],
    link: ["tiktok_link", "tiktok_url"],
    engagement: "tiktok_engagement_percent",
    bio: "tiktok_biography",
    avgLikes: "tiktok_avg_likes",
    avgComments: "tiktok_comment_count_avg",
    postCount: "tiktok_video_count",
    lastPostDate: "tiktok_most_recent_post_date",
    postingFrequency: "tiktok_posting_frequency_recent_months",
  },
  {
    key: "youtube",
    label: "YouTube",
    followers: "youtube_subscriber_count",
    username: ["youtube_custom_url", "youtube_handle"],
    link: ["youtube_link", "youtube_url"],
    engagement: "youtube_engagement_percent",
    bio: "youtube_description",
    postCount: "youtube_video_count",
    lastPostDate: "youtube_last_upload_date",
    postingFrequency: "youtube_posting_frequency_recent_months",
  },
  {
    key: "twitter",
    label: "Twitter",
    followers: "twitter_follower_count",
    username: ["twitter_username", "x_username"],
    link: ["twitter_link", "twitter_url", "x_link", "x_url"],
    engagement: "twitter_engagement_percent",
    bio: "twitter_biography",
    avgLikes: "twitter_avg_likes",
    postCount: "twitter_tweets_count",
    lastPostDate: "twitter_most_recent_post_date",
  },
  {
    key: "twitch",
    label: "Twitch",
    followers: "twitch_total_followers",
    username: ["twitch_username", "twitch_displayName"],
    link: ["twitch_link", "twitch_url"],
  },
] as const;

/** Link-only networks: no audience metrics, but the URL is worth keeping. */
const LINK_ONLY_COLUMNS: Array<{ key: string; header: string }> = [
  { key: "patreon", header: "patreon_link" },
  { key: "onlyfans", header: "onlyfans_link" },
  { key: "linksInBio", header: "links_in_bio" },
  { key: "externalUrls", header: "external_urls" },
];

/** Campaign-qualification signals, kept scoped rather than in the generic blob. */
const BOOLEAN_SIGNALS = [
  "has_link_in_bio",
  "has_brand_deals",
  "promotes_affiliate_links",
  "has_merch",
] as const;

const TEXT_SIGNALS = ["type_of_profile", "gender"] as const;

const NUMERIC_SIGNALS = [
  "instagram_income_min",
  "instagram_income_max",
  "youtube_income_min",
  "youtube_income_max",
] as const;

/** Niche derivation order — first non-empty wins. */
const NICHE_SOURCES = ["youtube_topic_details", "hashtags_used", "type_of_profile"] as const;

/**
 * A GENERIC audience column, as a hand-made list writes it ("Followers"), with
 * no network prefix. The vendor export has none of these — it only has
 * per-network counts — so the two never collide in practice. When a file does
 * carry one, it is an explicit statement of the creator's reach and wins over
 * the per-network maximum.
 *
 * Without these, a simple `email,name,Followers` CSV would import with an EMPTY
 * followerCount, leaving the picker's default sort key blank for every row.
 */
const GENERIC_FOLLOWER_ALIASES = [
  "followers",
  "followercount",
  "subscribers",
  "subscribercount",
  "audience",
  "audiencesize",
  "reach",
  "totalfollowers",
] as const;

const GENERIC_ENGAGEMENT_ALIASES = [
  "engagement",
  "engagementrate",
  "engagementpercent",
  "engagementpct",
] as const;

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/**
 * Parse an audience count that may be suffixed or separated:
 *   "120k" → 120000   "1.2M" → 1200000   "1,200" → 1200   "54000" → 54000
 *
 * Returns null — NEVER 0 — for blank or unparseable input, so "unknown" sorts
 * as unknown rather than as "zero followers" at the bottom of the picker.
 */
export function parseCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim().replace(/,/g, "");
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMbB])?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = m[2]?.toLowerCase();
  const factor = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1;
  return Math.round(n * factor);
}

/** Parse a percentage: "4.2%" → 4.2, "4.2" → 4.2. Null if unparseable. */
export function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.trim().replace(/%$/, "").replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse a loose boolean. Null if it is neither clearly true nor clearly false. */
export function parseBool(raw: string | undefined): boolean | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1", "t"].includes(t)) return true;
  if (["false", "no", "n", "0", "f"].includes(t)) return false;
  return null;
}

/** Strip a leading "@" so handles are stored bare, whatever the entry path. */
export function stripAt(v: string | null): string | null {
  if (v == null) return null;
  const t = v.replace(/^@+/, "").trim();
  return t.length > 0 ? t : null;
}

// ---------------------------------------------------------------------------
// Mapped output
// ---------------------------------------------------------------------------

export interface PlatformStat {
  username?: string;
  link?: string;
  followers?: number;
  engagementPct?: number;
  avgLikes?: number;
  avgComments?: number;
  postCount?: number;
  lastPostDate?: string;
  postingFrequency?: string;
}

export interface MappedCreatorRow {
  /** "" when the row carries no email — the caller reports it as a skipped row. */
  email: string;
  name: string | null;
  handle: string | null;
  platform: string | null;
  niche: string | null;
  profileUrl: string | null;
  followerCount: number | null;
  engagementRate: number | null;
  location: string | null;
  language: string | null;
  bio: string | null;
  socialLinks: Record<string, string> | null;
  platformStats: Record<string, PlatformStat> | null;
  signals: Record<string, string | number | boolean> | null;
  metadata: Record<string, string> | null;
}

/** True if the header list contains something we recognise as the email column. */
export function hasEmailColumn(headers: string[]): boolean {
  const emailAliases = new Set(SCALAR_ALIASES.email.map(normalizeHeader));
  return headers.some((h) => emailAliases.has(normalizeHeader(h)));
}

/** Build a normalized-header → value lookup for one row. */
function normalizedLookup(record: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [header, value] of Object.entries(record)) {
    const key = normalizeHeader(header);
    // First non-empty wins; parseDelimited already dropped empty cells.
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

function pick(lookup: Map<string, string>, aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const v = lookup.get(normalizeHeader(alias));
    if (v) return v;
  }
  return null;
}

function get(lookup: Map<string, string>, ref: ColumnRef | undefined): string | undefined {
  if (!ref) return undefined;
  for (const header of typeof ref === "string" ? [ref] : ref) {
    const v = lookup.get(normalizeHeader(header));
    if (v) return v;
  }
  return undefined;
}

/** Every header spelling a ColumnRef can match, for the metadata exclusion set. */
function refHeaders(ref: ColumnRef | undefined): readonly string[] {
  if (!ref) return [];
  return typeof ref === "string" ? [ref] : ref;
}

/** Assign only when the value is present — keeps JSON blocks free of nulls. */
function put<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | null | undefined) {
  if (value !== null && value !== undefined) obj[key] = value;
}

/**
 * Map one parsed record onto creator fields, deriving platform/handle/niche and
 * the audience numbers from per-network columns when no direct column exists.
 */
export function mapCreatorRow(record: Record<string, string>): MappedCreatorRow {
  const lookup = normalizedLookup(record);

  // --- per-network stats -----------------------------------------------------
  const platformStats: Record<string, PlatformStat> = {};
  for (const net of NETWORKS) {
    const stat: PlatformStat = {};
    put(stat, "username", stripAt(get(lookup, net.username) ?? null) ?? undefined);
    put(stat, "link", get(lookup, net.link));
    put(stat, "followers", parseCount(get(lookup, net.followers)) ?? undefined);
    put(stat, "engagementPct", parsePercent(get(lookup, net.engagement)) ?? undefined);
    put(stat, "avgLikes", parseCount(get(lookup, net.avgLikes)) ?? undefined);
    put(stat, "avgComments", parseCount(get(lookup, net.avgComments)) ?? undefined);
    put(stat, "postCount", parseCount(get(lookup, net.postCount)) ?? undefined);
    put(stat, "lastPostDate", get(lookup, net.lastPostDate));
    put(stat, "postingFrequency", get(lookup, net.postingFrequency));
    if (Object.keys(stat).length > 0) platformStats[net.key] = stat;
  }

  // --- primary network -------------------------------------------------------
  // The network with the largest audience wins. platform / handle / profileUrl /
  // engagementRate all come from that SAME winner, so they can never disagree.
  let primary: NetworkSpec | null = null;
  let primaryFollowers = -1;
  for (const net of NETWORKS) {
    const followers = platformStats[net.key]?.followers;
    if (followers != null && followers > primaryFollowers) {
      primary = net;
      primaryFollowers = followers;
    }
  }
  // No follower counts anywhere, but a network block exists (e.g. link only) →
  // fall back to the first network that has any data at all, so a creator with
  // just an instagram_link still gets platform "Instagram" instead of nothing.
  if (!primary) {
    primary = NETWORKS.find((n) => platformStats[n.key] !== undefined) ?? null;
  }
  const primaryStat = primary ? platformStats[primary.key] : undefined;

  // --- social links ----------------------------------------------------------
  const socialLinks: Record<string, string> = {};
  for (const net of NETWORKS) {
    const link = get(lookup, net.link);
    if (link) socialLinks[net.key] = link;
  }
  for (const { key, header } of LINK_ONLY_COLUMNS) {
    const v = lookup.get(normalizeHeader(header));
    if (v) socialLinks[key] = v;
  }

  // --- signals ---------------------------------------------------------------
  const signals: Record<string, string | number | boolean> = {};
  for (const header of BOOLEAN_SIGNALS) {
    const b = parseBool(lookup.get(normalizeHeader(header)));
    if (b !== null) signals[header] = b;
  }
  for (const header of TEXT_SIGNALS) {
    const v = lookup.get(normalizeHeader(header));
    if (v) signals[header] = v;
  }
  for (const header of NUMERIC_SIGNALS) {
    const n = parseCount(lookup.get(normalizeHeader(header)));
    if (n !== null) signals[header] = n;
  }

  // --- scalars, direct column first then derived -----------------------------
  const direct = (f: ScalarField) => pick(lookup, SCALAR_ALIASES[f]);

  const email = (direct("email") ?? "").trim();
  const name = direct("name");
  const platform = direct("platform") ?? primary?.label ?? null;
  const handle = stripAt(direct("handle")) ?? primaryStat?.username ?? null;
  const profileUrl = direct("profileUrl") ?? primaryStat?.link ?? null;
  const bio = direct("bio") ?? (primary ? (get(lookup, primary.bio) ?? null) : null);

  const engagementRate =
    parsePercent(get(lookup, GENERIC_ENGAGEMENT_ALIASES)) ?? primaryStat?.engagementPct ?? null;

  // A generic "Followers" column is an explicit statement of reach and wins.
  // Otherwise take the MAX across networks — a creator's reach is their biggest
  // audience — which is the picker's default sort key.
  let followerCount = parseCount(get(lookup, GENERIC_FOLLOWER_ALIASES));
  if (followerCount === null) {
    for (const stat of Object.values(platformStats)) {
      if (stat.followers != null && (followerCount === null || stat.followers > followerCount)) {
        followerCount = stat.followers;
      }
    }
  }

  let niche = direct("niche");
  if (!niche) {
    for (const source of NICHE_SOURCES) {
      const v = lookup.get(normalizeHeader(source));
      if (v) {
        niche = v;
        break;
      }
    }
  }

  // --- metadata: every header not consumed above ------------------------------
  const consumed = new Set<string>(SCALAR_ALIAS_KEYS);
  for (const net of NETWORKS) {
    for (const ref of [
      net.followers,
      net.username,
      net.link,
      net.engagement,
      net.bio,
      net.avgLikes,
      net.avgComments,
      net.postCount,
      net.lastPostDate,
      net.postingFrequency,
    ]) {
      for (const h of refHeaders(ref)) consumed.add(normalizeHeader(h));
    }
  }
  for (const { header } of LINK_ONLY_COLUMNS) consumed.add(normalizeHeader(header));
  for (const h of [...BOOLEAN_SIGNALS, ...TEXT_SIGNALS, ...NUMERIC_SIGNALS]) {
    consumed.add(normalizeHeader(h));
  }
  for (const h of NICHE_SOURCES) consumed.add(normalizeHeader(h));
  for (const h of [...GENERIC_FOLLOWER_ALIASES, ...GENERIC_ENGAGEMENT_ALIASES]) {
    consumed.add(normalizeHeader(h));
  }

  const metadata: Record<string, string> = {};
  for (const [header, value] of Object.entries(record)) {
    if (!consumed.has(normalizeHeader(header))) metadata[header] = value;
  }

  return {
    email,
    name,
    handle,
    platform,
    niche,
    profileUrl,
    followerCount,
    engagementRate,
    location: direct("location"),
    language: direct("language"),
    bio,
    socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : null,
    platformStats: Object.keys(platformStats).length > 0 ? platformStats : null,
    signals: Object.keys(signals).length > 0 ? signals : null,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}
