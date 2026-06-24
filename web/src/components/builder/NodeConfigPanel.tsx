import { useState, useEffect } from "react";
import { colors } from "../../theme";
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
}

export function NodeConfigPanel({
  node,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: Props) {
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
            fontSize: 12,
            color: colors.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 4,
          }}
        >
          Node Configuration
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
          {NODE_LABELS[node.type] ?? node.type}
        </div>
        <div style={{ fontSize: 11, color: colors.textDim, marginTop: 2, fontFamily: "monospace" }}>
          {node.id}
        </div>
      </div>

      {/* Config form */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 18px" }}>
        <NodeForm node={node} onUpdate={onUpdate} />
      </div>

      {/* Actions */}
      <div
        style={{
          padding: "12px 18px",
          borderTop: `1px solid ${colors.border}`,
          display: "flex",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <button
          disabled={isFirst}
          onClick={() => onMoveUp(node.id)}
          style={arrowBtnStyle(isFirst)}
          title="Move up"
        >
          ↑ Up
        </button>
        <button
          disabled={isLast}
          onClick={() => onMoveDown(node.id)}
          style={arrowBtnStyle(isLast)}
          title="Move down"
        >
          ↓ Down
        </button>
        <div style={{ flex: 1 }} />
        {node.type !== "END" && (
          <button
            onClick={() => {
              if (window.confirm(`Delete "${NODE_LABELS[node.type] ?? node.type}" node?`)) {
                onDelete(node.id);
              }
            }}
            style={{
              padding: "6px 12px",
              background: "none",
              color: colors.danger,
              border: `1px solid ${colors.danger}`,
              borderRadius: 5,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

const NODE_LABELS: Record<string, string> = {
  INITIAL_OUTREACH: "Initial Outreach",
  FOLLOW_UP: "Follow-Up",
  REPLY_DETECTION: "Reply Detection",
  NEGOTIATION: "Negotiation",
  END: "End",
  IMPORT_CREATOR_LIST: "Import Creators",
};

function arrowBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    background: "none",
    color: disabled ? colors.textDim : colors.textMuted,
    border: `1px solid ${disabled ? colors.border : colors.borderStrong}`,
    borderRadius: 5,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
  };
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
        <FollowUpForm
          nodeId={node.id}
          config={node.config as FollowUpConfig}
          onUpdate={onUpdate}
        />
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
        <div style={{ fontSize: 12, color: colors.textMuted }}>
          No configuration available for this node type.
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

  useEffect(() => {
    setSubject(config.subjectTemplate ?? "");
    setBody(config.bodyTemplate ?? "");
  }, [nodeId, config.subjectTemplate, config.bodyTemplate]);

  function flush() {
    onUpdate(nodeId, {
      ...config,
      subjectTemplate: subject,
      bodyTemplate: body,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <InfoBox>
        The first email sent to each creator. Supports template variables:{" "}
        <code>{"{{creatorName}}"}</code>, <code>{"{{brandName}}"}</code>.
      </InfoBox>
      <Field label="Subject Line">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={flush}
          style={inputStyle}
          placeholder="e.g. Partnership opportunity with {{brandName}}"
        />
      </Field>
      <Field label="Email Body">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={flush}
          rows={10}
          style={{ ...inputStyle, resize: "vertical" }}
          placeholder="Write your outreach email here…"
        />
      </Field>
    </div>
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

  useEffect(() => {
    setIntervals(config.intervals ?? [3]);
    setUnit(config.intervalUnit ?? "days");
    setMaxCount(config.maxCount ?? 2);
    setBody(config.bodyTemplate ?? "");
    setStopOnReply(config.stopOnReply ?? true);
  }, [nodeId]);

  function flush() {
    onUpdate(nodeId, {
      intervals,
      intervalUnit: unit,
      maxCount,
      bodyTemplate: body,
      stopOnReply,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <InfoBox>
        Sends follow-up emails at configured intervals. Stops when the creator replies (if enabled).
      </InfoBox>
      <Field label="Max Follow-Ups">
        <input
          type="number"
          min={1}
          max={5}
          value={maxCount}
          onChange={(e) => setMaxCount(Number(e.target.value))}
          onBlur={flush}
          style={{ ...inputStyle, width: 80 }}
        />
      </Field>
      <Field label="Intervals">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {intervals.map((v, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="number"
                min={1}
                value={v}
                onChange={(e) => {
                  const next = [...intervals];
                  next[i] = Number(e.target.value);
                  setIntervals(next);
                }}
                onBlur={flush}
                style={{ ...inputStyle, width: 60 }}
              />
              {i < intervals.length - 1 && (
                <button
                  onClick={() => {
                    setIntervals(intervals.filter((_, j) => j !== i));
                    setTimeout(flush, 0);
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: colors.danger,
                    cursor: "pointer",
                    fontSize: 14,
                    padding: "0 2px",
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() => {
              setIntervals([...intervals, 3]);
              setTimeout(flush, 0);
            }}
            style={{
              padding: "4px 8px",
              background: "none",
              border: `1px solid ${colors.border}`,
              color: colors.textMuted,
              borderRadius: 4,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            + Add
          </button>
        </div>
      </Field>
      <Field label="Interval Unit">
        <select value={unit} onChange={(e) => { setUnit(e.target.value as "days" | "hours" | "seconds"); flush(); }} style={inputStyle}>
          <option value="seconds">Seconds</option>
          <option value="hours">Hours</option>
          <option value="days">Days</option>
        </select>
      </Field>
      <Field label="Stop on Reply">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={stopOnReply}
            onChange={(e) => { setStopOnReply(e.target.checked); setTimeout(flush, 0); }}
          />
          <span style={{ fontSize: 12, color: colors.textMuted }}>
            Cancel scheduled follow-ups once a reply is received
          </span>
        </label>
      </Field>
      <Field label="Follow-Up Body">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={flush}
          rows={8}
          style={{ ...inputStyle, resize: "vertical" }}
          placeholder="Just following up on my previous message…"
        />
      </Field>
    </div>
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

  function flush() {
    onUpdate(nodeId, {
      lowConfidenceThreshold: threshold,
      manualReviewOnLowConfidence: manualReview,
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <InfoBox>
        AI classifies each reply as: Positive, Negative, Question, Opt-Out, or Unknown.
        Replies below the confidence threshold are sent to Manual Review.
      </InfoBox>
      <Field label={`Confidence Threshold: ${Math.round(threshold * 100)}%`}>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(threshold * 100)}
          onChange={(e) => setThreshold(Number(e.target.value) / 100)}
          onMouseUp={flush}
          onTouchEnd={flush}
          style={{ width: "100%", accentColor: colors.accent }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10.5,
            color: colors.textDim,
            marginTop: 2,
          }}
        >
          <span>0% (accept anything)</span>
          <span>100% (very strict)</span>
        </div>
      </Field>
      <Field label="Low-Confidence Behavior">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={manualReview}
            onChange={(e) => { setManualReview(e.target.checked); setTimeout(flush, 0); }}
          />
          <span style={{ fontSize: 12, color: colors.textMuted }}>
            Send to Manual Review when confidence is below threshold
          </span>
        </label>
      </Field>
    </div>
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

  useEffect(() => {
    setMinBudget(config.minBudget ?? 0);
    setMaxBudget(config.maxBudget ?? 1000);
    setMaxRounds(config.maxRounds ?? 3);
    setApprovalMode(config.approvalMode ?? "auto");
    setCommissionRate(config.commissionRate ?? 0);
  }, [nodeId]);

  function flush() {
    onUpdate(nodeId, {
      minBudget,
      maxBudget,
      maxRounds,
      approvalMode,
      ...(commissionRate > 0 ? { commissionRate } : {}),
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <InfoBox>
        The AI agent negotiates terms within the budget range. Escalates to Manual Review
        after the max rounds limit is reached.
      </InfoBox>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Min Budget ($)">
          <input
            type="number"
            min={0}
            value={minBudget}
            onChange={(e) => setMinBudget(Number(e.target.value))}
            onBlur={flush}
            style={inputStyle}
          />
        </Field>
        <Field label="Max Budget ($)">
          <input
            type="number"
            min={0}
            value={maxBudget}
            onChange={(e) => setMaxBudget(Number(e.target.value))}
            onBlur={flush}
            style={inputStyle}
          />
        </Field>
      </div>
      <Field label="Max Negotiation Rounds">
        <input
          type="number"
          min={1}
          max={10}
          value={maxRounds}
          onChange={(e) => setMaxRounds(Number(e.target.value))}
          onBlur={flush}
          style={{ ...inputStyle, width: 80 }}
        />
      </Field>
      <Field label="Approval Mode">
        <select
          value={approvalMode}
          onChange={(e) => { setApprovalMode(e.target.value as "auto" | "manual"); flush(); }}
          style={inputStyle}
        >
          <option value="auto">Auto — AI accepts/rejects within budget</option>
          <option value="manual">Manual — human approves final terms</option>
        </select>
      </Field>
      <Field label="Commission Rate (%) — 0 for fixed-fee">
        <input
          type="number"
          min={0}
          max={100}
          value={commissionRate}
          onChange={(e) => setCommissionRate(Number(e.target.value))}
          onBlur={flush}
          style={{ ...inputStyle, width: 80 }}
        />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// End node (read-only)
// ---------------------------------------------------------------------------

function EndNodeInfo() {
  return (
    <div>
      <InfoBox>
        Terminal node. Marks a creator as completed and closes the execution instance.
        No configuration needed.
      </InfoBox>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared UI atoms
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 11,
          fontWeight: 600,
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 5,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "8px 12px",
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        fontSize: 11.5,
        color: colors.textMuted,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  background: colors.bg,
  border: `1px solid ${colors.border}`,
  borderRadius: 5,
  color: colors.text,
  fontSize: 12.5,
  outline: "none",
  boxSizing: "border-box",
};
