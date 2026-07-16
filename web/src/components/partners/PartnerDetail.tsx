// ---------------------------------------------------------------------------
// Partner detail — Phase 4
// ---------------------------------------------------------------------------
// Payout info card · Attribution panel · Money panel (obligations + payouts)
// Every payout action: create fee/commission, mark-as-paid modal, resend,
// resolve-and-settle confirm.

import { useState } from "react";
import {
  usePartnershipDetail,
  usePartnershipPayouts,
  useCreateCommissionPayout,
  useCreateFixedFeePayout,
  useMarkPayoutSent,
  useResendPayout,
  useSettlePayout,
  formatCents,
} from "../../api/partnersClient";
import type { Payout, Obligation, PayoutStatus } from "../../api/types";
import { colors, font, radii } from "../../theme";
import {
  Badge,
  Button,
  StatTile,
  EmptyState,
  Modal,
  ConfirmDialog,
  Input,
  FormField,
  useToast,
} from "../ds";

interface Props {
  partnershipId: string;
  onClose: () => void;
}

export function PartnerDetail({ partnershipId, onClose }: Props) {
  const detail = usePartnershipDetail(partnershipId);
  const payoutsQ = usePartnershipPayouts(partnershipId);
  const toast = useToast();

  const createCommission = useCreateCommissionPayout(partnershipId);
  const createFee = useCreateFixedFeePayout(partnershipId);
  const markSent = useMarkPayoutSent(partnershipId);
  const resend = useResendPayout(partnershipId);
  const settle = useSettlePayout(partnershipId);

  const [markPaidPayout, setMarkPaidPayout] = useState<Payout | null>(null);
  const [settleConfirmPayout, setSettleConfirmPayout] = useState<Payout | null>(null);

  const p = detail.data;
  const payoutsData = payoutsQ.data;

  if (detail.isLoading) {
    return <PanelLoading />;
  }
  if (detail.error || !p) {
    return (
      <EmptyState
        icon="⚠"
        title="Failed to load partner"
        description={detail.error ? (detail.error as Error).message : "Not found"}
      />
    );
  }

  const unpaidTotal = p.rollup.unpaidFeeCents + p.rollup.unpaidCommissionCents;

  const handleCreateCommission = async () => {
    try {
      await createCommission.mutateAsync();
      toast.success("Commission payout created");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleCreateFee = async (obligationId: string) => {
    try {
      await createFee.mutateAsync(obligationId);
      toast.success("Fee payout created");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleResend = async (payoutId: string) => {
    try {
      const result = await resend.mutateAsync(payoutId);
      if (result.emailSent) toast.success("Payout email resent");
      else toast.info("Payout updated but email failed — check logs");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const handleSettle = async (payoutId: string) => {
    try {
      await settle.mutateAsync(payoutId);
      setSettleConfirmPayout(null);
      toast.success("Payout settled");
    } catch (e) {
      toast.error((e as Error).message);
      setSettleConfirmPayout(null);
    }
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
            {p.creatorName}
          </div>
          <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>
            {p.creatorEmail}
            {p.campaignName && (
              <> · <span style={{ color: colors.accent }}>{p.campaignName}</span></>
            )}
          </div>
        </div>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
        {/* ── Payout info card ─────────────────────────────────────────── */}
        <SectionTitle>Payout Info</SectionTitle>
        <PayoutInfoCard paymentInfo={p.paymentInfo} />

        {/* ── Attribution panel ────────────────────────────────────────── */}
        <SectionTitle style={{ marginTop: 24 }}>Attribution</SectionTitle>
        <AttributionPanel partnership={p} />

        {/* ── Money panel ──────────────────────────────────────────────── */}
        <SectionTitle style={{ marginTop: 24 }}>Money</SectionTitle>

        {/* Obligations */}
        <SubTitle>Obligations</SubTitle>
        {payoutsQ.isLoading ? (
          <PanelLoading compact />
        ) : !payoutsData || payoutsData.obligations.length === 0 ? (
          <EmptyState compact icon="📋" title="No obligations" description="No fixed fee was agreed." />
        ) : (
          <ObligationsTable
            obligations={payoutsData.obligations}
            onCreateFee={handleCreateFee}
            busy={createFee.isPending}
          />
        )}

        {/* Commission payout */}
        <div
          style={{
            marginTop: 16,
            padding: "14px 16px",
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: font.size.md, color: colors.text, fontWeight: font.weight.medium }}>
              Unpaid commission:{" "}
              <span style={{ color: p.rollup.unpaidCommissionCents > 0 ? colors.warning : colors.textMuted }}>
                {formatCents(p.rollup.unpaidCommissionCents)}
              </span>
            </div>
            <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 2 }}>
              Across {p.metrics.conversions} conversion{p.metrics.conversions !== 1 ? "s" : ""}
            </div>
          </div>
          <Button
            variant="primary"
            onClick={() => void handleCreateCommission()}
            disabled={p.rollup.unpaidCommissionCents <= 0 || createCommission.isPending}
          >
            {createCommission.isPending ? "Creating…" : "Create commission payout"}
          </Button>
        </div>

        {/* Payouts table */}
        <SubTitle style={{ marginTop: 20 }}>Payouts</SubTitle>
        {payoutsQ.isLoading ? (
          <PanelLoading compact />
        ) : !payoutsData || payoutsData.payouts.length === 0 ? (
          <EmptyState compact icon="💸" title="No payouts yet" description="Create a payout above to get started." />
        ) : (
          <PayoutsTable
            payouts={payoutsData.payouts}
            onMarkPaid={(payout) => setMarkPaidPayout(payout)}
            onResend={(payoutId) => void handleResend(payoutId)}
            onSettle={(payout) => setSettleConfirmPayout(payout)}
            resendBusy={resend.isPending}
          />
        )}

        {/* Link to observability inspector */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${colors.border}` }}>
          <a
            href={`#/observe?instanceId=${p.instanceId}`}
            style={{ fontSize: font.size.sm, color: colors.accent, textDecoration: "none" }}
          >
            View full event timeline in Observability →
          </a>
        </div>
      </div>

      {/* Mark-as-paid modal */}
      {markPaidPayout && (
        <MarkAsPaidModal
          payout={markPaidPayout}
          onClose={() => setMarkPaidPayout(null)}
          onSubmit={async (data) => {
            try {
              const result = await markSent.mutateAsync({ payoutId: markPaidPayout.id, data });
              setMarkPaidPayout(null);
              if (result.emailSent) toast.success("Payout marked sent — creator notified");
              else toast.info("Payout marked sent (email failed — use Resend)");
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
          busy={markSent.isPending}
        />
      )}

      {/* Resolve & settle confirm */}
      {settleConfirmPayout && (
        <ConfirmDialog
          title="Resolve & Settle Payout"
          message={
            <div>
              <p style={{ marginBottom: 12 }}>
                Only settle after resolving with the creator outside the platform.
              </p>
              <p>
                Settle <strong>{formatCents(settleConfirmPayout.amountCents)}</strong>{" "}
                {settleConfirmPayout.payoutType === "COMMISSION" ? "commission" : "fee"} payout?
              </p>
            </div>
          }
          confirmLabel="Settle"
          onConfirm={() => void handleSettle(settleConfirmPayout.id)}
          onCancel={() => setSettleConfirmPayout(null)}
          busy={settle.isPending}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payout info card
// ---------------------------------------------------------------------------

function PayoutInfoCard({ paymentInfo }: { paymentInfo: { method: string | null; accountIdentifier: string | null; shipping: unknown | null } | null }) {
  if (!paymentInfo || !paymentInfo.accountIdentifier) {
    return (
      <EmptyState
        compact
        icon="💳"
        title="No payout info"
        description="Creator hasn't completed the payment form yet."
      />
    );
  }

  const shipping = paymentInfo.shipping as Record<string, string> | null;

  return (
    <div
      style={{
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <Row label="Method">
        <Badge color={colors.success} dot>
          {paymentInfo.method ?? "PayPal"}
        </Badge>
      </Row>
      <Row label="Destination">
        <span
          style={{ fontFamily: "monospace", fontSize: font.size.sm, color: colors.text, cursor: "copy" }}
          onClick={() => void navigator.clipboard.writeText(paymentInfo.accountIdentifier!)}
          title="Click to copy"
        >
          {paymentInfo.accountIdentifier}
        </span>
      </Row>
      {shipping && typeof shipping === "object" && (
        <Row label="Shipping">
          <span style={{ fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.5 }}>
            {[shipping["name"], shipping["line1"], shipping["line2"], shipping["city"], shipping["state"], shipping["zip"], shipping["country"]]
              .filter(Boolean)
              .join(", ")}
          </span>
        </Row>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attribution panel
// ---------------------------------------------------------------------------

function AttributionPanel({ partnership: p }: { partnership: { metrics: { clicks: number; conversions: number; revenueCents: number; earnedCents: number }; trackingLink: string | null; referralCode: string; recentConversions: Array<{ id: string; externalId: string; valueCents: number; commissionCents: number; refunded: boolean; attributedAt: string }> } }) {
  const { metrics } = p;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Stat tiles */}
      <div style={{ display: "flex", gap: 10 }}>
        <StatTile label="Clicks" value={metrics.clicks} />
        <StatTile label="Conversions" value={metrics.conversions} />
        <StatTile label="Revenue" value={formatCents(metrics.revenueCents)} />
        <StatTile label="Earned" value={formatCents(metrics.earnedCents)} color={colors.success} />
      </div>

      {/* Tracking link */}
      {p.trackingLink ? (
        <div
          style={{
            background: colors.panel,
            border: `1px solid ${colors.border}`,
            borderRadius: radii.md,
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: font.size.xs,
              color: colors.textMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {p.trackingLink}
          </span>
          <Button
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(p.trackingLink!)}
          >
            Copy link
          </Button>
        </div>
      ) : (
        <EmptyState
          compact
          icon="🔗"
          title="No tracking link"
          description="No conversions yet — share the tracking link"
        />
      )}

      {/* Recent conversions */}
      {p.recentConversions.length > 0 && (
        <div>
          <div style={{ fontSize: font.size.sm, color: colors.textDim, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Recent conversions
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: font.size.sm }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {["External ID", "Value", "Commission", "Status", "Date"].map((h) => (
                  <th
                    key={h}
                    style={{ padding: "6px 10px", textAlign: "left", color: colors.textDim, fontWeight: font.weight.medium }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.recentConversions.slice(0, 20).map((c) => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <td style={{ padding: "7px 10px", fontFamily: "monospace", color: colors.textMuted }}>{c.externalId}</td>
                  <td style={{ padding: "7px 10px" }}>{formatCents(c.valueCents)}</td>
                  <td style={{ padding: "7px 10px" }}>{formatCents(c.commissionCents)}</td>
                  <td style={{ padding: "7px 10px" }}>
                    {c.refunded ? (
                      <Badge color={colors.danger} small>Refunded</Badge>
                    ) : (
                      <Badge color={colors.success} small>Attributed</Badge>
                    )}
                  </td>
                  <td style={{ padding: "7px 10px", color: colors.textMuted }}>
                    {new Date(c.attributedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.recentConversions.length === 0 && (
        <EmptyState compact icon="📊" title="No conversions yet" description="Share the tracking link to start attributing." />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Obligations table
// ---------------------------------------------------------------------------

function ObligationsTable({
  obligations,
  onCreateFee,
  busy,
}: {
  obligations: Obligation[];
  onCreateFee: (id: string) => void;
  busy: boolean;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: font.size.sm }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
          {["Description", "Amount", "Status", "Action"].map((h) => (
            <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: colors.textDim, fontWeight: font.weight.medium }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {obligations.map((ob) => (
          <tr key={ob.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
            <td style={{ padding: "9px 10px", color: colors.text }}>{ob.description}</td>
            <td style={{ padding: "9px 10px" }}>{formatCents(ob.amountCents)}</td>
            <td style={{ padding: "9px 10px" }}>
              <ObligationStatusBadge status={ob.status} />
            </td>
            <td style={{ padding: "9px 10px" }}>
              {ob.status === "PENDING" && ob.payoutId === null ? (
                <Button
                  variant="primary"
                  onClick={() => onCreateFee(ob.id)}
                  disabled={busy}
                >
                  {busy ? "Creating…" : "Create payout"}
                </Button>
              ) : (
                <span style={{ color: colors.textDim }}>—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Payouts table
// ---------------------------------------------------------------------------

function PayoutsTable({
  payouts,
  onMarkPaid,
  onResend,
  onSettle,
  resendBusy,
}: {
  payouts: Payout[];
  onMarkPaid: (payout: Payout) => void;
  onResend: (payoutId: string) => void;
  onSettle: (payout: Payout) => void;
  resendBusy: boolean;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: font.size.sm }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
          {["Type", "Amount", "Status", "Reference", "Date", "Actions"].map((h) => (
            <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: colors.textDim, fontWeight: font.weight.medium }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {payouts.map((payout) => (
          <tr key={payout.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
            <td style={{ padding: "9px 10px", color: colors.text }}>
              {payout.payoutType === "COMMISSION" ? "Commission" : "Fee"}
            </td>
            <td style={{ padding: "9px 10px", fontWeight: font.weight.medium }}>
              {formatCents(payout.amountCents)}
            </td>
            <td style={{ padding: "9px 10px" }}>
              <PayoutStatusBadge status={payout.status} />
            </td>
            <td style={{ padding: "9px 10px", fontFamily: "monospace", color: colors.textMuted, fontSize: font.size.xs }}>
              {payout.reference ?? "—"}
            </td>
            <td style={{ padding: "9px 10px", color: colors.textMuted, whiteSpace: "nowrap" }}>
              {new Date(payout.createdAt).toLocaleDateString()}
            </td>
            <td style={{ padding: "9px 10px" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {payout.status === "PENDING" && (
                  <Button variant="primary" onClick={() => onMarkPaid(payout)}>
                    Mark as paid…
                  </Button>
                )}
                {payout.status === "SENT" && (
                  <Button
                    variant="secondary"
                    onClick={() => onResend(payout.id)}
                    disabled={resendBusy}
                  >
                    {resendBusy ? "Resending…" : "Resend"}
                  </Button>
                )}
                {(payout.status === "CONFIRMED" || payout.status === "DISPUTED") && (
                  <Button variant="secondary" onClick={() => onSettle(payout)}>
                    Resolve & settle
                  </Button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Mark-as-paid modal
// ---------------------------------------------------------------------------

function MarkAsPaidModal({
  payout,
  onClose,
  onSubmit,
  busy,
}: {
  payout: Payout;
  onClose: () => void;
  onSubmit: (data: { reference: string; note?: string }) => void;
  busy: boolean;
}) {
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const canSubmit = reference.trim().length > 0;

  return (
    <Modal
      title="Mark as Paid"
      subtitle={`${payout.payoutType === "COMMISSION" ? "Commission" : "Fee"} · ${formatCents(payout.amountCents)} · ${payout.destination ?? "unknown"}`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const trimmedNote = note.trim();
              onSubmit({ reference: reference.trim(), ...(trimmedNote ? { note: trimmedNote } : {}) });
            }}
            disabled={!canSubmit || busy}
          >
            {busy ? "Marking…" : "Mark as paid"}
          </Button>
        </>
      }
    >
      <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
        <FormField label="PayPal Transaction ID *" hint="Required — paste the PayPal txn ID after paying">
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. 5AB12345CD678901E"
            autoFocus
          />
        </FormField>
        <FormField label="Note" hint="Optional — visible to you only">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Paid via PayPal batch"
          />
        </FormField>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

const PAYOUT_STATUS_COLOR: Record<PayoutStatus, string> = {
  PENDING: "#9da3ae",
  SENT: "#6e7cf5",
  CONFIRMED: "#3ecf8e",
  DISPUTED: "#f2555f",
  SETTLED: "#34b378",
};

function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <Badge color={PAYOUT_STATUS_COLOR[status]} dot small>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </Badge>
  );
}

function ObligationStatusBadge({ status }: { status: "PENDING" | "PAID" | "CANCELLED" }) {
  const color = status === "PAID" ? "#3ecf8e" : status === "CANCELLED" ? "#6a7080" : "#d9a03f";
  return (
    <Badge color={color} dot small>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function SectionTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontSize: font.size.sm,
        fontWeight: font.weight.semibold,
        color: colors.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginBottom: 10,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SubTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontSize: font.size.sm,
        color: colors.textDim,
        fontWeight: font.weight.medium,
        marginBottom: 8,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: font.size.sm, color: colors.textMuted, minWidth: 90 }}>{label}</span>
      {children}
    </div>
  );
}

function PanelLoading({ compact }: { compact?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: compact ? "24px" : "60px",
        color: colors.textMuted,
        fontSize: font.size.md,
      }}
    >
      Loading…
    </div>
  );
}
