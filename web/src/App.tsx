// ---------------------------------------------------------------------------
// App — Pluvus Platform (Phase 10: Workflow Builder + Observability)
// ---------------------------------------------------------------------------
// Views:
//   campaigns  — campaign list + creation wizard
//   builder    — workflow builder (canvas, config, enroll, launch, monitor)
//   observe    — observability dashboard (Phase 9, lazy-loaded)
//
// Routing is state-based (no react-router dependency) but MIRRORED TO THE URL
// HASH so a page refresh (or a shared link) restores the same view — e.g.
// `#/builder/<workflowId>` reopens that workflow instead of dumping the user
// back on the campaign list.

import { Suspense, lazy, useState, useEffect, useCallback } from "react";
import { CampaignList } from "./components/builder/CampaignList";
import { WorkflowBuilder } from "./components/builder/WorkflowBuilder";
import { ToastProvider } from "./components/ds";
import { colors, font } from "./theme";

// Lazy-load the observability dashboard so its React Flow graph + inspector
// stack stay out of the builder's initial bundle.
const ObservabilityView = lazy(() => import("./components/ObservabilityView"));
const PartnersView = lazy(() =>
  import("./components/partners/PartnersView").then((m) => ({ default: m.PartnersView })),
);

type View = "campaigns" | "builder" | "observe" | "partners";

interface Route {
  view: View;
  activeWorkflowId: string | null;
}

// -- URL hash <-> route serialization ---------------------------------------
// Formats: `#/campaigns`, `#/observe`, `#/builder/<workflowId>`.
function parseHash(): Route {
  const raw = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#\/?/, "");
  const [view, id] = raw.split("/");
  if (view === "builder" && id) return { view: "builder", activeWorkflowId: decodeURIComponent(id) };
  if (view === "observe") return { view: "observe", activeWorkflowId: null };
  if (view === "partners") return { view: "partners", activeWorkflowId: null };
  return { view: "campaigns", activeWorkflowId: null };
}

function routeToHash(r: Route): string {
  if (r.view === "builder" && r.activeWorkflowId) {
    return `#/builder/${encodeURIComponent(r.activeWorkflowId)}`;
  }
  if (r.view === "observe") return "#/observe";
  if (r.view === "partners") return "#/partners";
  return "#/campaigns";
}

export default function App() {
  const [{ view, activeWorkflowId }, setRoute] = useState<Route>(parseHash);

  // Keep the URL hash in sync with the current route (so refresh restores it).
  useEffect(() => {
    const target = routeToHash({ view, activeWorkflowId });
    if (window.location.hash !== target) {
      window.history.replaceState(null, "", target);
    }
  }, [view, activeWorkflowId]);

  // Respond to browser back/forward + manual hash edits.
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setView = useCallback((v: View) => {
    setRoute((prev) => ({ view: v, activeWorkflowId: v === "builder" ? prev.activeWorkflowId : null }));
  }, []);

  const openWorkflow = useCallback((id: string) => {
    setRoute({ view: "builder", activeWorkflowId: id });
  }, []);

  const backToCampaigns = useCallback(() => {
    setRoute({ view: "campaigns", activeWorkflowId: null });
  }, []);

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
          {view === "partners" && (
            <Suspense fallback={<Center>Loading partners…</Center>}>
              <PartnersView />
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
    { key: "partners", label: "Partners" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 24,
        borderBottom: `1px solid ${colors.border}`,
        background: colors.panel,
        flexShrink: 0,
        height: 48,
        padding: "0 20px",
      }}
    >
      {/* Flat mono wordmark — no gradient chip. A single accent tick before the
          name is the only decoration, so it reads as an intentional mark rather
          than a stock "logo square". */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: font.size.lg,
          fontWeight: font.weight.semibold,
          color: colors.text,
          letterSpacing: -0.4,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 3,
            height: 15,
            borderRadius: 2,
            background: colors.accent,
          }}
        />
        Pluvus
      </div>
      <div aria-hidden style={{ width: 1, height: 18, background: colors.border, opacity: 0.7 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 2 }} role="tablist">
        {tabs.map((tab) => {
          const activeView =
            view === tab.key ||
            (tab.key === "campaigns" && view === "builder");
          return (
            <button
              key={tab.key}
              onClick={() => onChangeView(tab.key)}
              role="tab"
              aria-selected={activeView}
              className="ds-focusable"
              style={{
                height: 30,
                padding: "0 11px",
                // Tinted wash for the active tab instead of a bordered box —
                // avoids the nested-box look while staying clearly selected.
                background: activeView ? colors.accentWash : "none",
                border: "none",
                borderRadius: 7,
                color: activeView ? colors.text : colors.textMuted,
                fontSize: font.size.md,
                fontWeight: activeView ? font.weight.semibold : font.weight.medium,
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
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
