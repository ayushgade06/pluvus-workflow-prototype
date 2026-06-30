import { useState } from "react";
import { useManualQueue, notifyBrand, useBuilderInvalidator } from "../../api/builderClient";
import { POLL_INTERVAL_MS } from "../../api/client";
import { colors, radii, font, formatTimestamp, relativeTime } from "../../theme";
import { StatTile, EmptyState, SectionHeader, useToast } from "../ds";
import { InstanceInspector } from "../InstanceInspector";
import type { WorkflowDetail } from "../../api/builderTypes";
import type {
  ManualQueueItem,
  BrandNotificationStatus,
} from "../../api/builderTypes";

interface Props {
  workflow: WorkflowDetail;
}

// Colour + label per brand-notification status.
const notifyMeta: Record<
  BrandNotificationStatus | "NONE",
  { label: string; color: string }
> = {
  SENT: { label: "Brand notified", color: colors.success },
  FAILED: { label: "Notification failed", color: colors.danger },
  SKIPPED: { label: "No recipient", color: colors.textDim },
  NONE: { label: "Not notified", color: colors.warning },
};

export function ManualQueueTab({ workflow }: Props) {
  const queue = useManualQueue(workflow.id);
  const inv = useBuilderInvalidator(workflow.id);
  const toast = useToast();
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [notifying, setNotifying] = useState<string | null>(null);

  const data = queue.data;
  const hasVersion = !!workflow.latestVersion;

  if (!hasVersion) {
    return (
      <EmptyState
        icon="🛟"
        title="Manual queue is empty"
        description="Publish and launch the workflow first. Creators the AI can't handle on its own will appear here for a human to take over."
      />
    );
  }

  if (!data || data.total === 0) {
    return (
      <EmptyState
        icon="🛟"
        title="No creators need review"
        description={`Nothing has been escalated to the manual queue yet. Auto-refreshes every ${POLL_INTERVAL_MS / 1000}s.`}
      />
    );
  }

  const notifiedCount = data.items.filter((i) => i.notification?.status === "SENT").length;
  const failedCount = data.items.filter(
    (i) => !i.notification || i.notification.status === "FAILED",
  ).length;

  async function handleNotify(item: ManualQueueItem) {
    setNotifying(item.instanceId);
    try {
      const res = await notifyBrand(item.instanceId);
      if (res.status === "SENT" || res.status === "ALREADY_NOTIFIED") {
        toast.success(
          res.recipient
            ? `Notified ${res.recipient}.`
            : "Brand notification sent.",
        );
      } else if (res.status === "SKIPPED") {
        toast.error("No notification recipient is configured for this campaign.");
      } else {
        toast.error("Notification failed to send. Check the email provider.");
      }
      await inv.invalidateManualQueue();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Notification failed.");
    } finally {
      setNotifying(null);
    }
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
          padding: "20px 24px",
          gap: 18,
        }}
      >
        {/* Live header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: queue.isFetching ? colors.warning : colors.success,
              boxShadow: `0 0 6px ${queue.isFetching ? colors.warning : colors.success}`,
            }}
          />
          <span style={{ fontSize: font.size.md, color: colors.textMuted }}>
            Manual Queue · v{workflow.latestVersion?.version} · {POLL_INTERVAL_MS / 1000}s refresh
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim, marginLeft: "auto" }}>
            {formatTimestamp(data.generatedAt)}
          </span>
        </div>

        <p style={{ fontSize: font.size.md, color: colors.textMuted, margin: 0, lineHeight: 1.5 }}>
          These creators were escalated out of the automated workflow because the AI could not
          safely proceed on its own. The brand contact is emailed for each escalation so a human can
          take over the conversation.
        </p>

        {/* Totals */}
        <div style={{ display: "flex", gap: 12 }}>
          <StatTile label="In Queue" value={data.total} color={colors.warning} />
          <StatTile label="Brand Notified" value={notifiedCount} color={colors.success} />
          <StatTile label="Needs Attention" value={failedCount} color={colors.danger} />
        </div>

        {/* Queue list */}
        <div>
          <SectionHeader>Escalated Creators</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {data.items.map((item) => (
              <QueueRow
                key={item.instanceId}
                item={item}
                selected={selectedInstanceId === item.instanceId}
                notifying={notifying === item.instanceId}
                onOpen={() => setSelectedInstanceId(item.instanceId)}
                onNotify={() => void handleNotify(item)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Inspector panel */}
      {selectedInstanceId && (
        <div style={{ width: 400, flexShrink: 0, borderLeft: `1px solid ${colors.border}` }}>
          <InstanceInspector
            instanceId={selectedInstanceId}
            onClose={() => setSelectedInstanceId(null)}
          />
        </div>
      )}
    </div>
  );
}

function QueueRow({
  item,
  selected,
  notifying,
  onOpen,
  onNotify,
}: {
  item: ManualQueueItem;
  selected: boolean;
  notifying: boolean;
  onOpen: () => void;
  onNotify: () => void;
}) {
  const notify = item.notification;
  const meta = notifyMeta[notify?.status ?? "NONE"];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 16px",
        background: selected ? colors.panelAlt : colors.bg,
        border: `1px solid ${selected ? colors.accent : colors.border}`,
        borderRadius: radii.md,
      }}
    >
      {/* Creator + reason — clickable to open inspector */}
      <button
        onClick={onOpen}
        className="ds-focusable"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          background: "transparent",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colors.text }}>
            {item.creatorName}
          </span>
          {item.creatorHandle && (
            <span style={{ fontSize: font.size.sm, color: colors.textMuted }}>
              @{item.creatorHandle}
            </span>
          )}
          {item.platform && (
            <span style={{ fontSize: font.size.sm, color: colors.textDim }}>· {item.platform}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: font.size.xs,
              fontWeight: font.weight.semibold,
              color: "#e3b341",
              background: "rgba(227,179,65,0.12)",
              border: "1px solid rgba(227,179,65,0.4)",
              borderRadius: radii.pill,
              padding: "2px 8px",
            }}
          >
            {item.reasonLabel}
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
            {item.escalatedAt
              ? `escalated ${relativeTime(item.escalatedAt)}`
              : `updated ${relativeTime(item.updatedAt)}`}
          </span>
          {item.negotiationRound > 0 && (
            <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
              · round {item.negotiationRound}
            </span>
          )}
        </div>
      </button>

      {/* Notification status */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: font.size.sm, color: meta.color }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: meta.color }} />
          {meta.label}
        </span>
        {notify?.recipient && notify.status !== "SKIPPED" && (
          <span style={{ fontSize: font.size.xs, color: colors.textDim }}>{notify.recipient}</span>
        )}
        {notify?.status === "FAILED" && notify.error && (
          <span
            style={{ fontSize: font.size.xs, color: colors.danger, maxWidth: 200, textAlign: "right" }}
            title={notify.error}
          >
            {notify.error.length > 40 ? `${notify.error.slice(0, 40)}…` : notify.error}
          </span>
        )}
      </div>

      {/* Notify / resend action */}
      <button
        onClick={onNotify}
        disabled={notifying}
        className="ds-focusable"
        style={{
          flexShrink: 0,
          fontSize: font.size.sm,
          fontWeight: font.weight.semibold,
          color: notify?.status === "SENT" ? colors.textMuted : "#fff",
          background: notify?.status === "SENT" ? "transparent" : colors.accent,
          border: `1px solid ${notify?.status === "SENT" ? colors.border : colors.accent}`,
          borderRadius: radii.sm,
          padding: "7px 12px",
          cursor: notifying ? "default" : "pointer",
          opacity: notifying ? 0.6 : 1,
          whiteSpace: "nowrap",
        }}
      >
        {notifying
          ? "Sending…"
          : notify?.status === "SENT"
            ? "Resend"
            : "Notify brand"}
      </button>
    </div>
  );
}
