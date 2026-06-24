// ---------------------------------------------------------------------------
// MessageThread — the full creator conversation (Part 6).
// ---------------------------------------------------------------------------
// Outbound messages align left with one accent; inbound align right with
// another. Inbound replies show the classified intent + confidence; outbound
// negotiation messages show the round.

import type { MessageDTO, ReplyIntent } from "../api/types";
import { colors, formatTimestamp } from "../theme";
import { Empty } from "./ui";

const intentColor: Record<ReplyIntent, string> = {
  POSITIVE: "#3fb950",
  NEGATIVE: "#f85149",
  QUESTION: "#58a6ff",
  OPT_OUT: "#db6d28",
  UNKNOWN: "#d29922",
};

export function MessageThread({ messages }: { messages: MessageDTO[] }) {
  if (messages.length === 0) return <Empty>No messages exchanged yet.</Empty>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {messages.map((m) => (
        <Bubble key={m.id} m={m} />
      ))}
    </div>
  );
}

function Bubble({ m }: { m: MessageDTO }) {
  const outbound = m.direction === "OUTBOUND";
  const accent = outbound ? colors.accentDim : "#2ea043";
  const ts = m.sentAt ?? m.receivedAt ?? m.createdAt;

  return (
    <div style={{ display: "flex", justifyContent: outbound ? "flex-start" : "flex-end" }}>
      <div
        style={{
          maxWidth: "88%",
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderLeft: outbound ? `3px solid ${accent}` : `1px solid ${colors.border}`,
          borderRight: outbound ? `1px solid ${colors.border}` : `3px solid ${accent}`,
          borderRadius: 8,
          padding: "9px 11px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: accent, textTransform: "uppercase" }}>
            {outbound ? "Outbound" : "Inbound"}
          </span>
          {m.negotiationRound !== null && (
            <span style={{ fontSize: 10, color: colors.textDim }}>round {m.negotiationRound}</span>
          )}
          {m.replyIntent && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 600,
                color: intentColor[m.replyIntent],
                background: `${intentColor[m.replyIntent]}1a`,
                border: `1px solid ${intentColor[m.replyIntent]}55`,
                borderRadius: 4,
                padding: "0 5px",
              }}
            >
              {m.replyIntent}
              {m.classifyConfidence !== null ? ` ${(m.classifyConfidence * 100).toFixed(0)}%` : ""}
            </span>
          )}
        </div>
        {m.subject && (
          <div style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
            {m.subject}
          </div>
        )}
        <div style={{ fontSize: 12, color: colors.textMuted, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
          {m.body}
        </div>
        <div style={{ fontSize: 10, color: colors.textDim, marginTop: 6 }}>{formatTimestamp(ts)}</div>
      </div>
    </div>
  );
}
