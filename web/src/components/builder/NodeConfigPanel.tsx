import { useState, useEffect, useId } from "react";
import { colors, radii, font } from "../../theme";
import {
  Button,
  Input,
  Textarea,
  Select,
  Toggle,
  Slider,
  FormField,
  IconButton,
  ConfirmDialog,
} from "../ds";
import { nodeLabel, nodeIcon, nodeColor, nodeDescription } from "./nodeMeta";
import type {
  DraftNode,
  InitialOutreachConfig,
  FollowUpConfig,
  ReplyDetectionConfig,
  NegotiationConfig,
} from "../../api/builderTypes";

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
          padding: "14px 18px",
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: font.size.xs,
            color: colors.textDim,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 8,
          }}
        >
          Step Configuration
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: radii.sm,
              background: `${color}1f`,
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
            <div style={{ fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colors.text }}>
              {nodeLabel(node.type)}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: colors.textDim }}>
              {node.id}
            </div>
          </div>
        </div>
        {nodeDescription(node.type) && (
          <div style={{ fontSize: font.size.sm, color: colors.textMuted, lineHeight: 1.5, marginTop: 10 }}>
            {nodeDescription(node.type)}
          </div>
        )}
      </div>

      {/* Config form */}
      <div style={{ flex: 1, overflow: "auto", padding: "18px" }}>
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
        {node.type !== "END" && (
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete step
          </Button>
        )}
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
        <ReplyDetectionForm
          nodeId={node.id}
          config={node.config as ReplyDetectionConfig}
          onUpdate={onUpdate}
        />
      );
    case "NEGOTIATION":
      return (
        <NegotiationForm
          nodeId={node.id}
          config={node.config as NegotiationConfig}
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
        The first email sent to each creator. Supports template variables:{" "}
        <Code>{"{{creatorName}}"}</Code>, <Code>{"{{brandName}}"}</Code>.
      </InfoBox>
      <Section title="Message">
        <FormField label="Subject Line" htmlFor={subjectId}>
          <Input
            id={subjectId}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onBlur={flush}
            invalid={!subject.trim()}
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
            invalid={!body.trim()}
            placeholder="Write your outreach email here…"
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
  const [stopOnReply, setStopOnReply] = useState(config.stopOnReply ?? true);
  const maxId = useId();
  const unitId = useId();
  const bodyId = useId();

  useEffect(() => {
    setIntervals(config.intervals ?? [3]);
    setUnit(config.intervalUnit ?? "days");
    setMaxCount(config.maxCount ?? 2);
    setBody(config.bodyTemplate ?? "");
    setStopOnReply(config.stopOnReply ?? true);
  }, [nodeId]);

  // Same payload shape; `over` lets us flush with values that haven't yet
  // round-tripped through state (replaces the prior setTimeout(flush, 0) hack).
  function flush(over?: Partial<FollowUpConfig>) {
    onUpdate(nodeId, {
      intervals,
      intervalUnit: unit,
      maxCount,
      bodyTemplate: body,
      stopOnReply,
      ...over,
    });
  }

  return (
    <FormStack>
      <InfoBox>
        Sends follow-up emails at configured intervals. Stops when the creator replies (if enabled).
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

        <FormField label="Stop on Reply">
          <Toggle
            checked={stopOnReply}
            onChange={(checked) => {
              setStopOnReply(checked);
              flush({ stopOnReply: checked });
            }}
            label="Cancel scheduled follow-ups once a reply is received"
          />
        </FormField>
      </Section>

      <Section title="Message">
        <FormField label="Follow-Up Body" htmlFor={bodyId} hint="Sent for every follow-up in the cadence.">
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => flush()}
            rows={8}
            invalid={!body.trim()}
            placeholder="Just following up on my previous message…"
          />
        </FormField>
      </Section>
    </FormStack>
  );
}

// ---------------------------------------------------------------------------
// Reply Detection form
// ---------------------------------------------------------------------------

