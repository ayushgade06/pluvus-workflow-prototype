// ---------------------------------------------------------------------------
// LandingPage — the marketing surface, in the Tano editorial / neo-brutalist
// language: cream (or warm-dark) canvas, big serif headlines, a hand-drawn
// coral underline, pill CTAs, and candy-coloured sticker cards that float with
// hard offset shadows. Copy is Pluvus's own (creator-partnership automation).
// Pure presentation; the CTAs route into the app via the props.
// ---------------------------------------------------------------------------
import { ArrowRight, Sparkles, Users, MessagesSquare, FileText, TrendingUp } from "lucide-react";
import { colors, accents, radii, font, shadow } from "../theme";

interface Props {
  onEnterApp: () => void;
  onOpenObservability: () => void;
}

export function LandingPage({ onEnterApp, onOpenObservability }: Props) {
  return (
    <div className="ds-fade-in" style={{ height: "100%", overflow: "auto", background: colors.bg }}>
      <div style={{ maxWidth: 1120, margin: "0 auto", padding: "40px 32px 72px" }}>
        <Hero onEnterApp={onEnterApp} onOpenObservability={onOpenObservability} />
        <WhatWeDo />
        <Receipts />
      </div>
    </div>
  );
}

// -- Hero --------------------------------------------------------------------

function Hero({ onEnterApp, onOpenObservability }: Props) {
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)",
        gap: 40,
        alignItems: "center",
        padding: "24px 0 56px",
      }}
    >
      <div>
        <Eyebrow icon={<Sparkles size={13} strokeWidth={2.5} />}>Agentic creator outreach</Eyebrow>
        <h1
          className="serif"
          style={{
            fontSize: 56,
            fontWeight: font.weight.black,
            letterSpacing: -1.6,
            lineHeight: 1.02,
            color: colors.text,
            margin: "18px 0 0",
          }}
        >
          Your creator engine,{" "}
          <span style={{ position: "relative", whiteSpace: "nowrap" }}>
            run end-to-end
            <Underline />
          </span>
          .
        </h1>
        <p
          style={{
            fontSize: 18,
            lineHeight: 1.55,
            color: colors.textMuted,
            margin: "22px 0 0",
            maxWidth: 480,
          }}
        >
          Pluvus sources creators, drafts the outreach, negotiates the deal inside your
          budget, and hands off a ready-to-run partnership — so you scale campaigns without
          scaling headcount.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
          <PillButton onClick={onEnterApp} accent={colors.accent} textColor="#fff">
            Build a campaign
            <ArrowRight size={16} strokeWidth={2.5} />
          </PillButton>
          <PillButton onClick={onOpenObservability} accent={colors.panel} textColor={colors.text}>
            See it running
          </PillButton>
        </div>
      </div>

      {/* Floating candy stat cards */}
      <div style={{ position: "relative", minHeight: 320 }}>
        <FloatCard
          accent={accents.butter}
          rotate={-3}
          style={{ top: 0, left: 8, width: 214 }}
          kicker="Reply handling"
          metric="24h"
          caption="AI classifies + drafts every reply, day or night."
        />
        <FloatCard
          accent={accents.mint}
          rotate={2.5}
          style={{ top: 118, right: 0, width: 226 }}
          kicker="On-budget deals"
          metric="100%"
          caption="Negotiation stays inside the floor and ceiling you set."
        />
        <FloatCard
          accent={accents.pink}
          rotate={-1.5}
          style={{ top: 232, left: 32, width: 208 }}
          kicker="Hands-off"
          metric="1 op"
          caption="A single operator runs the whole pipeline."
        />
      </div>
    </section>
  );
}

// -- What we do --------------------------------------------------------------

const CAPABILITIES: { n: string; title: string; body: string; accent: string; icon: React.ReactNode }[] = [
  {
    n: "01",
    title: "Sourcing & Outreach",
    body: "Import a creator list and let Pluvus send a personalised first email to each, then follow up on a schedule until they reply.",
    accent: accents.coral,
    icon: <Users size={18} strokeWidth={2.25} />,
  },
  {
    n: "02",
    title: "Reply Detection",
    body: "Every inbound reply is classified — interested, a question, a hard no, an opt-out — and routed automatically, escalating only when it needs a human.",
    accent: accents.butter,
    icon: <MessagesSquare size={18} strokeWidth={2.25} />,
  },
  {
    n: "03",
    title: "AI Negotiation",
    body: "The agent negotiates rate and terms within your budget band, answers the creator's questions, and closes the deal — or escalates cleanly if it can't.",
    accent: accents.mint,
    icon: <TrendingUp size={18} strokeWidth={2.25} />,
  },
  {
    n: "04",
    title: "Deal Handoff",
    body: "On agreement, Pluvus sends the finalised offer, a secure payout link, and the campaign brief in one email, then hands a ready partnership to your team.",
    accent: accents.lavender,
    icon: <FileText size={18} strokeWidth={2.25} />,
  },
];

