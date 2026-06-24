import { useState } from "react";
import { createCampaign, createWorkflowForCampaign } from "../../api/builderClient";
import { colors } from "../../theme";
import type { TemplateKey } from "../../api/builderTypes";

interface Props {
  onCreated: (workflowId: string) => void;
  onClose: () => void;
}

const TEMPLATES: { key: TemplateKey; name: string; description: string; icon: string }[] = [
  {
    key: "affiliate",
    name: "Affiliate Campaign",
    description:
      "Performance-based. Creators earn commission on conversions. Zero upfront cost to the brand.",
    icon: "📈",
  },
  {
    key: "hybrid",
    name: "Hybrid Campaign",
    description:
      "Base fee + affiliate commission. Best for mid-tier creators who want guaranteed payment.",
    icon: "🤝",
  },
  {
    key: "fixed_fee",
    name: "Fixed Fee Campaign",
    description:
      "Flat payment for deliverables. Simple, predictable, no performance tracking needed.",
    icon: "💰",
  },
];

export function CampaignWizard({ onCreated, onClose }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 fields
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [objective, setObjective] = useState("");
  const [notes, setNotes] = useState("");

  // Step 2 selection
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateKey | null>(null);
  const [workflowName, setWorkflowName] = useState("");

  function handleStep1Next() {
    if (!name.trim()) {
      setError("Campaign name is required");
      return;
    }
    if (!brand.trim()) {
      setError("Brand is required");
      return;
    }
    setError(null);
    setWorkflowName(`${name.trim()} Outreach`);
    setStep(2);
  }

  async function handleCreate() {
    if (!selectedTemplate) {
      setError("Please select a template");
      return;
    }
    if (!workflowName.trim()) {
      setError("Workflow name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const campaignData: Parameters<typeof createCampaign>[0] = {
        name: name.trim(),
        brand: brand.trim(),
      };
      if (objective.trim()) campaignData.objective = objective.trim();
      if (notes.trim()) campaignData.notes = notes.trim();
      const campaign = await createCampaign(campaignData);
      const workflow = await createWorkflowForCampaign(campaign.id, {
        name: workflowName.trim(),
        templateKey: selectedTemplate,
      });
      onCreated(workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 12,
          width: 560,
          maxWidth: "95vw",
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: `1px solid ${colors.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>
              {step === 1 ? "Create Campaign" : "Choose Template"}
            </div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
              Step {step} of 2
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: colors.textMuted,
              fontSize: 18,
              cursor: "pointer",
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        {/* Step indicator */}
        <div style={{ padding: "12px 24px 0", display: "flex", gap: 8 }}>
          {[1, 2].map((s) => (
            <div
              key={s}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                background: s <= step ? colors.accent : colors.border,
                transition: "background 0.2s",
              }}
            />
          ))}
        </div>

        {/* Content */}
        <div style={{ padding: "20px 24px" }}>
          {step === 1 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Field label="Campaign Name *">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Summer 2026 Launch"
                  style={inputStyle}
                  autoFocus
                />
              </Field>
              <Field label="Brand *">
                <input
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="e.g. Acme Co"
                  style={inputStyle}
                />
              </Field>
              <Field label="Objective">
                <input
                  value={objective}
                  onChange={(e) => setObjective(e.target.value)}
                  placeholder="e.g. Drive awareness for new product launch"
                  style={inputStyle}
                />
              </Field>
              <Field label="Notes">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any context or constraints for this campaign…"
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical" }}
                />
              </Field>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Field label="Workflow Name">
                <input
                  value={workflowName}
                  onChange={(e) => setWorkflowName(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 4 }}>
                Select a template — this determines the default node pipeline:
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {TEMPLATES.map((t) => (
                  <TemplateCard
                    key={t.key}
                    template={t}
                    selected={selectedTemplate === t.key}
                    onSelect={() => setSelectedTemplate(t.key)}
                  />
                ))}
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                marginTop: 12,
                padding: "8px 12px",
                background: "rgba(248,81,73,0.1)",
                border: `1px solid ${colors.danger}`,
                borderRadius: 6,
                fontSize: 12,
                color: colors.danger,
              }}
            >
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 24px 20px",
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          {step === 2 ? (
            <button
              onClick={() => setStep(1)}
              style={{
                padding: "8px 16px",
                background: "none",
                color: colors.textMuted,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              ← Back
            </button>
          ) : (
            <button
              onClick={onClose}
              style={{
                padding: "8px 16px",
                background: "none",
                color: colors.textMuted,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          )}
          {step === 1 ? (
            <button
              onClick={handleStep1Next}
              style={{
                padding: "8px 22px",
                background: colors.accent,
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Next →
            </button>
          ) : (
            <button
              onClick={() => void handleCreate()}
              disabled={submitting || !selectedTemplate}
              style={{
                padding: "8px 22px",
                background: submitting || !selectedTemplate ? colors.border : colors.accent,
                color: submitting || !selectedTemplate ? colors.textDim : "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: submitting || !selectedTemplate ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Creating…" : "Create Workflow"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 600,
          color: colors.textMuted,
          marginBottom: 5,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  borderRadius: 6,
  color: colors.text,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: { key: string; name: string; description: string; icon: string };
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        padding: "12px 16px",
        background: selected ? "rgba(56,139,253,0.08)" : colors.bg,
        border: `1.5px solid ${selected ? colors.accent : colors.border}`,
        borderRadius: 8,
        cursor: "pointer",
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      <div style={{ fontSize: 24, lineHeight: 1, marginTop: 2 }}>{template.icon}</div>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: colors.text, marginBottom: 3 }}>
          {template.name}
        </div>
        <div style={{ fontSize: 12, color: colors.textMuted, lineHeight: 1.5 }}>
          {template.description}
        </div>
      </div>
      {selected && (
        <div
          style={{
            marginLeft: "auto",
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: colors.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <span style={{ color: "#fff", fontSize: 12, lineHeight: 1 }}>✓</span>
        </div>
      )}
    </div>
  );
}
