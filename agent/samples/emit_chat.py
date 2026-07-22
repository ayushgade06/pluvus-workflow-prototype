"""Chat-style (WhatsApp / Instagram DM) rendering of the sample conversations.

Instead of the stage-by-stage technical breakdown (emit.py), this renders each
conversation as a back-and-forth thread: the creator's message on one side, our
SENT email (the /draft output) on the other — the real conversation as the
creator experiences it. Markdown-friendly so it reads cleanly on GitHub.

Only the AI pass is rendered (the chat is "what we actually send"). Terminal
outcomes (accepted / escalated / opt-out / rejected / max-rounds close) are shown
as a short status line so the thread reads to its natural end.
"""

from __future__ import annotations

from typing import Any

from samples.campaign import (
    CAMPAIGN,
    CREATOR_NAME,
    CREATOR_PLATFORM,
    CREATOR_NICHE,
    Campaign,
)
from samples.conversations import CATEGORY_LABELS, CATEGORY_ORDER
from samples.runner import ConversationResult, PassResult, TurnResult


def _g(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


# ---------------------------------------------------------------------------
# Bubbles
# ---------------------------------------------------------------------------
# GitHub markdown has no real chat bubbles, so we simulate a DM thread with
# blockquotes: a "left" bubble (the creator) and a visually distinct "right"
# bubble (us / the brand), each prefixed with a speaker label + emoji. Multi-line
# bodies stay inside the blockquote.


def _bubble(speaker: str, body: str, *, right: bool) -> str:
    """One chat bubble as a labeled blockquote. `right` = our side (the brand)."""
    label = f"**{speaker}**"
    lines = [f"> {label}", ">"]
    for ln in (body or "").rstrip().split("\n"):
        lines.append("> " + ln if ln else ">")
    _ = right  # label (creator vs brand emoji) distinguishes sides; GH can't right-align
    return "\n".join(lines)


def _creator_bubble(msg: str) -> str:
    return _bubble(f"🧍 {CREATOR_NAME} (creator)", msg, right=False)


def _brand_bubble(subject: str | None, body: str | None) -> str:
    text = ""
    if subject:
        text += f"✉️ Subject: {subject}\n\n"
    text += (body or "").rstrip()
    return _bubble(f"🏃 {CAMPAIGN.brand_name}", text, right=True)


def _status(text: str) -> str:
    return f"<div align=\"center\"><sub>— {text} —</sub></div>"


# ---------------------------------------------------------------------------
# One conversation thread
# ---------------------------------------------------------------------------


def _decision_caption(neg: dict[str, Any] | None) -> str:
    """A tiny grey caption under our reply summarizing what the agent decided —
    optional context so the founder can see the 'why' without leaving chat view."""
    if not neg:
        return ""
    action = (neg.get("action") or "").upper()
    rate = (neg.get("proposedTerms") or {}).get("rate")
    bits = []
    label = {
        "ACCEPT": "✅ accepted",
        "COUNTER": "🔁 countered",
        "PRESENT_OFFER": "📋 presented offer",
        "REJECT": "🚪 declined",
        "ESCALATE": "🧑‍💼 handed to a human",
    }.get(action, action.lower())
    bits.append(label)
    if rate is not None:
        bits.append(f"at ${_g(rate)}")
    pushed = neg.get("pushedFixedTerms") or []
    if pushed:
        bits.append(f"(held fixed: {', '.join(pushed)})")
    return f"<sub>_decision: {' '.join(bits)}_</sub>"


def render_thread(pass_res: PassResult) -> str:
    out: list[str] = []
    for tr in pass_res.turns:
        # Creator's message.
        out.append(_creator_bubble(tr.creator_message))
        out.append("")

        if tr.error:
            out.append(_status(f"⚠️ turn failed: {tr.error}"))
            out.append("")
            continue

        # Our reply — the SENT email (if one was drafted this turn).
        if tr.draft_raw is not None:
            out.append(_brand_bubble(tr.draft_raw.get("subject"), tr.draft_raw.get("body")))
            out.append("")
            cap = _decision_caption(tr.negotiate_raw)
            if cap:
                out.append(cap)
                out.append("")
        elif tr.close_email_body is not None:
            # Deterministic max-rounds close.
            out.append(_brand_bubble(None, tr.close_email_body))
            out.append("")
            out.append(_status("we couldn't agree within the round limit — sent a courteous close"))
            out.append("")
        elif tr.terminal_state == "OPT_OUT":
            out.append(_status("🚫 creator opted out — we stop here (no reply sent, compliance)"))
            out.append("")
        elif tr.terminal_state == "MANUAL_REVIEW":
            reason = (tr.negotiate_raw or {}).get("escalationReason") or "needs a human"
            out.append(_status(f"🧑‍💼 handed to a human — {reason} (no auto-reply sent)"))
            out.append("")
        elif tr.terminal_state == "REJECTED":
            out.append(_status("🚪 conversation closed"))
            out.append("")

    # Final outcome line.
    last = pass_res.turns[-1] if pass_res.turns else None
    if last:
        state = last.terminal_state
        if state == "ACCEPTED":
            out.append(_status("🎉 **DEAL CLOSED** — moves to onboarding / brief"))
        elif state == "MANUAL_REVIEW":
            out.append(_status("⏸️ **ended in manual review** — a human takes over"))
        elif state == "REJECTED":
            out.append(_status("**conversation ended**"))
        elif state == "OPT_OUT":
            out.append(_status("**creator opted out**"))
        out.append("")
    return "\n".join(out)


def render_conversation(res: ConversationResult) -> str:
    conv = res.conversation
    out = [f"### 💬 {conv.title}", "", f"_{conv.summary}_", ""]
    if res.ai.turns:
        out.append(render_thread(res.ai))
    else:
        out.append("_(AI pass not run)_")
    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Standalone (outreach + follow-up) as a one-sided thread
# ---------------------------------------------------------------------------


def render_standalone(
    outreach_ai: dict[str, Any] | None,
    followup_ai: dict[str, Any] | None,
    close_body: str,
) -> str:
    out = ["## 💬 The emails we send on our own (no reply needed)", ""]
    out.append("_First contact, the nudge if they go quiet, and the close if we can't agree._")
    out.append("")

    out.append("**① Outreach — first message**")
    out.append("")
    if outreach_ai:
        out.append(_brand_bubble(outreach_ai.get("subject"), outreach_ai.get("body")))
    else:
        out.append(_status("outreach not generated"))
    out.append("")

    out.append("**② Follow-up — if they don't reply**")
    out.append("")
    if followup_ai:
        out.append(_brand_bubble(followup_ai.get("subject"), followup_ai.get("body")))
    else:
        out.append(_status("follow-up not generated"))
    out.append("")

    out.append("**③ Close — if we can't reach a deal (fixed template)**")
    out.append("")
    out.append(_brand_bubble(None, close_body))
    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Document
# ---------------------------------------------------------------------------


def render_header(campaign: Campaign, meta: dict[str, Any]) -> str:
    c = campaign
    comm = _g(c.commission_rate)
    return "\n".join(
        [
            "# Sample conversations — creator ↔ brand (chat view)",
            "",
            "The same negotiations, shown as a **DM thread** — the creator's messages "
            "and the emails we actually send back, turn by turn, the way the creator "
            "experiences them. A small grey caption under each of our replies notes "
            "what the agent decided.",
            "",
            "> This is the chat-style companion to the detailed stage-by-stage doc. "
            "Read it like a conversation; tell us where the tone/wording should change.",
            "",
            "### The scenario",
            "",
            f"- **Brand:** {c.brand_name} — running-shoe DTC brand.",
            f"- **Creator:** {CREATOR_NAME} ({CREATOR_PLATFORM}, {CREATOR_NICHE}).",
            f"- **Deal:** hybrid — a fixed fee **plus** a fixed **{comm}%** commission. "
            f"Plus {c.reward_description}.",
            f"- **Hidden fee band:** ${_g(c.min_budget)}–${_g(c.max_budget)} "
            f"(the creator never sees this).",
            "",
            "### Run details",
            "",
            f"- **Decision model (classify + negotiate):** `{meta.get('model','?')}`",
            f"- **Copy model (draft):** `{meta.get('draft_model','?')}`",
            f"- **Provider:** `{meta.get('provider','?')}`  ·  **Generated:** {meta.get('generated_at','n/a')}",
            "",
            "---",
            "",
        ]
    )


def render_document(
    campaign: Campaign,
    meta: dict[str, Any],
    outreach_ai: dict[str, Any] | None,
    followup_ai: dict[str, Any] | None,
    close_body: str,
    results: list[ConversationResult],
) -> str:
    doc = [render_header(campaign, meta)]
    doc.append(render_standalone(outreach_ai, followup_ai, close_body))
    doc.append("---")
    doc.append("")

    by_cat: dict[str, list[ConversationResult]] = {}
    for res in results:
        by_cat.setdefault(res.conversation.category, []).append(res)

    for cat in CATEGORY_ORDER:
        rs = by_cat.get(cat) or []
        if not rs:
            continue
        doc.append(f"## {CATEGORY_LABELS.get(cat, cat)}")
        doc.append("")
        for res in rs:
            doc.append(render_conversation(res))
            doc.append("---")
            doc.append("")
    return "\n".join(doc)
