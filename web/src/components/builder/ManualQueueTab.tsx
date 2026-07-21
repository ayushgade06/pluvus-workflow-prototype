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
      <div className="ds-fade-in" style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div
          style={{
            maxWidth: 960,
            margin: "0 auto",
            padding: "24px 28px 40px",
            display: "flex",
            flexDirection: "column",
            gap: 22,
          }}
        >
        {/* Live header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className={queue.isFetching ? undefined : "ds-pulse"}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: queue.isFetching ? colors.warning : colors.success,
              boxShadow: `0 0 8px ${queue.isFetching ? colors.warning : colors.success}66`,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: font.size.md, fontWeight: font.weight.medium, color: colors.text }}>
            Manual Queue
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
            v{workflow.latestVersion?.version} · refreshes every {POLL_INTERVAL_MS / 1000}s
          </span>
          <span style={{ fontSize: font.size.sm, color: colors.textDim, marginLeft: "auto" }}>
            Updated {formatTimestamp(data.generatedAt)}
          </span>
        </div>

        <p style={{ fontSize: font.size.md, color: colors.textMuted, margin: 0, lineHeight: 1.6, maxWidth: 640 }}>
          These creators were escalated out of the automated workflow because the AI could not
          safely proceed on its own. The brand contact is emailed for each escalation so a human can
          take over the conversation.
        </p>

        {/* Totals */}
        <div style={{ display: "flex", gap: 14 }}>
          <StatTile label="In Queue" value={data.total} color={colors.warning} />
          <StatTile label="Brand Notified" value={notifiedCount} color={colors.success} />
          <StatTile label="Needs Attention" value={failedCount} color={failedCount > 0 ? colors.danger : colors.textMuted} />
        </div>

        {/* Queue list */}
        {data.total > 0 && (
          <div>
            <SectionHeader count={data.total}>Escalated Creators</SectionHeader>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
        )}

        </div>
      </div>

      {/* Inspector panel */}
      {selectedInstanceId && (
        <div
          className="ds-slide-in-right"
          style={{
            width: 400,
            flexShrink: 0,
            borderLeft: `1px solid ${colors.border}`,
            background: colors.panel,
          }}
        >
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
        gap: 16,
        padding: "14px 18px",
        background: selected ? "#16171e" : colors.panel,
        border: `1px solid ${selected ? `${colors.accent}66` : colors.border}`,
        borderRadius: radii.md,
        boxShadow: selected
          ? `0 0 0 3px ${colors.accent}1f, 0 1px 2px rgba(0,0,0,0.4)`
          : "0 1px 2px rgba(0,0,0,0.4)",
        transition: "border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease",
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
          <span
            style={{
              fontSize: font.size.lg,
              fontWeight: font.weight.semibold,
              color: colors.text,
              letterSpacing: -0.2,
            }}
          >
            {item.creatorName}
          </span>
          {item.creatorHandle && (
            <span style={{ fontSize: font.size.sm, color: colors.textDim }}>
              @{item.creatorHandle}
            </span>
          )}
          {item.platform && (
            <span style={{ fontSize: font.size.sm, color: colors.textDim }}>· {item.platform}</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <span
            style={{
              fontSize: font.size.xs,
              fontWeight: font.weight.medium,
              color: "#e5b454",
              background: "rgba(229,180,84,0.12)",
              border: "1px solid rgba(229,180,84,0.3)",
              borderRadius: radii.pill,
              padding: "2px 9px",
              lineHeight: 1.5,
            }}
          >
            ⚠ {item.reasonLabel}
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

      {/* E6: one-click deep-link to the email thread holding the full
          conversation. Rendered only when the provider supplied a URL — omitted
          gracefully otherwise (mock/unconfigured provider, or not yet threaded).
          Outside the reason button so it's a real anchor, and stopPropagation so
          opening the thread doesn't also open the inspector. */}
      {item.threadUrl && (
        <a
          href={item.threadUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ds-focusable"
          title="Open the full email thread"
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: font.size.sm,
            color: colors.accent,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          🧵 Open thread
        </a>
      )}

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
        className={`ds-focusable ds-btn ${notify?.status === "SENT" ? "ds-btn-secondary" : "ds-btn-primary"}`}
        style={{
          flexShrink: 0,
          fontSize: font.size.sm,
          fontWeight: notify?.status === "SENT" ? font.weight.medium : font.weight.semibold,
          color: notify?.status === "SENT" ? colors.text : "#fff",
          background: notify?.status === "SENT" ? colors.panel : colors.accent,
          border: `1px solid ${notify?.status === "SENT" ? colors.borderStrong : "transparent"}`,
          borderRadius: radii.sm + 1,
          padding: "0 14px",
          height: 32,
          cursor: notifying ? "default" : "pointer",
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

