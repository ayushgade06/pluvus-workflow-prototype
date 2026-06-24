import { useState } from "react";
import { useCampaigns } from "../../api/builderClient";
import { colors, formatTimestamp } from "../../theme";
import { CampaignWizard } from "./CampaignWizard";
import type { CampaignListItem } from "../../api/builderTypes";

interface Props {
  onSelectWorkflow: (workflowId: string) => void;
}

export function CampaignList({ onSelectWorkflow }: Props) {
  const { data: campaigns, isLoading, isError, refetch } = useCampaigns();
  const [showWizard, setShowWizard] = useState(false);

  function handleCreated(workflowId: string) {
    setShowWizard(false);
    void refetch();
    onSelectWorkflow(workflowId);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: colors.bg,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 24px",
          borderBottom: `1px solid ${colors.border}`,
          background: colors.panel,
          flexShrink: 0,
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>Campaigns</div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
            Create and manage creator campaigns
          </div>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          style={{
            padding: "8px 16px",
            background: colors.accent,
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + New Campaign
        </button>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {isLoading && (
          <div style={{ color: colors.textMuted, fontSize: 13 }}>Loading campaigns…</div>
        )}
        {isError && (
          <div style={{ color: colors.danger, fontSize: 13 }}>
            Failed to load campaigns. Is the server running?
          </div>
        )}
        {!isLoading && !isError && (!campaigns || campaigns.length === 0) && (
          <EmptyState onNew={() => setShowWizard(true)} />
        )}
        {campaigns && campaigns.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {campaigns.map((c) => (
              <CampaignCard key={c.id} campaign={c} onSelectWorkflow={onSelectWorkflow} />
            ))}
          </div>
        )}
      </div>

      {showWizard && (
        <CampaignWizard onCreated={handleCreated} onClose={() => setShowWizard(false)} />
      )}
    </div>
  );
}

function CampaignCard({
  campaign,
  onSelectWorkflow,
}: {
  campaign: CampaignListItem;
  onSelectWorkflow: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data: detail } = useCampaigns();
  // We use the list data + detail lazy-load on expand
  const [detailData, setDetailData] = useState<import("../../api/builderTypes").CampaignDetail | null>(null);

  async function handleExpand() {
    if (!expanded && !detailData) {
      try {
        const res = await fetch(`/api/campaigns/${campaign.id}`);
        if (res.ok) {
          const d = await res.json();
          setDetailData(d);
        }
      } catch {
        /* ignore */
      }
    }
    setExpanded((e) => !e);
  }

  return (
    <div
      style={{
        background: colors.panel,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 18px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          cursor: "pointer",
        }}
        onClick={() => void handleExpand()}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
              {campaign.name}
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: colors.textMuted,
                background: colors.panelAlt,
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                padding: "1px 6px",
              }}
            >
              {campaign.brand}
            </span>
          </div>
          <div style={{ fontSize: 12, color: colors.textMuted }}>
            {campaign.objective || "No objective set"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.accent }}>
              {campaign.workflowCount}
            </div>
            <div style={{ fontSize: 10, color: colors.textDim, textTransform: "uppercase" }}>
              workflows
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: colors.textDim }}>
            {formatTimestamp(campaign.createdAt)}
          </div>
          <div style={{ fontSize: 12, color: colors.textMuted }}>
            {expanded ? "▲" : "▼"}
          </div>
        </div>
      </div>

      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${colors.border}`,
            padding: "12px 18px",
            background: colors.bg,
          }}
        >
          {!detailData ? (
            <div style={{ fontSize: 12, color: colors.textMuted }}>Loading workflows…</div>
          ) : detailData.workflows.length === 0 ? (
            <div style={{ fontSize: 12, color: colors.textMuted }}>No workflows yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {detailData.workflows.map((wf) => (
                <div
                  key={wf.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    background: colors.panel,
                    border: `1px solid ${colors.border}`,
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                  onClick={() => onSelectWorkflow(wf.id)}
                >
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, color: colors.text }}>{wf.name}</span>
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 10.5,
                        color: wf.status === "PUBLISHED" ? colors.success : colors.textMuted,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                      }}
                    >
                      {wf.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: colors.textDim }}>
                    {wf.versionCount} version{wf.versionCount !== 1 ? "s" : ""}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: colors.accent,
                      fontWeight: 600,
                    }}
                  >
                    Open →
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 80,
        gap: 20,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 40 }}>📋</div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
          No campaigns yet
        </div>
        <div style={{ fontSize: 13, color: colors.textMuted, maxWidth: 300 }}>
          Create your first campaign to start building outreach workflows for creators.
        </div>
      </div>
      <button
        onClick={onNew}
        style={{
          padding: "10px 22px",
          background: colors.accent,
          color: "#fff",
          border: "none",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Create Campaign
      </button>
    </div>
  );
}