function WhatWeDo() {
  return (
    <section style={{ padding: "16px 0 56px" }}>
      <Eyebrow icon={<Sparkles size={13} strokeWidth={2.5} />}>What Pluvus does</Eyebrow>
      <h2
        className="serif"
        style={{
          fontSize: 38,
          fontWeight: font.weight.black,
          letterSpacing: -1,
          lineHeight: 1.05,
          color: colors.text,
          margin: "14px 0 30px",
          maxWidth: 620,
        }}
      >
        One operator, a squad of AI agents.
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 18 }}>
        {CAPABILITIES.map((c) => (
          <div
            key={c.n}
            style={{
              background: c.accent,
              border: `2px solid ${colors.cardBorder}`,
              borderRadius: radii.lg,
              boxShadow: shadow.md,
              padding: "22px 24px 24px",
              color: "#141210",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span
                className="serif"
                style={{ fontSize: 30, fontWeight: font.weight.black, letterSpacing: -1, color: "#141210" }}
              >
                {c.n}
              </span>
              <span
                aria-hidden
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: "rgba(20,18,16,0.10)",
                  border: `1.5px solid #141210`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#141210",
                }}
              >
                {c.icon}
              </span>
            </div>
            <h3
              style={{
                fontSize: 19,
                fontWeight: font.weight.bold,
                letterSpacing: -0.3,
                margin: "16px 0 8px",
                color: "#141210",
              }}
            >
              {c.title}
            </h3>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "rgba(20,18,16,0.72)", margin: 0 }}>{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// -- Receipts / stats --------------------------------------------------------

const RECEIPTS: { metric: string; label: string; accent: string }[] = [
  { metric: "16", label: "lifecycle states tracked per creator, live", accent: accents.sky },
  { metric: "6", label: "reply intents classified automatically", accent: accents.coral },
  { metric: "2", label: "negotiation rounds before a clean escalation", accent: accents.mint },
  { metric: "1", label: "email closes the deal — offer, payout link & brief", accent: accents.butter },
];

function Receipts() {
  return (
    <section style={{ padding: "16px 0 24px" }}>
      <Eyebrow icon={<TrendingUp size={13} strokeWidth={2.5} />}>The receipts</Eyebrow>
      <h2
        className="serif"
        style={{
          fontSize: 34,
          fontWeight: font.weight.black,
          letterSpacing: -0.8,
          lineHeight: 1.05,
          color: colors.text,
          margin: "14px 0 28px",
        }}
      >
        Built to run, not to demo.
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
        {RECEIPTS.map((r, i) => (
          <div
            key={i}
            style={{
              background: colors.panel,
              border: `2px solid ${colors.cardBorder}`,
              borderRadius: radii.md,
              boxShadow: shadow.sm,
              padding: "20px 20px 22px",
            }}
          >
            <div style={{ width: 34, height: 6, borderRadius: 3, background: r.accent, border: `1.5px solid ${colors.cardBorder}`, marginBottom: 14 }} />
            <div
              className="serif nums"
              style={{ fontSize: 40, fontWeight: font.weight.black, letterSpacing: -1.4, lineHeight: 1, color: colors.text }}
            >
              {r.metric}
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: colors.textMuted, margin: "10px 0 0" }}>{r.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// -- Small building blocks ---------------------------------------------------

function Eyebrow({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "4px 12px",
        background: colors.panel,
        border: `2px solid ${colors.cardBorder}`,
        borderRadius: radii.pill,
        boxShadow: shadow.sm,
        fontSize: font.size.xs,
        fontWeight: font.weight.bold,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        color: colors.text,
      }}
    >
      {icon && <span style={{ color: colors.accent, display: "inline-flex" }}>{icon}</span>}
      {children}
    </span>
  );
}

// Hand-drawn coral underline under the highlighted hero word.
function Underline() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 300 16"
      preserveAspectRatio="none"
      style={{ position: "absolute", left: 0, right: 0, bottom: -6, width: "100%", height: 12 }}
    >
      <path
        d="M3 11 C 70 4, 150 4, 297 9"
        fill="none"
        stroke={colors.accent}
        strokeWidth={5}
        strokeLinecap="round"
      />
    </svg>
  );
}

function PillButton({
  children,
  onClick,
  accent,
  textColor,
}: {
  children: React.ReactNode;
  onClick: () => void;
  accent: string;
  textColor: string;
}) {
  return (
    <button
      onClick={onClick}
      className="ds-focusable ds-btn"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "0 24px",
        height: 46,
        borderRadius: radii.pill,
        border: `2px solid ${colors.cardBorder}`,
        background: accent,
        color: textColor,
        fontSize: 15,
        fontWeight: font.weight.semibold,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function FloatCard({
  accent,
  rotate,
  style,
  kicker,
  metric,
  caption,
}: {
  accent: string;
  rotate: number;
  style: React.CSSProperties;
  kicker: string;
  metric: string;
  caption: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        background: accent,
        border: `2px solid ${colors.cardBorder}`,
        borderRadius: radii.lg,
        boxShadow: shadow.lg,
        padding: "16px 18px 18px",
        transform: `rotate(${rotate}deg)`,
        color: "#141210",
        ...style,
      }}
    >
      <div
        style={{
          fontSize: font.size.xs,
          fontWeight: font.weight.bold,
          textTransform: "uppercase",
          letterSpacing: 0.7,
          color: "rgba(20,18,16,0.65)",
        }}
      >
        {kicker}
      </div>
      <div
        className="serif nums"
        style={{ fontSize: 40, fontWeight: font.weight.black, letterSpacing: -1.2, lineHeight: 1.05, margin: "6px 0 8px", color: "#141210" }}
      >
        {metric}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.45, color: "rgba(20,18,16,0.72)" }}>{caption}</div>
    </div>
  );
}
