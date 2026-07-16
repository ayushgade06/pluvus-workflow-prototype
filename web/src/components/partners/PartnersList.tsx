// ---------------------------------------------------------------------------
// Partners list — Phase 4
// ---------------------------------------------------------------------------
// Table: one row per partnership. Default sort: unpaid desc.
// Header: Export PayPal CSV + Refresh.
// Rows: creator · campaign · referral code · tracking link · metrics + rollup.
// Dispute badge + unpaid highlighting.

import { useState } from "react";
import type { PartnershipListItem } from "../../api/types";
import { formatCents } from "../../api/partnersClient";
import { colors, font, radii } from "../../theme";
import { Badge, Button, EmptyState } from "../ds";

interface Props {
  partnerships: PartnershipListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

export function PartnersList({ partnerships, selectedId, onSelect, onRefresh }: Props) {
  const [sortUnpaidDesc] = useState(true);

  const sorted = [...partnerships].sort((a, b) => {
    const ua = (a.rollup.unpaidFeeCents + a.rollup.unpaidCommissionCents);
    const ub = (b.rollup.unpaidFeeCents + b.rollup.unpaidCommissionCents);
    return sortUnpaidDesc ? ub - ua : ua - ub;
  });

  const handleExportCsv = () => {
    const a = document.createElement("a");
    a.href = "/api/payouts/export/paypal-csv";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 20px",
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: font.size.lg,
              fontWeight: font.weight.semibold,
              color: colors.text,
              letterSpacing: -0.2,
            }}
          >
            Partners
          </div>
          <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 1 }}>
            {partnerships.length} partner{partnerships.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" onClick={handleExportCsv}>
            Export PayPal CSV
          </Button>
          <Button variant="secondary" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {sorted.length === 0 && (
        <EmptyState
          icon="🤝"
          title="No partners yet"
          description="Partners appear here when creators complete the workflow and submit their payout info."
        />
      )}

      {/* Table */}
      {sorted.length > 0 && (
        <div style={{ flex: 1, overflow: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: font.size.md,
              color: colors.text,
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: `1px solid ${colors.border}`,
                  background: colors.panelAlt,
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                }}
              >
                {[
                  "Creator",
                  "Campaign",
                  "Referral code",
                  "Tracking link",
                  "Clicks",
                  "Conv.",
                  "Revenue",
                  "Earned",
                  "Unpaid",
                  "In-flight",
                  "Settled",
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "8px 12px",
                      textAlign: "left",
                      fontSize: font.size.xs,
                      fontWeight: font.weight.medium,
                      color: colors.textDim,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <PartnerRow
                  key={p.id}
                  partnership={p}
                  selected={p.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PartnerRow({
  partnership: p,
  selected,
  onSelect,
}: {
  partnership: PartnershipListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const unpaidTotal = p.rollup.unpaidFeeCents + p.rollup.unpaidCommissionCents;
  const hasUnpaid = unpaidTotal > 0;

  const copyToClipboard = (text: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(text);
  };

  return (
    <tr
      onClick={() => onSelect(p.id)}
      style={{
        borderBottom: `1px solid ${colors.border}`,
        background: selected ? colors.panelAlt : "transparent",
        cursor: "pointer",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = colors.panelAlt;
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {/* Creator */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <div style={{ fontWeight: font.weight.medium }}>{p.creatorName}</div>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>{p.creatorEmail}</div>
      </td>

      {/* Campaign */}
      <td style={{ padding: "10px 12px", color: colors.textMuted, fontSize: font.size.sm }}>
        {p.campaignName ?? "—"}
      </td>

      {/* Referral code */}
      <td style={{ padding: "10px 12px" }}>
        <span
          style={{
            fontFamily: "monospace",
            fontSize: font.size.sm,
            color: colors.accent,
            cursor: "copy",
          }}
          onClick={(e) => copyToClipboard(p.referralCode, e)}
          title="Click to copy referral code"
        >
          {p.referralCode}
        </span>
      </td>

      {/* Tracking link */}
      <td style={{ padding: "10px 12px" }}>
        {p.trackingLink ? (
          <span
            style={{
              fontSize: font.size.xs,
              color: colors.accent,
              cursor: "copy",
              maxWidth: 180,
              display: "inline-block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              verticalAlign: "middle",
            }}
            onClick={(e) => copyToClipboard(p.trackingLink!, e)}
            title={p.trackingLink}
          >
            Copy link
          </span>
        ) : (
          <span style={{ color: colors.textDim }}>—</span>
        )}
      </td>

      {/* Clicks */}
      <Num>{p.metrics.clicks}</Num>

      {/* Conversions */}
      <Num>{p.metrics.conversions}</Num>

      {/* Revenue */}
      <Num>{formatCents(p.metrics.revenueCents)}</Num>

      {/* Earned */}
      <Num>{formatCents(p.metrics.earnedCents)}</Num>

      {/* Unpaid — highlighted when > 0 + dispute badge */}
      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
        <span
          style={{
            color: hasUnpaid ? colors.warning : colors.textMuted,
            fontWeight: hasUnpaid ? font.weight.semibold : font.weight.regular,
          }}
        >
          {hasUnpaid ? formatCents(unpaidTotal) : "—"}
        </span>
        {p.rollup.hasDispute && (
          <span style={{ marginLeft: 6 }}>
            <Badge color={colors.danger} dot small>
              Dispute
            </Badge>
          </span>
        )}
      </td>

      {/* In-flight */}
      {p.rollup.inFlightCents > 0 ? (
        <Num color={colors.accent}>{formatCents(p.rollup.inFlightCents)}</Num>
      ) : (
        <Num>—</Num>
      )}

      {/* Settled */}
      {p.rollup.settledCents > 0 ? (
        <Num color={colors.success}>{formatCents(p.rollup.settledCents)}</Num>
      ) : (
        <Num>—</Num>
      )}
    </tr>
  );
}

function Num({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <td
      style={{
        padding: "10px 12px",
        color: color ?? colors.textMuted,
        fontVariantNumeric: "tabular-nums",
        fontSize: font.size.md,
      }}
    >
      {children}
    </td>
  );
}
