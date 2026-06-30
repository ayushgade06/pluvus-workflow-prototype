import { useId, useState } from "react";
import { createCampaign, createWorkflowForCampaign } from "../../api/builderClient";
import { colors, radii, font } from "../../theme";
import { Modal, Button, Input, Textarea, FormField, useToast } from "../ds";
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
  const toast = useToast();

  // Step 1 fields
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [objective, setObjective] = useState("");
  const [notes, setNotes] = useState("");

  // Step 2 selection
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateKey | null>(null);
  const [workflowName, setWorkflowName] = useState("");

  const nameId = useId();
  const brandId = useId();
  const notifyId = useId();
  const objId = useId();
  const notesId = useId();
  const wfNameId = useId();

  const notifyEmailInvalid =
    !!notifyEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail.trim());

  function handleStep1Next() {
    if (!name.trim()) {
      setError("Campaign name is required");
      return;
    }
    if (!brand.trim()) {
      setError("Brand is required");
      return;
    }
    if (notifyEmailInvalid) {
      setError("Notification email must be a valid email address");
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
      // Identical payload shape to the original implementation.
      const campaignData: Parameters<typeof createCampaign>[0] = {
        name: name.trim(),
        brand: brand.trim(),
      };
      if (notifyEmail.trim()) campaignData.notifyEmail = notifyEmail.trim();
      if (objective.trim()) campaignData.objective = objective.trim();
      if (notes.trim()) campaignData.notes = notes.trim();
      const campaign = await createCampaign(campaignData);
      const workflow = await createWorkflowForCampaign(campaign.id, {
        name: workflowName.trim(),
        templateKey: selectedTemplate,
      });
      toast.success(`Created “${campaign.name}”.`);
      onCreated(workflow.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={step === 1 ? "Create Campaign" : "Choose Template"}
      subtitle={`Step ${step} of 2`}
      onClose={onClose}
      width={560}
      footer={
        <>
          {step === 2 ? (
            <Button variant="secondary" onClick={() => setStep(1)} disabled={submitting} leftIcon="←">
              Back
            </Button>
          ) : (
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          )}
          {step === 1 ? (
            <Button variant="primary" onClick={handleStep1Next} rightIcon="→">
              Next
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void handleCreate()}
              disabled={submitting || !selectedTemplate}
            >
              {submitting ? "Creating…" : "Create Workflow"}
            </Button>
          )}
        </>
      }
    >
      {/* Step progress bar */}
      <div style={{ padding: "14px 22px 0", display: "flex", gap: 8 }}>
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

      <div style={{ padding: "18px 22px" }}>
        {step === 1 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <FormField label="Campaign Name *" htmlFor={nameId}>
              <Input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Summer 2026 Launch"
                invalid={!!error && !name.trim()}
                autoFocus
              />
            </FormField>
            <FormField label="Brand *" htmlFor={brandId}>
              <Input
                id={brandId}
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. Acme Co"
                invalid={!!error && !brand.trim()}
              />
            </FormField>
            <FormField
              label="Escalation notification email"
              htmlFor={notifyId}
              hint="Where we email the brand when a creator is escalated to the manual review queue. Defaults to the workspace operator if left blank."
            >
              <Input
                id={notifyId}
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="e.g. partnerships@acme.com"
                invalid={notifyEmailInvalid}
              />
            </FormField>
            <FormField label="Objective" htmlFor={objId}>
              <Input
                id={objId}
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. Drive awareness for new product launch"
              />
            </FormField>
            <FormField label="Notes" htmlFor={notesId}>
              <Textarea
                id={notesId}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any context or constraints for this campaign…"
                rows={3}
              />
            </FormField>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <FormField label="Workflow Name" htmlFor={wfNameId}>
              <Input id={wfNameId} value={workflowName} onChange={(e) => setWorkflowName(e.target.value)} />
            </FormField>
            <div style={{ fontSize: font.size.md, color: colors.textMuted }}>
              Select a template — this determines the default node pipeline:
            </div>
            <div role="radiogroup" aria-label="Workflow template" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
              marginTop: 14,
              padding: "9px 12px",
              background: "rgba(248,81,73,0.1)",
              border: `1px solid ${colors.danger}`,
              borderRadius: radii.md,
              fontSize: font.size.md,
              color: colors.danger,
            }}
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

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
    <button
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="ds-focusable ds-card-interactive"
      style={{
        padding: "13px 16px",
        background: selected ? "rgba(56,139,253,0.08)" : colors.bg,
        border: `1.5px solid ${selected ? colors.accent : colors.border}`,
        borderRadius: radii.md,
        cursor: "pointer",
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        textAlign: "left",
        width: "100%",
      }}
    >
      <div aria-hidden style={{ fontSize: 24, lineHeight: 1, marginTop: 2 }}>
        {template.icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: font.size.md, fontWeight: font.weight.semibold, color: colors.text, marginBottom: 3 }}>
          {template.name}
        </div>
        <div style={{ fontSize: font.size.md, color: colors.textMuted, lineHeight: 1.5 }}>
          {template.description}
        </div>
      </div>
      {selected && (
        <div
          aria-hidden
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: colors.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: "#fff",
            fontSize: 12,
          }}
        >
          ✓
        </div>
      )}
    </button>
  );
}
