"""Render captured results into the founder-facing markdown artifact.

Design goals (founder's asks):
  * AI copy and deterministic (template) copy clearly SEPARATED and tagged.
  * The COMPLETE, verbatim response at each stage (/classify, /negotiate, /draft)
    written down — not summarized. Every endpoint response is shown as a
    human-readable email/decision block AND as its raw JSON, so nothing is lost.
  * Grouped by outcome category (succeed / haggle / fail) and by conversation.

Each conversation shows two passes side by side:
  * 🟦 AI pass          — the real endpoints (LLM copy + decision)
  * 🟨 Deterministic    — the mock/template path (rule-based, no LLM)
"""

from __future__ import annotations

import json
from typing import Any

from samples.campaign import (
    CAMPAIGN,
    CREATOR_NAME,
    CREATOR_NICHE,
    CREATOR_PLATFORM,
    Campaign,
)
from samples.conversations import CATEGORY_LABELS, CATEGORY_ORDER
from samples.runner import ConversationResult, PassResult, TurnResult
from samples import templates

AI_TAG = "🟦 **AI-generated**"
DET_TAG = "🟨 **Deterministic (template)**"


# ---------------------------------------------------------------------------
# small formatters
# ---------------------------------------------------------------------------


def _g(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _email_block(subject: str | None, body: str | None) -> str:
    lines = ["```text"]
    if subject:
        lines.append(f"Subject: {subject}")
        lines.append("")
    lines.append((body or "").rstrip())
    lines.append("```")
    return "\n".join(lines)


def _json_block(obj: Any) -> str:
    return "```json\n" + json.dumps(obj, indent=2, ensure_ascii=False) + "\n```"


def _raw_details(title: str, obj: Any) -> str:
    """Collapsible complete-verbatim JSON so the doc shows the FULL response
    without dominating the page."""
    return (
        f"<details><summary>{title} — complete raw response (JSON)</summary>\n\n"
        + _json_block(obj)
        + "\n\n</details>"
    )


# ---------------------------------------------------------------------------
# stage renderers
# ---------------------------------------------------------------------------


def _render_classify(cls: dict[str, Any], is_ai: bool) -> str:
    intent = cls.get("intent")
    conf = cls.get("confidence")
    reasoning = cls.get("reasoning")
    esc = cls.get("escalationReason")
    tag = AI_TAG if is_ai else DET_TAG
    src = "LLM classified" if is_ai else "deterministic gate (no LLM call)"
    out = [f"_{tag} — {src}_", "", f"- **Intent:** `{intent}`  (confidence {conf})"]
    if esc:
        out.append(f"- **Escalation reason:** `{esc}`")
    if reasoning:
        out.append(f"- **Reasoning:** {reasoning}")
    out.append("")
    out.append(_raw_details("`/classify`", cls))
    return "\n".join(out)


def _render_negotiate(neg: dict[str, Any], *, is_ai: bool) -> str:
    action = neg.get("action")
    terms = neg.get("proposedTerms") or {}
    rate = terms.get("rate")
    reasoning = neg.get("reasoning")
    questions = neg.get("creatorQuestions") or []
    pushed = neg.get("pushedFixedTerms") or []
    requested = neg.get("creatorRequestedRate")
    esc = neg.get("escalationReason")
    final = neg.get("isFinalRound")
    response_draft = neg.get("responseDraft")

    tag = AI_TAG if is_ai else DET_TAG
    out = [f"_{tag}_", ""]
    out.append(f"- **Action:** `{action}`" + (f" at **${_g(rate)}**" if rate is not None else ""))
    if requested is not None:
        out.append(f"- **Creator's stated ask (validated):** ${_g(requested)}")
    if reasoning:
        out.append(f"- **Reasoning:** {reasoning}")
    if questions:
        out.append("- **Questions the agent understood:** " + "; ".join(f"“{q}”" for q in questions))
    if pushed:
        out.append("- **Fixed terms the creator pushed on:** " + ", ".join(f"`{p}`" for p in pushed))
    if esc:
        out.append(f"- **Escalation reason:** `{esc}`")
    if final:
        out.append("- **Final round:** yes (email states best-and-final)")
    # The /negotiate candidate reply (discarded in prod — /draft writes the real
    # email — but shown so the founder sees the complete response.)
    if response_draft:
        out.append("")
        out.append("- **`responseDraft`** (the /negotiate candidate reply; note: the SENT "
                   "email is written separately by `/draft`, below):")
        out.append("")
        out.append(_email_block(None, response_draft))
    out.append("")
    out.append(_raw_details("`/negotiate`", neg))
    return "\n".join(out)


def _render_draft(purpose: str | None, draft: dict[str, Any], *, is_ai: bool) -> str:
    tag = AI_TAG if is_ai else DET_TAG
    who = "the email the LLM wrote" if is_ai else "the fixed template email"
    out = [f"_{tag} — {who}, sent to the creator (purpose `{purpose}`)_", ""]
    out.append(_email_block(draft.get("subject"), draft.get("body")))
    out.append("")
    out.append(_raw_details("`/draft`", draft))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# one pass (AI or deterministic) of a conversation
# ---------------------------------------------------------------------------


def _render_pass(pass_res: PassResult, *, is_ai: bool) -> str:
    if not pass_res.turns:
        return "_(not run)_"
    out: list[str] = []
    for i, tr in enumerate(pass_res.turns, start=1):
        out.append(f"##### Turn {i}  ·  negotiation round {tr.round_in}")
        out.append("")
        out.append("**Creator's inbound message**")
        out.append("")
        out.append("> " + tr.creator_message.replace("\n", "\n> "))
        out.append("")
        out.append(f"_Designer intent: {tr.expect}_")
        out.append("")

        if tr.error:
            out.append(f"> ⚠️ **Turn failed:** `{tr.error}`")
            out.append("")
            continue

        step = 1
        # classify
        if tr.classify_raw is not None:
            out.append(f"**Stage {step} — `/classify` (reply classification)**")
            out.append("")
            out.append(_render_classify(tr.classify_raw, tr.classify_is_ai))
            out.append("")
            step += 1
            if tr.terminal_state == "OPT_OUT":
                out.append("**Outcome: `OPT_OUT`** — compliance opt-out; no negotiation, no email.")
                out.append("")
                _emit_notes(out, tr)
                continue
        elif is_ai:
            out.append("_(mid-negotiation reply — skips `/classify`, goes straight to `/negotiate`)_")
            out.append("")
        else:
            out.append("_(the deterministic/mock path has no classifier — classification is an "
                       "AI-only stage; see the AI column)_")
            out.append("")

        # negotiate
        if tr.negotiate_raw is not None:
            out.append(f"**Stage {step} — `/negotiate` (the decision)**")
            out.append("")
            out.append(_render_negotiate(tr.negotiate_raw, is_ai=is_ai))
            out.append("")
            step += 1

        # draft OR terminal
        if tr.draft_raw is not None:
            out.append(f"**Stage {step} — `/draft` (the SENT email)**")
            out.append("")
            out.append(_render_draft(tr.draft_purpose, tr.draft_raw, is_ai=is_ai))
            out.append("")
        elif tr.close_email_body is not None:
            out.append("**Outcome — auto-close (max rounds reached)**")
            out.append("")
            out.append(f"_{DET_TAG} — `negotiation.ts` `sendCloseEmail()` (this close email is "
                       "always deterministic, even on the AI path)_")
            out.append("")
            out.append(_email_block(None, tr.close_email_body))
            out.append("")
        elif tr.terminal_state and tr.terminal_state != "OPT_OUT":
            out.append(f"**Outcome: `{tr.terminal_state}`** — no email drafted this turn.")
            out.append("")

        _emit_notes(out, tr)

        if tr.terminal_state == "ACCEPTED":
            out.append("_Deal **ACCEPTED** → proceeds to the post-acceptance flow (brief / payout)._")
            out.append("")
        elif tr.terminal_state and tr.terminal_state != "OPT_OUT":
            out.append(f"_Conversation ended in **{tr.terminal_state}**._")
            out.append("")
    return "\n".join(out)


def _emit_notes(out: list[str], tr: TurnResult) -> None:
    for n in tr.notes:
        out.append(f"> ℹ️ {n}")
    if tr.notes:
        out.append("")


# ---------------------------------------------------------------------------
# a whole conversation (AI pass then deterministic pass)
# ---------------------------------------------------------------------------


def render_conversation(res: ConversationResult) -> str:
    conv = res.conversation
    out = [f"### {conv.title}", "", f"_{conv.summary}_", ""]

    has_ai = bool(res.ai.turns)
    has_det = bool(res.deterministic.turns)

    if has_ai:
        # Only label it a "pass" when there's also a deterministic pass to contrast.
        if has_det:
            out.append(f"#### {AI_TAG} pass — real endpoints (LLM copy + decision)")
            out.append("")
        out.append(_render_pass(res.ai, is_ai=True))
        out.append("")

    if has_det:
        out.append(f"#### {DET_TAG} pass — mock/template path (rule-based, no LLM)")
        out.append("")
        out.append(_render_pass(res.deterministic, is_ai=False))
        out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# standalone (once-per-campaign) step-level copy
# ---------------------------------------------------------------------------


def render_standalone_block(
    campaign: Campaign,
    outreach_ai: dict[str, Any] | None,
    outreach_template: dict[str, Any],
    followup_template: dict[str, Any],
    close_template_body: str,
    outreach_error: str | None = None,
    *,
    ai_only: bool = False,
    followup_ai: dict[str, Any] | None = None,
    followup_error: str | None = None,
) -> str:
    out = ["## Step-level copy (outreach + follow-up + close)", ""]
    if ai_only:
        out.append(
            "The emails that don't depend on a specific creator reply. Outreach and "
            "follow-up are shown as the **AI** writes them. (Note: today's pipeline "
            "sends a *template* follow-up — the AI follow-up here shows what it could "
            "read like.) The max-rounds close is always a fixed template."
        )
    else:
        out.append(
            "The emails that don't depend on a specific creator reply. Outreach is "
            "shown both ways — the pipeline tries the **AI** draft first and falls "
            "back to the **template**. Follow-up and the max-rounds close are deterministic."
        )
    out.append("")

    # -- outreach --
    out.append("### Outreach email — first contact")
    out.append("")
    out.append(f"#### {AI_TAG} — `/draft` `initial_outreach`")
    out.append("")
    if outreach_ai:
        out.append(_email_block(outreach_ai.get("subject"), outreach_ai.get("body")))
        out.append("")
        out.append(_raw_details("`/draft` initial_outreach", outreach_ai))
    elif outreach_error:
        out.append(f"> ⚠️ AI outreach draft failed: `{outreach_error}`")
    else:
        out.append("> _(not generated)_")
    out.append("")
    if not ai_only:
        out.append(f"#### {DET_TAG} — mock/template `initial_outreach`")
        out.append("")
        out.append(_email_block(outreach_template.get("subject"), outreach_template.get("body")))
        out.append("")

    # -- follow-up --
    out.append("### Follow-up email — sent if the creator doesn't reply")
    out.append("")
    if ai_only:
        out.append(f"#### {AI_TAG} — `/draft` `follow_up`")
        out.append("")
        if followup_ai:
            out.append(_email_block(followup_ai.get("subject"), followup_ai.get("body")))
            out.append("")
            out.append(_raw_details("`/draft` follow_up", followup_ai))
        elif followup_error:
            out.append(f"> ⚠️ AI follow-up draft failed: `{followup_error}`")
        else:
            out.append("> _(not generated)_")
        out.append("")
    else:
        out.append(f"#### {DET_TAG} — mock/template `follow_up`")
        out.append("")
        out.append(_email_block(followup_template.get("subject"), followup_template.get("body")))
        out.append("")

    # -- max-rounds close (always deterministic — no AI version) --
    out.append("### Max-rounds close email — sent when negotiation can't converge")
    out.append("")
    out.append(f"#### {DET_TAG} — `negotiation.ts` `sendCloseEmail()`")
    out.append("")
    out.append(_email_block(None, close_template_body))
    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# header + document
# ---------------------------------------------------------------------------


def render_header(campaign: Campaign, meta: dict[str, Any], *, ai_only: bool = False) -> str:
    c = campaign
    comm = _g(c.commission_rate)
    intro = [
        "# Sample copy — current state of the outreach + negotiation pipeline",
        "",
        "This shows the copy our system generates at **every step** of the creator "
        "outreach + negotiation flow, from real runs. Every stage — **`/classify`**, "
        "**`/negotiate`**, **`/draft`** — is shown, and each response is written out "
        "**in full** (a readable block plus the complete raw JSON in a collapsible "
        "section).",
        "",
    ]
    if ai_only:
        intro += [
            f"All copy here is {AI_TAG} — written by the LLM (which also decides the "
            "number). This is an AI-only sample set.",
            "",
        ]
    else:
        intro += [
            "Two versions of the copy are shown side by side for each conversation:",
            "",
            f"- {AI_TAG} — the real endpoints: the LLM writes the copy (and decides the "
            "number).",
            f"- {DET_TAG} — the rule-based mock/template path: fixed copy, no LLM.",
            "",
        ]
    out = intro + [
        "> Read this to see where we are today, then tell us what *good* looks like — "
        "tone, length, what to say/not say — and we'll tune the prompts and templates "
        "to match.",
        "",
        "### The scenario these samples use",
        "",
        f"- **Brand:** {c.brand_name} — {c.brand_description}",
        f"- **Creator:** {CREATOR_NAME} ({CREATOR_PLATFORM}, {CREATOR_NICHE})",
        f"- **Deal type:** hybrid — a fixed fee **plus** a fixed **{comm}%** commission "
        "on sales the creator drives.",
        f"- **Deliverables:** {c.deliverables}",
        f"- **Timeline:** {c.timeline}",
        f"- **Product perk:** {c.reward_description}",
        f"- **Negotiation band:** fee negotiated within a hidden **${_g(c.min_budget)}–"
        f"${_g(c.max_budget)}** range, up to **{c.max_rounds}** rounds. "
        "(The creator never sees these bounds. An ask above $"
        f"{_g(c.max_budget)} escalates; below ${_g(c.min_budget)} we accept at their price.)",
        "",
        "### Run details",
        "",
        f"- **LLM provider:** `{meta.get('provider', 'unknown')}`  ·  "
        f"**decision model:** `{meta.get('model', 'unknown')}`  ·  "
        f"**copy model:** `{meta.get('draft_model', 'unknown')}`",
        f"- **Negotiation strategy (AI pass):** `{meta.get('strategy', 'unknown')}`",
        f"- **Agent:** `{meta.get('agent_url', 'unknown')}`",
        f"- **Generated:** {meta.get('generated_at', 'n/a')}",
        "",
        "---",
        "",
    ]
    return "\n".join(out)


def render_document(
    campaign: Campaign,
    meta: dict[str, Any],
    standalone_block: str,
    conversation_results: list[ConversationResult],
    *,
    ai_only: bool = False,
) -> str:
    doc = [render_header(campaign, meta, ai_only=ai_only), standalone_block, "---", ""]
    doc.append("## Conversations")
    doc.append("")
    if ai_only:
        doc.append(
            "Grouped by outcome. Each conversation is run through the **AI** endpoints, "
            "showing the complete `/classify`, `/negotiate`, and `/draft` response at "
            "every turn."
        )
    else:
        doc.append(
            "Grouped by outcome. Each conversation is replayed twice — once through the "
            "**AI** endpoints, once through the **deterministic** template path — so you "
            "can compare the two at every turn."
        )
    doc.append("")

    by_cat: dict[str, list[ConversationResult]] = {k: [] for k in CATEGORY_ORDER}
    for res in conversation_results:
        by_cat.setdefault(res.conversation.category, []).append(res)

    for cat in CATEGORY_ORDER:
        results = by_cat.get(cat) or []
        if not results:
            continue
        doc.append(f"## {CATEGORY_LABELS.get(cat, cat)}")
        doc.append("")
        for res in results:
            doc.append(render_conversation(res))
            doc.append("---")
            doc.append("")
    return "\n".join(doc)
