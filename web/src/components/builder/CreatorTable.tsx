// ---------------------------------------------------------------------------
// Creator table (PLU-109 follow-up)
// ---------------------------------------------------------------------------
// Replaces the previous row layout, which packed up to seven pills against the
// right edge. Because they were flex-packed rather than laid out in columns,
// nothing lined up vertically — each row's platform sat at a different x
// position depending on the length of the values before it, so a long list
// could not be scanned down a column.
//
// The fix is one shared grid template driving BOTH the sticky header and every
// row, so every value sits in the same column on every row. Platform, niche,
// followers and engagement are now plain aligned text rather than pills; only
// status stays visual.

import { colors, radii, font } from "../../theme";
import { Chip, IconButton } from "../ds";
import type { CreatorItem, CreatorPlatformSummary } from "../../api/builderTypes";

/**
 * The single source of column geometry. Header and rows MUST use the same
 * string — that identity is what makes the columns line up.
 */
const GRID =
  "36px minmax(200px, 1fr) 108px 128px 96px 78px 128px 40px";

/** Below this the columns would crush, so the container scrolls instead. */
const MIN_WIDTH = 860;

export type SortKey = "name" | "followers" | "engagement";
export type SortDir = "asc" | "desc";

export interface CreatorRowData {
  creator: CreatorItem;
  /** This import created the creator (they were not already in the roster). */
  isNewFromBatch: boolean;
  /** Other committed lists this creator also appears in. */
  alsoInBatches: string[];
  isEnrolled: boolean;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** An em dash, never a blank cell: blank reads as a bug, "—" reads as unknown. */
const UNKNOWN = "—";

export function formatFollowers(n: number | null): string {
  if (n === null) return UNKNOWN;
  return n.toLocaleString("en-US");
}

function formatEngagement(n: number | null): string {
  return n === null ? UNKNOWN : `${n.toFixed(1)}%`;
}

/**
 * A network engages MEANINGFULLY better than the one on display.
 *
 * The table shows a creator's biggest network, and engagement follows that same
 * network so the handle and the percentage can never disagree. But a creator's
 * best-converting audience is often not their largest — in a real 102-creator
 * import, 12 displayed a worse engagement rate than their own best network, one
 * of them showing 0% while their TikTok ran at 7.1%. Half a point of headroom
 * keeps float noise from flagging everyone.
 */
const ENGAGEMENT_HEADROOM = 0.5;

function betterEngagementElsewhere(
  platforms: CreatorPlatformSummary[],
  shown: number | null,
  primaryKey: string | undefined,
): CreatorPlatformSummary | null {
  let best: CreatorPlatformSummary | null = null;
  for (const p of platforms) {
    if (p.key === primaryKey || p.engagementPct == null) continue;
    if (best === null || p.engagementPct > (best.engagementPct ?? 0)) best = p;
  }
  if (!best || best.engagementPct == null) return null;
  if (shown === null) return best;
  return best.engagementPct - shown >= ENGAGEMENT_HEADROOM ? best : null;
}

/** Multi-line breakdown for the native title tooltip. */
function platformBreakdown(platforms: CreatorPlatformSummary[], primaryKey?: string): string {
  return platforms
    .map((p) => {
      const marker = p.key === primaryKey ? "\u2022 " : "  ";
      const followers = p.followers === null ? "unknown" : p.followers.toLocaleString("en-US");
      const eng = p.engagementPct === null ? "" : ` \u00b7 ${p.engagementPct.toFixed(1)}% engagement`;
      const handle = p.handle ? ` \u00b7 @${p.handle}` : "";
      return `${marker}${p.label}: ${followers} followers${eng}${handle}`;
    })
    .join("\n");
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

// Deterministic avatar tint, derived from the name we already render.
const AVATAR_COLORS = ["#6e7cf5", "#a78bfa", "#57d9a3", "#d9a03f", "#e0784a", "#8b96f8"];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface HeaderProps {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
}

export function CreatorTableHeader({
  sortKey,
  sortDir,
  onSort,
  allSelected,
  someSelected,
  onToggleAll,
}: HeaderProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: GRID,
        alignItems: "center",
        gap: 10,
        padding: "0 16px",
        height: 38,
        minWidth: MIN_WIDTH,
        // Sticky so the column meaning stays visible while scrolling hundreds
        // of rows — the whole point of having columns.
        position: "sticky",
        top: 0,
        zIndex: 2,
        background: colors.panelAlt,
        borderBottom: `1px solid ${colors.border}`,
        fontSize: font.size.xs,
        fontWeight: font.weight.semibold,
        letterSpacing: 0.4,
        color: colors.textMuted,
        textTransform: "uppercase",
      }}
    >
      <input
        type="checkbox"
        checked={allSelected}
        ref={(el) => {
          // Indeterminate is the honest state for a partial selection; it can
          // only be set imperatively.
          if (el) el.indeterminate = !allSelected && someSelected;
        }}
        onChange={onToggleAll}
        className="ds-focusable"
        aria-label={allSelected ? "Deselect all visible" : "Select all visible"}
        style={{ width: 15, height: 15, accentColor: colors.accent, cursor: "pointer" }}
      />
      <SortHeader label="Creator" active={sortKey === "name"} dir={sortDir} onClick={() => onSort("name")} />
      <span>Platform</span>
      <span>Niche</span>
      <SortHeader
        label="Followers"
        align="right"
        active={sortKey === "followers"}
        dir={sortDir}
        onClick={() => onSort("followers")}
      />
      <SortHeader
        label="Engage"
        align="right"
        active={sortKey === "engagement"}
        dir={sortDir}
        onClick={() => onSort("engagement")}
      />
      <span>Status</span>
      <span />
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ds-focusable"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      title={`Sort by ${label.toLowerCase()}`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
        gap: 4,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        font: "inherit",
        letterSpacing: "inherit",
        textTransform: "inherit",
        color: active ? colors.text : colors.textMuted,
      }}
    >
      {label}
      <span aria-hidden style={{ opacity: active ? 1 : 0.25, fontSize: 9 }}>
        {active && dir === "asc" ? "▲" : "▼"}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  row: CreatorRowData;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  /** NEW / DUPLICATE only mean something inside an import list. */
  showBatchStatus: boolean;
}

