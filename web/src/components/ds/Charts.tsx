// ---------------------------------------------------------------------------
// Charts — small recharts wrappers styled for the Tano sticker aesthetic.
// ---------------------------------------------------------------------------
// A donut (pipeline distribution) and a sparkline (stat-tile trend). Both read
// theme colours so they follow the light/dark swap. Kept intentionally tiny —
// these are dashboard accents, not a full charting layer.
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import { colors, font } from "../../theme";

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

/** Donut with a big serif total in the hole. */
export function Donut({
  data,
  total,
  totalLabel = "Total",
  size = 150,
}: {
  data: DonutSlice[];
  total: number;
  totalLabel?: string;
  size?: number;
}) {
  const slices = data.filter((d) => d.value > 0);
  const chartData = slices.length ? slices : [{ label: "None", value: 1, color: colors.hairline }];
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="label"
            innerRadius={size * 0.32}
            outerRadius={size * 0.48}
            paddingAngle={slices.length > 1 ? 3 : 0}
            stroke={colors.cardBorder}
            strokeWidth={2}
            startAngle={90}
            endAngle={-270}
            isAnimationActive={false}
          >
            {chartData.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <span
          className="serif nums"
          style={{
            fontSize: size * 0.24,
            fontWeight: font.weight.black,
            color: colors.text,
            lineHeight: 1,
          }}
        >
          {total}
        </span>
        <span
          style={{
            fontSize: font.size.xs,
            color: colors.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            marginTop: 2,
          }}
        >
          {totalLabel}
        </span>
      </div>
    </div>
  );
}

/** Filled sparkline for a stat-tile trend. */
export function Sparkline({
  data,
  color = colors.accent,
  width = 72,
  height = 28,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const chartData = data.map((v, i) => ({ i, v }));
  const gradId = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <div style={{ width, height, flexShrink: 0 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradId})`}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
