import { useState, useEffect, useId, useRef } from "react";
import { colors, radii, font } from "../../theme";
import {
  Button,
  Input,
  Textarea,
  Select,
  FormField,
  IconButton,
  ConfirmDialog,
  Badge,
} from "../ds";
import { stateColor, stateLabel } from "../../theme";
import { nodeLabel, nodeIcon, nodeColor, nodeDescription } from "./nodeMeta";
import type {
  DraftNode,
  InitialOutreachConfig,
  FollowUpConfig,
  NegotiationConfig,
  RewardSetupConfig,
  ContentBriefConfig,
} from "../../api/builderTypes";
import { uploadFile } from "../../api/builderClient";

interface Props {
  node: DraftNode;
  onUpdate: (nodeId: string, config: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
  onMoveUp: (nodeId: string) => void;
  onMoveDown: (nodeId: string) => void;
  isFirst: boolean;
  isLast: boolean;
  saving?: boolean;
  saveError?: string | null;
  savedAt?: string | null;
}

export function NodeConfigPanel({
  node,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  saving = false,
  saveError = null,
  savedAt = null,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const color = nodeColor(node.type);

  return (
    <div
      className="ds-slide-in-right"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: colors.panel,
      }}
    >
      {/* Panel header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: font.size.xs,
            fontWeight: font.weight.semibold,
            color: colors.textDim,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 10,
          }}
        >
          Step Configuration
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span
            aria-hidden
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: `${color}1c`,
              border: `1px solid ${color}26`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              flexShrink: 0,
            }}
          >
            {nodeIcon(node.type)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: font.size.lg,
                fontWeight: font.weight.semibold,
                color: colors.text,
                letterSpacing: -0.2,
              }}
            >
              {nodeLabel(node.type)}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: colors.textDim, marginTop: 2 }}>
              {node.id}
            </div>
          </div>
        </div>
        {nodeDescription(node.type) && (
          <div style={{ fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.55, marginTop: 12 }}>
            {nodeDescription(node.type)}
          </div>
        )}
      </div>

      {/* Config form */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px" }}>
        <NodeForm node={node} onUpdate={onUpdate} />
      </div>

      {/* Sticky save status */}
      <div
        style={{
          padding: "7px 18px",
          borderTop: `1px solid ${colors.border}`,
          flexShrink: 0,
          fontSize: font.size.sm,
          minHeight: 30,
          display: "flex",
          alignItems: "center",
          background: colors.panelAlt,
        }}
        aria-live="polite"
      >
        {saveError ? (
          <span style={{ color: colors.danger }}>● Save failed — {saveError}</span>
        ) : saving ? (
          <span style={{ color: colors.textDim }}>Saving changes…</span>
        ) : savedAt ? (
          <span style={{ color: colors.textDim }}>
            <span style={{ color: colors.success }}>✓</span> All changes saved
          </span>
        ) : (
          <span style={{ color: colors.textDim }}>Changes save automatically</span>
        )}
      </div>

      {/* Actions */}
      <div
        style={{
          padding: "12px 18px",
          borderTop: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <IconButton
          label="Move step up"
          icon="↑"
          disabled={isFirst}
          onClick={() => onMoveUp(node.id)}
          style={{ border: `1px solid ${isFirst ? colors.border : colors.borderStrong}` }}
        />
        <IconButton
          label="Move step down"
          icon="↓"
          disabled={isLast}
          onClick={() => onMoveDown(node.id)}
          style={{ border: `1px solid ${isLast ? colors.border : colors.borderStrong}` }}
        />
        <div style={{ flex: 1 }} />
        {/* Every node type is deletable — graph validation guarantees the flow
            still has a valid terminal + phase order before it can be published. */}
        <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
          Delete step
        </Button>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete step?"
          message={
            <>
              Delete the <strong>{nodeLabel(node.type)}</strong> step? This removes it from the draft
              workflow. You can re-publish afterwards.
            </>
          }
          confirmLabel="Delete step"
          destructive
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete(node.id);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-node forms
// ---------------------------------------------------------------------------

function NodeForm({
  node,
  onUpdate,
}: {
  node: DraftNode;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  switch (node.type) {
    case "INITIAL_OUTREACH":
      return (
        <InitialOutreachForm
          nodeId={node.id}
          config={node.config as InitialOutreachConfig}
          onUpdate={onUpdate}
        />
      );
    case "FOLLOW_UP":
      return (
        <FollowUpForm nodeId={node.id} config={node.config as FollowUpConfig} onUpdate={onUpdate} />
      );
    case "REPLY_DETECTION":
      return (
        <ReplyDetectionInfo />
      );
    case "NEGOTIATION":
      return (
        <NegotiationForm
          nodeId={node.id}
          config={node.config as NegotiationConfig}
          onUpdate={onUpdate}
        />
      );
    case "REWARD_SETUP":
      return <RewardSetupInfo config={node.config as RewardSetupConfig} />;
    case "PAYMENT_INFO":
      return <PaymentInfoInfo config={node.config as Record<string, unknown>} />;
    case "CONTENT_BRIEF":
      return (
        <ContentBriefForm
          nodeId={node.id}
          config={node.config as ContentBriefConfig}
          onUpdate={onUpdate}
        />
      );
    case "END":
      return <EndNodeInfo />;
    default:
      return (
        <div style={{ fontSize: font.size.md, color: colors.textMuted }}>
          No configuration available for this step type.
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Initial Outreach form
// ---------------------------------------------------------------------------

function InitialOutreachForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: InitialOutreachConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [subject, setSubject] = useState(config.subjectTemplate ?? "");
  const [body, setBody] = useState(config.bodyTemplate ?? "");
  const subjectId = useId();
  const bodyId = useId();

  useEffect(() => {
    setSubject(config.subjectTemplate ?? "");
    setBody(config.bodyTemplate ?? "");
  }, [nodeId, config.subjectTemplate, config.bodyTemplate]);

  // Identical payload to before: spread config, override subject/body.
  function flush() {
    onUpdate(nodeId, {
      ...config,
      subjectTemplate: subject,
      bodyTemplate: body,
    });
  }

  return (
    <FormStack>
      <InfoBox>
        The first email sent to each creator is written by the AI, personalized from your campaign
        details (brand, deliverables, reward, deal terms). The subject and body below are an{" "}
        <strong>optional fallback</strong> — used only if AI generation is unavailable. Leave them
        blank to use the built-in default. Fallback text supports template variables:{" "}
        <Code>{"{{creatorName}}"}</Code>, <Code>{"{{brandName}}"}</Code>,{" "}
        <Code>{"{{rewardDescription}}"}</Code> (the campaign's product/sample reward, blank when
        none).
      </InfoBox>
      <Section title="Fallback message (optional)">
        <FormField label="Subject Line" htmlFor={subjectId}>
          <Input
            id={subjectId}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={flush}
            placeholder="e.g. Partnership opportunity with {{brandName}}"
          />
        </FormField>
        <FormField label="Email Body" htmlFor={bodyId} hint="Plain text. Template variables are supported.">
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={flush}
            rows={10}
            placeholder="Leave blank to use the built-in default…"
          />
        </FormField>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Follow-Up form
// ---------------------------------------------------------------------------

function FollowUpForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: FollowUpConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [intervals, setIntervals] = useState<number[]>(config.intervals ?? [3]);
  const [unit, setUnit] = useState(config.intervalUnit ?? "days");
  const [maxCount, setMaxCount] = useState(config.maxCount ?? 2);
  const [body, setBody] = useState(config.bodyTemplate ?? "");
  const maxId = useId();
  const unitId = useId();
  const bodyId = useId();

  useEffect(() => {
    setIntervals(config.intervals ?? [3]);
    setUnit(config.intervalUnit ?? "days");
    setMaxCount(config.maxCount ?? 2);
    setBody(config.bodyTemplate ?? "");
  }, [nodeId]);

  // `over` lets us flush with values that haven't yet round-tripped through
  // state (replaces the prior setTimeout(flush, 0) hack). stopOnReply is no
  // longer written: the "cancel follow-ups on reply" behavior is hardcoded in
  // the runtime (an inbound reply always clears the follow-up dueAt), so the old
  // toggle promised an off-switch that never existed. flush rebuilds the config
  // from these fields only, so any legacy stopOnReply is naturally dropped.
  function flush(over?: Partial<FollowUpConfig>) {
    onUpdate(nodeId, {
      intervals,
      intervalUnit: unit,
      maxCount,
      bodyTemplate: body,
      ...over,
    });
  }

  return (
    <FormStack>
      <InfoBox>
        Sends follow-up emails at configured intervals, and <strong>always stops as soon as the
        creator replies</strong>. Each follow-up is written by the AI, personalized from your
        campaign details — the body below is an <strong>optional fallback</strong>, used only if AI
        generation is unavailable. Leave it blank to use the built-in default.
      </InfoBox>

      <Section title="Cadence">
        <FormField label="Max Follow-Ups" htmlFor={maxId}>
          <Input
            id={maxId}
            type="number"
            min={1}
            max={5}
            value={maxCount}
            onChange={(e) => setMaxCount(Number(e.target.value))}
            onBlur={() => flush()}
            style={{ width: 90 }}
          />
        </FormField>

        <FormField label="Intervals" hint="How long to wait before each follow-up.">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {intervals.map((v, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <Input
                  type="number"
                  min={1}
                  value={v}
                  aria-label={`Interval ${i + 1}`}
                  onChange={(e) => {
                    const next = [...intervals];
                    next[i] = Number(e.target.value);
                    setIntervals(next);
                  }}
                  onBlur={() => flush()}
                  style={{ width: 64 }}
                />
                {intervals.length > 1 && (
                  <IconButton
                    label={`Remove interval ${i + 1}`}
                    icon="×"
                    size={22}
                    style={{ color: colors.danger }}
                    onClick={() => {
                      const next = intervals.filter((_, j) => j !== i);
                      setIntervals(next);
                      flush({ intervals: next });
                    }}
                  />
                )}
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const next = [...intervals, 3];
                setIntervals(next);
                flush({ intervals: next });
              }}
            >
              + Add
            </Button>
          </div>
        </FormField>

        <FormField label="Interval Unit" htmlFor={unitId}>
          <Select
            id={unitId}
            value={unit}
            onChange={(e) => {
              const next = e.target.value as "seconds" | "minutes" | "hours" | "days";
              setUnit(next);
              flush({ intervalUnit: next });
            }}
          >
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </Select>
        </FormField>

      </Section>

      <Section title="Fallback message (optional)">
        <FormField label="Follow-Up Body" htmlFor={bodyId} hint="Fallback only — used for every follow-up if AI generation is unavailable.">
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => flush()}
            rows={8}
            placeholder="Leave blank to use the built-in default…"
          />
        </FormField>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Reply Detection form
// ---------------------------------------------------------------------------

// Reply Detection has NO configurable fields. The classifier's low-confidence
// threshold is a fixed engine constant (LOW_CONFIDENCE_THRESHOLD = 0.50 in
// server replyDetection.ts) and low-confidence replies ALWAYS route to Manual
// Review — neither was ever read from node config. The old slider + toggle were
// dead controls, so this is now a read-only summary of the actual behavior.
function ReplyDetectionInfo() {
  return (
    <FormStack>
      <InfoBox>
        AI classifies each reply as Positive, Negative, Question, Opt-Out, or Unknown, then routes it
        to the matching next step. This step has no settings — the thresholds below are fixed.
      </InfoBox>

      <Section title="Confidence Threshold">
        <div style={{ fontSize: font.size.xl, fontWeight: font.weight.bold, color: colors.text }}>
          50%
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4 }}>
          Fixed. A reply the AI classifies with less than 50% confidence is treated as Unknown.
        </div>
      </Section>

      <Section title="Low-Confidence Behavior">
        <Badge color={stateColor["MANUAL_REVIEW"]} dot>
          {stateLabel["MANUAL_REVIEW"]}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          Always on. Any reply below the threshold (or that fails to classify) is sent to{" "}
          <strong>Manual Review</strong> for a human to handle, rather than auto-advanced.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Negotiation form
// ---------------------------------------------------------------------------

function NegotiationForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: NegotiationConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [minBudget, setMinBudget] = useState(config.minBudget ?? 0);
  const [maxBudget, setMaxBudget] = useState(config.maxBudget ?? 1000);
  const [maxRounds, setMaxRounds] = useState(config.maxRounds ?? 3);
  const [commissionRate, setCommissionRate] = useState(config.commissionRate ?? 0);
  const minId = useId();
  const maxId = useId();
  const roundsId = useId();
  const commissionId = useId();

  useEffect(() => {
    setMinBudget(config.minBudget ?? 0);
    setMaxBudget(config.maxBudget ?? 1000);
    setMaxRounds(config.maxRounds ?? 3);
    setCommissionRate(config.commissionRate ?? 0);
  }, [nodeId]);

  // commissionRate is only included when > 0 (0 is the omitted default = no
  // commission). Over-budget tolerance has no UI control (hidden by product
  // decision — the engine still honors it, fee-only; see server/agent
  // overCeilingTolerance wiring, Phase C / #12). We PRESERVE any existing saved
  // value by reading it straight from `config` here, so editing other fields
  // doesn't silently drop it; new campaigns just never set it (defaults to 0 =
  // escalate on any over-max ask).
  function flush(over?: Partial<NegotiationConfig>) {
    const next = {
      minBudget,
      maxBudget,
      maxRounds,
      commissionRate,
      ...over,
    };
    const { commissionRate: rate, ...rest } = next;
    const savedTolerance = config.overCeilingTolerance;
    // approvalMode is no longer written: it had no consumer (the engine always
    // auto-accepts within budget), so the "manual" option promised a human gate
    // that never existed. flush rebuilds the config from these fields only, so
    // any legacy approvalMode is naturally dropped on the next save.
    onUpdate(nodeId, {
      ...rest,
      ...(rate > 0 ? { commissionRate: rate } : {}),
      ...(typeof savedTolerance === "number" && savedTolerance > 0
        ? { overCeilingTolerance: savedTolerance }
        : {}),
    });
  }

  const budgetInvalid = maxBudget < minBudget;

  return (
    <FormStack>
      <InfoBox>
        The AI agent opens at the preferred budget and concedes up only as needed — never above the
        maximum. Escalates to Manual Review after the max rounds limit is reached.
      </InfoBox>

      <Section title="Budget">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField
            label="Preferred Budget ($)"
            htmlFor={minId}
            hint="The rate you'd ideally close at — the agent opens here."
          >
            <Input
              id={minId}
              type="number"
              min={0}
              value={minBudget}
              onChange={(e) => setMinBudget(Number(e.target.value))}
              onBlur={() => flush()}
            />
          </FormField>
          <FormField
            label="Maximum Budget ($)"
            htmlFor={maxId}
            hint="Absolute ceiling — the agent never offers above this."
            error={budgetInvalid ? "Must be ≥ preferred budget" : undefined}
          >
            <Input
              id={maxId}
              type="number"
              min={0}
              value={maxBudget}
              invalid={budgetInvalid}
              onChange={(e) => setMaxBudget(Number(e.target.value))}
              onBlur={() => flush()}
            />
          </FormField>
        </div>
        <FormField
          label="Commission Rate (%)"
          htmlFor={commissionId}
          hint="Set to 0 for fixed-fee deals."
        >
          <Input
            id={commissionId}
            type="number"
            min={0}
            max={100}
            value={commissionRate}
            onChange={(e) => setCommissionRate(Number(e.target.value))}
            onBlur={() => flush()}
            style={{ width: 90 }}
          />
        </FormField>
      </Section>

      <Section title="Approval">
        <FormField label="Max Negotiation Rounds" htmlFor={roundsId}>
          <Input
            id={roundsId}
            type="number"
            min={1}
            max={10}
            value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}
            onBlur={() => flush()}
            style={{ width: 90 }}
          />
        </FormField>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Reward Setup node (read-only summary)
// ---------------------------------------------------------------------------
// Finalizes the commercial agreement after a successful negotiation. The final
// fixed fee is resolved at runtime (the rate the negotiation closed on), so it
// is shown as "resolved from the closed deal" here; commission and deliverables
// come from the campaign / negotiation config. Mirrors the runtime node display:
// Final Fixed Fee · Commission · Deliverables · Status.

function RewardSetupInfo({ config }: { config: RewardSetupConfig }) {
  const commission =
    typeof config.commissionRate === "number" && config.commissionRate > 0
      ? config.commissionRate
      : null;
  const deliverablesRaw =
    typeof config.deliverables === "string" ? config.deliverables.trim() : "";
  const deliverableItems = deliverablesRaw
    ? deliverablesRaw
        .split(/\r?\n|,/)
        .map((d) => d.trim())
        .filter(Boolean)
    : [];

  return (
    <FormStack>
      <InfoBox>
        Runs after a successful negotiation. Records the agreed fee, commission,
        and deliverables, then emails the creator a{" "}
        <strong>Campaign Agreement Confirmation</strong> and waits for them to
        reply <Code>I Agree</Code> before advancing.
      </InfoBox>

      <Section title="Final Fixed Fee">
        <div style={{ fontSize: font.size.xl, fontWeight: font.weight.bold, color: colors.text }}>
          Agreed rate
        </div>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4 }}>
          Resolved at runtime from the rate the negotiation closed on.
        </div>
      </Section>

      <Section title="Commission">
        <div style={{ fontSize: font.size.xl, fontWeight: font.weight.bold, color: colors.text }}>
          {commission !== null ? `${commission}%` : "None"}
        </div>
      </Section>

      <Section title="Deliverables">
        {deliverableItems.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18, color: colors.text, lineHeight: 1.7 }}>
            {deliverableItems.map((d, i) => (
              <li key={i} style={{ fontSize: font.size.md }}>
                {d}
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: font.size.sm, color: colors.textMuted }}>
            Set on the campaign; shown to the creator in the confirmation email.
          </div>
        )}
      </Section>

      <Section title="Status">
        <Badge color={stateColor["REWARD_PENDING"]} dot>
          {stateLabel["REWARD_PENDING"]}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          Each creator waits here until they confirm. On confirmation the instance
          moves to <strong>{stateLabel["REWARD_CONFIRMED"]}</strong>.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Payment Info node (read-only summary)
// ---------------------------------------------------------------------------
// Collects the creator's payout information after they confirm the agreement.
// The node emails a link to a hosted payout form and waits for the submission
// before resuming the workflow. No builder configuration today — the form link
// and email are derived at runtime — so this mirrors the runtime node display:
// Payment Method · Submission Status · Collected Fields.

function PaymentInfoInfo({ config }: { config: Record<string, unknown> }) {
  // The campaign's "ships a physical product" flag is stamped into every node's
  // config; when on, the hosted form also collects a shipping address.
  const shipsProduct = config["shipsPhysicalProduct"] === true;
  // The fields the hosted payout form collects, with the two required ones
  // marked. "Verified" is a placeholder only (no verification is performed).
  const fields: Array<{ label: string; required: boolean }> = [
    { label: "Preferred Method", required: true },
    { label: "Account Identifier", required: true },
    { label: "Country", required: false },
    { label: "Notes", required: false },
    ...(shipsProduct ? [{ label: "Shipping Address", required: true }] : []),
  ];

  return (
    <FormStack>
      <InfoBox>
        Runs after the creator confirms the agreement. Emails a secure link to a{" "}
        <strong>hosted payout form</strong> and waits for the creator to submit
        their payout details. On submission the workflow resumes automatically —
        this node does not send payments or verify anything.
        {shipsProduct && (
          <>
            {" "}
            This campaign ships a physical product, so the form also collects a{" "}
            <strong>shipping address</strong>.
          </>
        )}
      </InfoBox>

      <Section title="Payout Methods">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {["PayPal", "Wise", "Bank Transfer"].map((m) => (
            <span
              key={m}
              style={{
                fontSize: font.size.sm,
                color: colors.text,
                background: colors.panelAlt,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.pill,
                padding: "3px 10px",
              }}
            >
              {m}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Collected Fields">
        <ul style={{ margin: 0, paddingLeft: 4, listStyle: "none", lineHeight: 1.9 }}>
          {fields.map((f) => (
            <li key={f.label} style={{ fontSize: font.size.md, color: colors.text }}>
              <span style={{ color: colors.success, marginRight: 8 }}>✓</span>
              {f.label}
              {!f.required && (
                <span style={{ color: colors.textDim, marginLeft: 6 }}>(optional)</span>
              )}
            </li>
          ))}
        </ul>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 4 }}>
          Payout verification is not performed (placeholder for a future step).
        </div>
      </Section>

      <Section title="Submission Status">
        <Badge color={stateColor["PAYMENT_PENDING"]} dot>
          {stateLabel["PAYMENT_PENDING"]}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          Each creator waits here until they submit the form. On submission the
          instance moves to <strong>{stateLabel["PAYMENT_RECEIVED"]}</strong> and
          the workflow continues to the next connected step.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Content Brief form (configurable) — merged post-negotiation node
// ---------------------------------------------------------------------------
// Sends the merged email (finalized offer + secure payout link + campaign brief
// PDF) right after a successful negotiation, then waits for the payout form. The
// brand uploads the Campaign Brief PDF (required to launch) and optionally sets a
// referral link + creator notes here, before launch. The offer fields (fee /
// commission / deliverables) are stamped from the campaign / negotiation config,
// not entered here. The PDF is uploaded to the server's local storage on select;
// only its stored reference + original filename are persisted in node config —
// never the bytes.

function ContentBriefForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: ContentBriefConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [briefFileRef, setBriefFileRef] = useState(config.briefFileRef ?? "");
  const [briefFileName, setBriefFileName] = useState(config.briefFileName ?? "");
  const [creatorNotes, setCreatorNotes] = useState(config.creatorNotes ?? "");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const notesId = useId();

  useEffect(() => {
    setBriefFileRef(config.briefFileRef ?? "");
    setBriefFileName(config.briefFileName ?? "");
    setCreatorNotes(config.creatorNotes ?? "");
    setUploadError(null);
  }, [nodeId]);

  // `over` lets us flush with values that haven't yet round-tripped through state
  // (same idiom as the Follow-Up / Negotiation forms). The manual referralLink
  // field was removed: attribution mints a UNIQUE per-creator tracking link
  // (partnership.ts), delivered in the welcome email — a static brand-typed link
  // here was redundant and tracked nothing. Any legacy saved value is dropped.
  function flush(over?: Partial<ContentBriefConfig>) {
    // Drop any legacy referralLink so re-saving a pre-existing node clears it.
    // The field is gone from ContentBriefConfig, but a config saved before the
    // removal may still carry the key at runtime — strip it via a widened view.
    const { referralLink: _drop, ...rest } = config as Record<string, unknown>;
    onUpdate(nodeId, {
      ...rest,
      briefFileRef,
      briefFileName,
      creatorNotes,
      ...over,
    });
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again re-triggers onChange.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) {
      setUploadError("Please choose a PDF file.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const res = await uploadFile(file);
      setBriefFileRef(res.reference);
      setBriefFileName(res.originalName);
      // Persist immediately (no blur to wait for on a file control).
      flush({ briefFileRef: res.reference, briefFileName: res.originalName });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function removeBrief() {
    setBriefFileRef("");
    setBriefFileName("");
    flush({ briefFileRef: "", briefFileName: "" });
  }

  const hasBrief = !!briefFileRef;

  return (
    <FormStack>
      <InfoBox>
        Runs right after a successful negotiation. Sends the creator{" "}
        <strong>one email</strong> with the finalized offer (fee, commission &
        deliverables), a <strong>secure payout link</strong>, and the{" "}
        <strong>campaign brief PDF</strong> (plus any notes), then waits for them to
        submit their payout details.
      </InfoBox>

      <Section title="Campaign Brief PDF">
        <FormField
          label="Brief document"
          hint="Required to launch. PDF only — attached to the creator's email."
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => void handleFile(e)}
            style={{ display: "none" }}
            aria-label="Upload campaign brief PDF"
          />
          {hasBrief ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
              }}
            >
              <span aria-hidden>📄</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: font.size.md,
                  color: colors.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={briefFileName || "campaign brief"}
              >
                {briefFileName || "campaign-brief.pdf"}
              </span>
              <Badge color={colors.success} dot>
                Uploaded
              </Badge>
            </div>
          ) : (
            <div
              style={{
                fontSize: font.size.sm,
                color: colors.textMuted,
                marginBottom: 6,
              }}
            >
              No file uploaded yet.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : hasBrief ? "Replace PDF" : "Upload PDF"}
            </Button>
            {hasBrief && (
              <Button variant="danger" size="sm" onClick={removeBrief} disabled={uploading}>
                Remove
              </Button>
            )}
          </div>
          {uploadError && (
            <div style={{ fontSize: font.size.sm, color: colors.danger, marginTop: 6 }}>
              {uploadError}
            </div>
          )}
        </FormField>
      </Section>

      <Section title="Creator Notes">
        <FormField
          label="Notes"
          htmlFor={notesId}
          hint="Optional. Appended to the email body for the creator."
        >
          <Textarea
            id={notesId}
            value={creatorNotes}
            onChange={(e) => setCreatorNotes(e.target.value)}
            onBlur={() => flush()}
            rows={5}
            placeholder="e.g. Please tag us in your first post and use the hashtag #campaign."
          />
        </FormField>
      </Section>

      <Section title="Status">
        <Badge color={hasBrief ? stateColor["CONTENT_BRIEF_SENT"] : colors.warning} dot>
          {hasBrief ? "Ready to send on acceptance" : "Brief PDF required"}
        </Badge>
        <div style={{ fontSize: font.size.sm, color: colors.textMuted, marginTop: 8 }}>
          The merged email sends automatically once the negotiation is accepted,
          moving the creator to <strong>{stateLabel["PAYMENT_PENDING"]}</strong>.
          Submitting the payout form then completes the run at{" "}
          <strong>{stateLabel["CONTENT_BRIEF_SENT"]}</strong>.
        </div>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// End node (read-only)
// ---------------------------------------------------------------------------

function EndNodeInfo() {
  return (
    <FormStack>
      <InfoBox>
        Terminal node. Marks a creator as completed and closes the execution instance. No
        configuration needed.
      </InfoBox>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Shared UI atoms (Phase C)
// ---------------------------------------------------------------------------

function FormStack({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          fontSize: font.size.xs,
          fontWeight: font.weight.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          color: colors.textDim,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        fontSize: font.size.sm,
        color: colors.textMuted,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="mono"
      style={{
        fontSize: 10.5,
        background: colors.panelAlt,
        border: `1px solid ${colors.border}`,
        borderRadius: 4,
        padding: "1px 4px",
        color: colors.text,
      }}
    >
      {children}
    </code>
  );
}