function ReplyDetectionForm({
  nodeId,
  config,
  onUpdate,
}: {
  nodeId: string;
  config: ReplyDetectionConfig;
  onUpdate: (id: string, cfg: Record<string, unknown>) => void;
}) {
  const [threshold, setThreshold] = useState(config.lowConfidenceThreshold ?? 0.7);
  const [manualReview, setManualReview] = useState(config.manualReviewOnLowConfidence ?? true);

  useEffect(() => {
    setThreshold(config.lowConfidenceThreshold ?? 0.7);
    setManualReview(config.manualReviewOnLowConfidence ?? true);
  }, [nodeId]);

  function flush(over?: Partial<ReplyDetectionConfig>) {
    onUpdate(nodeId, {
      lowConfidenceThreshold: threshold,
      manualReviewOnLowConfidence: manualReview,
      ...over,
    });
  }

  return (
    <FormStack>
      <InfoBox>
        AI classifies each reply as Positive, Negative, Question, Opt-Out, or Unknown. Replies below
        the confidence threshold are sent to Manual Review.
      </InfoBox>

      <Section title="Classification">
        <FormField label={`Confidence Threshold · ${Math.round(threshold * 100)}%`}>
          <Slider
            min={0}
            max={100}
            value={Math.round(threshold * 100)}
            aria-label="Confidence threshold percent"
            onChange={(e) => setThreshold(Number(e.target.value) / 100)}
            onMouseUp={() => flush()}
            onTouchEnd={() => flush()}
            minLabel="0% · accept anything"
            maxLabel="100% · very strict"
          />
        </FormField>

        <FormField label="Low-Confidence Behavior">
          <Toggle
            checked={manualReview}
            onChange={(checked) => {
              setManualReview(checked);
              flush({ manualReviewOnLowConfidence: checked });
            }}
            label="Send to Manual Review when confidence is below threshold"
          />
        </FormField>
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
  const [approvalMode, setApprovalMode] = useState<"auto" | "manual">(config.approvalMode ?? "auto");
  const [commissionRate, setCommissionRate] = useState(config.commissionRate ?? 0);
  const minId = useId();
  const maxId = useId();
  const roundsId = useId();
  const modeId = useId();
  const commissionId = useId();

  useEffect(() => {
    setMinBudget(config.minBudget ?? 0);
    setMaxBudget(config.maxBudget ?? 1000);
    setMaxRounds(config.maxRounds ?? 3);
    setApprovalMode(config.approvalMode ?? "auto");
    setCommissionRate(config.commissionRate ?? 0);
  }, [nodeId]);

  // Identical payload: commissionRate only included when > 0.
  function flush(over?: Partial<NegotiationConfig>) {
    const next = {
      minBudget,
      maxBudget,
      maxRounds,
      approvalMode,
      commissionRate,
      ...over,
    };
    const { commissionRate: rate, ...rest } = next;
    onUpdate(nodeId, {
      ...rest,
      ...(rate > 0 ? { commissionRate: rate } : {}),
    });
  }

  const budgetInvalid = maxBudget < minBudget;

  return (
    <FormStack>
      <InfoBox>
        The AI agent negotiates terms within the budget range. Escalates to Manual Review after the
        max rounds limit is reached.
      </InfoBox>

      <Section title="Budget">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <FormField label="Min Budget ($)" htmlFor={minId}>
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
            label="Max Budget ($)"
            htmlFor={maxId}
            error={budgetInvalid ? "Must be ≥ min budget" : undefined}
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
        <FormField label="Approval Mode" htmlFor={modeId}>
          <Select
            id={modeId}
            value={approvalMode}
            onChange={(e) => {
              const next = e.target.value as "auto" | "manual";
              setApprovalMode(next);
              flush({ approvalMode: next });
            }}
          >
            <option value="auto">Auto — AI accepts/rejects within budget</option>
            <option value="manual">Manual — human approves final terms</option>
          </Select>
        </FormField>
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
  return <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          fontSize: font.size.sm,
          fontWeight: font.weight.bold,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          color: colors.textMuted,
          paddingBottom: 8,
          borderBottom: `1px solid ${colors.border}`,
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
        padding: "10px 12px",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        fontSize: font.size.sm,
        color: colors.textMuted,
        lineHeight: 1.55,
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
