// ---------------------------------------------------------------------------
// Partners view — Phase 4
// ---------------------------------------------------------------------------
// Top-level brand view: partners list + partner detail drawer.
// Mounted from App.tsx as the "Partners" tab.

import { useState } from "react";
import { usePartnerships } from "../../api/partnersClient";
import { PartnersList } from "./PartnersList";
import { PartnerDetail } from "./PartnerDetail";
import { colors, font } from "../../theme";
import { EmptyState, Button } from "../ds";

export function PartnersView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = usePartnerships();

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: colors.textMuted,
          fontSize: font.size.md,
        }}
      >
        Loading partners…
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon="⚠"
        title="Failed to load partners"
        description={(error as Error).message}
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const partnerships = data ?? [];

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* List panel */}
      <div
        style={{
          flex: selectedId ? "0 0 55%" : "1",
          minWidth: 0,
          height: "100%",
          overflow: "auto",
          borderRight: selectedId ? `1px solid ${colors.border}` : undefined,
        }}
      >
        <PartnersList
          partnerships={partnerships}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRefresh={() => void refetch()}
        />
      </div>

      {/* Detail drawer */}
      {selectedId && (
        <div style={{ flex: 1, minWidth: 0, height: "100%", overflow: "auto" }}>
          <PartnerDetail
            partnershipId={selectedId}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </div>
  );
}
