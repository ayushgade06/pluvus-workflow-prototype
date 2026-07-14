// ---------------------------------------------------------------------------
// LLM usage surfaces (HARD-O1) — the dashboard strip + the per-instance panel.
// ---------------------------------------------------------------------------
// Reads the durable LlmCall telemetry: GET /observability/llm for the global
// strip under the Observability topbar, and InstanceDetail.llmUsage for the
// inspector's "AI Usage" tab. Token counts of "—" mean the provider reported
// no usage for that call (local Ollama without usage_metadata), distinct from 0.

import { useLlmUsage } from "../api/client";
import type { LlmCallDTO, LlmUsageTotals } from "../api/types";
import { colors, font, formatTimestamp } from "../theme";
import { Empty } from "./ui";

function formatTokens(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

// ---------------------------------------------------------------------------
// Dashboard strip
// ---------------------------------------------------------------------------

export function LlmUsageStrip() {
  const usage = useLlmUsage();
  const d = usage.data;
  // Silent until there is something to show — the strip must not add noise to
  // a deployment that has no persisted calls yet (or a failing endpoint).
  if (!d || d.totals.calls === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "6px 18px",
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel,
        flexShrink: 0,
        fontSize: font.size.sm,
        color: colors.textMuted,
        overflowX: "auto",
      }}
    >
      <span style={{ fontWeight: font.weight.semibold, color: colors.textMuted, whiteSpace: "nowrap" }}>
        AI usage
      </span>
      <UsageStat label="calls" value={`${d.last24h.calls} / 24h · ${d.totals.calls} total`} />
      <UsageStat label="tokens" value={`${formatTokens(d.last24h.totalTokens)} / 24h · ${formatTokens(d.totals.totalTokens)} total`} />
      <UsageStat label="est cost" value={`${formatCost(d.last24h.estCostUsd)} / 24h · ${formatCost(d.totals.estCostUsd)} total`} />
      <UsageStat label="avg latency" value={formatLatency(d.totals.avgLatencyMs)} />
      {d.totals.errors > 0 && (
        <UsageStat label="errors" value={String(d.totals.errors)} color={colors.danger} />
      )}
      <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
        {d.byRole.map((r) => (
          <span
            key={r.key}
            title={`${r.key}: ${r.totals.calls} calls · ${formatTokens(r.totals.totalTokens)} tokens · ${formatCost(r.totals.estCostUsd)}`}
            style={{
              padding: "1px 8px",
              borderRadius: 10,
              border: `1px solid ${colors.border}`,
              fontSize: font.size.xs,
              color: colors.textDim,
              whiteSpace: "nowrap",
            }}
          >
            {r.key} {r.totals.calls}
          </span>
        ))}
      </div>
    </div>
  );
}

function UsageStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
      <span style={{ fontWeight: font.weight.semibold, color: color ?? colors.text }}>{value}</span>
      <span style={{ fontSize: font.size.xs, color: colors.textDim, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-instance panel (InstanceInspector "AI Usage" tab)
// ---------------------------------------------------------------------------

export function InstanceLlmUsage({
  totals,
  calls,
}: {
  totals: LlmUsageTotals;
  calls: LlmCallDTO[];
}) {
  if (calls.length === 0) {
    return <Empty>No LLM calls recorded for this instance yet.</Empty>;
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", marginBottom: 12 }}>
        <UsageStat label="calls" value={String(totals.calls)} />
        <UsageStat label="tokens" value={formatTokens(totals.totalTokens)} />
        <UsageStat
          label="in / out"
          value={`${formatTokens(totals.inputTokens)} / ${formatTokens(totals.outputTokens)}`}
        />
        <UsageStat label="est cost" value={formatCost(totals.estCostUsd)} />
        <UsageStat label="avg latency" value={formatLatency(totals.avgLatencyMs)} />
        {totals.errors > 0 && <UsageStat label="errors" value={String(totals.errors)} color={colors.danger} />}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {[...calls].reverse().map((c) => (
          <CallRow key={c.id} call={c} />
        ))}
      </div>
    </div>
  );
}

function CallRow({ call }: { call: LlmCallDTO }) {
  return (
    <div
      style={{
        border: `1px solid ${call.ok ? colors.border : colors.danger}`,
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: font.size.sm,
        color: colors.textMuted,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: font.weight.semibold, color: colors.text }}>{call.role}</span>
        <span style={{ fontFamily: "monospace", fontSize: font.size.xs, color: colors.textDim }}>
          {call.model}
        </span>
        {!call.ok && (
          <span style={{ color: colors.danger, fontSize: font.size.xs }}>
            ✕ {call.errorKind ?? "failed"}
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: font.size.xs, color: colors.textDim }}>
          {formatTimestamp(call.createdAt)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 4, fontSize: font.size.xs, color: colors.textDim, flexWrap: "wrap" }}>
        <span>tokens {formatTokens(call.totalTokens)}</span>
        <span>
          in/out {formatTokens(call.inputTokens)}/{formatTokens(call.outputTokens)}
        </span>
        <span>cost {formatCost(call.estCostUsd)}</span>
        <span>latency {formatLatency(call.latencyMs)}</span>
        {call.promptVersion && <span>prompt {call.promptVersion}</span>}
      </div>
    </div>
  );
}