export function CreatorTableRow({ row, selected, onToggle, onDelete, showBatchStatus }: RowProps) {
  const { creator, isNewFromBatch, alsoInBatches, isEnrolled } = row;
  const tint = avatarColor(creator.name);

  return (
    <div
      className="ds-row"
      style={{
        display: "grid",
        gridTemplateColumns: GRID,
        alignItems: "center",
        gap: 10,
        padding: "9px 16px",
        minWidth: MIN_WIDTH,
        borderBottom: `1px solid ${colors.border}`,
        background: selected ? `${colors.accent}0f` : "transparent",
        boxShadow: selected ? `inset 2px 0 0 ${colors.accent}` : "none",
      }}
    >
      <input
        id={`sel-${creator.id}`}
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="ds-focusable"
        aria-label={`Select ${creator.name}`}
        style={{ width: 15, height: 15, accentColor: colors.accent, cursor: "pointer" }}
      />

      {/* Creator: avatar + name/@handle over email. htmlFor makes the whole cell
          a click target for the row's checkbox — without it the label is inert
          and only the 15px box is clickable. */}
      <label
        htmlFor={`sel-${creator.id}`}
        style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, cursor: "pointer" }}
      >
        <span
          aria-hidden
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: `${tint}1c`,
            border: `1px solid ${tint}33`,
            color: tint,
            fontSize: 10,
            fontWeight: font.weight.semibold,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {initials(creator.name)}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <Truncate
              style={{
                fontSize: font.size.md,
                color: colors.text,
                fontWeight: font.weight.medium,
                minWidth: 0,
              }}
            >
              {creator.name}
            </Truncate>
            {creator.handle && (
              <Truncate style={{ fontSize: font.size.sm, color: colors.textDim, flexShrink: 0, maxWidth: 120 }}>
                @{creator.handle}
              </Truncate>
            )}
          </span>
          <Truncate style={{ fontSize: font.size.sm, color: colors.textDim }}>{creator.email}</Truncate>
        </span>
      </label>

      <PlatformCell creator={creator} />
      <Truncate style={{ fontSize: font.size.sm, color: colors.textMuted }}>
        {creator.niche ?? UNKNOWN}
      </Truncate>

      {/* Numbers right-aligned with tabular figures so digits stack cleanly. */}
      <span
        style={{
          fontSize: font.size.sm,
          color: creator.followerCount === null ? colors.textMuted : colors.text,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatFollowers(creator.followerCount)}
      </span>
      <span
        style={{
          fontSize: font.size.sm,
          color: creator.engagementRate === null ? colors.textMuted : colors.textDim,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatEngagement(creator.engagementRate)}
      </span>

      <span style={{ display: "flex", gap: 5, alignItems: "center", minWidth: 0 }}>
        {showBatchStatus && isNewFromBatch && <Chip color={colors.success}>NEW</Chip>}
        {showBatchStatus && !isNewFromBatch && alsoInBatches.length > 0 && (
          // The other list's name lives in the tooltip rather than glued onto
          // the email line, which is what made rows read as one dense blob.
          <Chip color={colors.textDim} title={`Also in ${alsoInBatches.join(", ")}`}>
            DUPLICATE
          </Chip>
        )}
        {isEnrolled && <Chip color={colors.accent}>ENROLLED</Chip>}
      </span>

      <IconButton
        label={`Remove ${creator.name} from the roster`}
        icon="🗑"
        onClick={onDelete}
        className="ds-danger-hover"
        style={{ opacity: 0.45, justifySelf: "end" }}
      />
    </div>
  );
}

