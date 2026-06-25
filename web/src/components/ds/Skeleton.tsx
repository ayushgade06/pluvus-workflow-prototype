// Skeleton — shimmer placeholder for loading states. Compose `lines`/`rows`
// helpers for common shapes. Animation respects prefers-reduced-motion (CSS).
import { colors, radii } from "../../theme";

interface Props {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: React.CSSProperties;
}

export function Skeleton({ width = "100%", height = 12, radius = 6, style }: Props) {
  return (
    <span
      aria-hidden
      className="ds-skeleton"
      style={{ display: "block", width, height, borderRadius: radius, ...style }}
    />
  );
}

/** A stack of text-line skeletons of decreasing width. */
export function SkeletonLines({ count = 3, gap = 8 }: { count?: number; gap?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} width={`${100 - i * 12}%`} height={11} />
      ))}
    </div>
  );
}

/** A list of card-shaped row skeletons (campaign list, creator list, etc.). */
export function SkeletonRows({ count = 4, height = 56 }: { count?: number; height?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="ds-skeleton"
          style={{ height, borderRadius: radii.md, background: colors.panel }}
        />
      ))}
    </div>
  );
}
