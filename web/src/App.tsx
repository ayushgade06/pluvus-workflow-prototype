// ---------------------------------------------------------------------------
// App — Pluvus Platform (Phase 10: Workflow Builder + Observability)
// ---------------------------------------------------------------------------
// Views:
//   campaigns  — campaign list + creation wizard
//   builder    — workflow builder (canvas, config, enroll, launch, monitor)
//   observe    — observability dashboard (Phase 9, lazy-loaded)
//
// Routing is state-based (no react-router dependency).

import { Suspense, lazy, useState } from "react";
import { CampaignList } from "./components/builder/CampaignList";
import { WorkflowBuilder } from "./components/builder/WorkflowBuilder";
import { ToastProvider } from "./components/ds";
import { colors, font } from "./theme";

// Lazy-load the observability dashboard so its React Flow graph + inspector
// stack stay out of the builder's initial bundle.
const ObservabilityView = lazy(() => import("./components/ObservabilityView"));

type View = "campaigns" | "builder" | "observe";

export default function App() {
  const [view, setView] = useState<View>("campaigns");
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);

  function openWorkflow(id: string) {
    setActiveWorkflowId(id);
    setView("builder");
  }

  function backToCampaigns() {
    setView("campaigns");
    setActiveWorkflowId(null);
  }

  return (
    <ToastProvider>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: colors.bg }}>
        <AppTopbar view={view} onChangeView={setView} />
        <div style={{ flex: 1, minHeight: 0 }}>
          {view === "campaigns" && <CampaignList onSelectWorkflow={openWorkflow} />}
          {view === "builder" && activeWorkflowId && (
            <WorkflowBuilder workflowId={activeWorkflowId} onBack={backToCampaigns} />
          )}
          {view === "builder" && !activeWorkflowId && <CampaignList onSelectWorkflow={openWorkflow} />}
          {view === "observe" && (
            <Suspense fallback={<Center>Loading observability…</Center>}>
              <ObservabilityView />
            </Suspense>
          )}
        </div>
      </div>
    </ToastProvider>
  );
}

// ---------------------------------------------------------------------------
// App-level topbar with view switcher
// ---------------------------------------------------------------------------

function AppTopbar({ view, onChangeView }: { view: View; onChangeView: (v: View) => void }) {
  const tabs: { key: View; label: string }[] = [
    { key: "campaigns", label: "Builder" },
    { key: "observe", label: "Observability" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel,
        flexShrink: 0,
        height: 44,
      }}
    >
      <div
        style={{
          padding: "0 18px",
          fontSize: font.size.md,
          fontWeight: font.weight.bold,
          color: colors.text,
          borderRight: `1px solid ${colors.border}`,
          height: "100%",
          display: "flex",
          alignItems: "center",
          letterSpacing: -0.2,
        }}
      >
        Pluvus
      </div>
      {tabs.map((tab) => {
        const activeView = view === tab.key || (tab.key === "campaigns" && view === "builder");
        return (
          <button
            key={tab.key}
            onClick={() => onChangeView(tab.key)}
            role="tab"
            aria-selected={activeView}
            className="ds-focusable"
            style={{
              height: "100%",
              padding: "0 18px",
              background: "none",
              border: "none",
              borderBottom: `2px solid ${activeView ? colors.accent : "transparent"}`,
              color: activeView ? colors.accent : colors.textMuted,
              fontSize: font.size.md,
              fontWeight: activeView ? font.weight.semibold : font.weight.regular,
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
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
      {children}
    </div>
  );
}