/**
 * Platform, plus a "+N" when the creator has other networks.
 *
 * The chip turns amber when one of those hidden networks engages meaningfully
 * better than the number on display — otherwise a strong mid-size audience
 * stays invisible behind the creator's own biggest platform.
 *
 * The breakdown rides on a native `title` rather than the design-system
 * Tooltip: that tooltip is absolutely positioned, and this table scrolls inside
 * an `overflow: auto` container, which would clip it on the top rows.
 */
function PlatformCell({ creator }: { creator: CreatorItem }) {
  const platforms = creator.platforms ?? [];
  const primaryKey = platforms[0]?.key;
  const others = platforms.length - 1;
  const better =
    others > 0 ? betterEngagementElsewhere(platforms, creator.engagementRate, primaryKey) : null;

  const title =
    platforms.length > 1
      ? `${platformBreakdown(platforms, primaryKey)}${
          better ? `\n\n${better.label} engages better than the ${creator.platform ?? "shown"} figure.` : ""
        }`
      : undefined;

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }} title={title}>
      <Truncate style={{ fontSize: font.size.sm, color: colors.textMuted, minWidth: 0 }}>
        {creator.platform ?? UNKNOWN}
      </Truncate>
      {others > 0 && (
        <span
          aria-label={`and ${others} more network${others !== 1 ? "s" : ""}`}
          style={{
            flexShrink: 0,
            fontSize: font.size.xs,
            fontWeight: font.weight.medium,
            lineHeight: 1.5,
            padding: "1px 5px",
            borderRadius: radii.pill,
            cursor: "default",
            color: better ? colors.warning : colors.textMuted,
            background: better ? `${colors.warning}1a` : colors.panelAlt,
            border: `1px solid ${better ? `${colors.warning}44` : colors.border}`,
          }}
        >
          +{others}
        </span>
      )}
    </span>
  );
}

/** Single-line ellipsis. Long niches and emails must not push columns around. */
function Truncate({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        display: "block",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export { GRID as CREATOR_GRID, MIN_WIDTH as CREATOR_MIN_WIDTH };
