"""CLI: generate the founder-facing sample-copy artifact.

Runs each sample conversation twice — once through the REAL agent endpoints (AI
copy + decision) and once through the deterministic template path (no LLM) — and
writes one markdown artifact with the COMPLETE response at every stage
(/classify, /negotiate, /draft), AI and deterministic clearly separated.

Usage (from agent/):

    # 1) start a FRESH agent on a known-good config (see samples/README.md):
    #    LLM_PROVIDER=openrouter OPENROUTER_MODEL_DRAFT=anthropic/claude-opus-4.8 \
    #      uvicorn app.main:app --port 8003
    #
    # 2) generate the artifact:
    python -m samples --agent-url http://127.0.0.1:8003

    # dry-run (NO network, no cost) — prints the plan:
    python -m samples --dry-run

    # deterministic-only (NO LLM, no cost) — skips the AI endpoints entirely:
    python -m samples --template-only

⚠️  The AI pass calls OpenRouter and costs money (18 conversations × up to ~2
    stages/turn on Opus — potentially a few dollars). Confirm before a paid run.
    --dry-run and --template-only make NO paid LLM calls.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Allow `python -m samples` from agent/ (app + samples are siblings).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from samples.campaign import (  # noqa: E402
    CAMPAIGN,
    CREATOR_NAME,
    CREATOR_NICHE,
    CREATOR_PLATFORM,
)
from samples.client import AgentClient, AgentConnectionError, AgentHTTPError  # noqa: E402
from samples.conversations import ALL_CONVERSATIONS, CATEGORY_LABELS, CATEGORY_ORDER  # noqa: E402
from samples import emit, templates  # noqa: E402
from samples.deterministic import DeterministicProvider  # noqa: E402
from samples.runner import ConversationRunner  # noqa: E402

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "readme_docs" / "SAMPLE_COPY_CURRENT_STATE.md"


def _resolve_meta(agent_url: str) -> dict[str, str]:
    provider = os.getenv("LLM_PROVIDER", "unknown")
    model = os.getenv("OPENROUTER_MODEL") or os.getenv("ANTHROPIC_MODEL") or os.getenv("OLLAMA_MODEL", "unknown")
    draft_model = os.getenv("OPENROUTER_MODEL_DRAFT") or model
    strategy = os.getenv("NEGOTIATION_STRATEGY", "llm")
    return {
        "provider": provider,
        "model": model,
        "draft_model": draft_model,
        "strategy": strategy,
        "agent_url": agent_url,
    }


def _outreach_draft_payload() -> dict:
    """The initial_outreach /draft request the executor sends (band-free context)."""
    c = CAMPAIGN
    return {
        "purpose": "initial_outreach",
        "creatorName": CREATOR_NAME,
        "creatorPlatform": CREATOR_PLATFORM,
        "creatorNiche": CREATOR_NICHE,
        "senderName": c.sender_name,
        "brandDescription": c.brand_description,
        "campaignContext": c.draft_campaign_context(),
        "dealDescription": c.deal_description(),
    }


def _followup_draft_payload() -> dict:
    """The follow_up /draft request. The real pipeline uses a template for this;
    ai-only mode generates the AI version via the _FOLLOWUP_PROMPT (brief nudge,
    no re-pitch). Band-free context, no rate."""
    c = CAMPAIGN
    return {
        "purpose": "follow_up",
        "creatorName": CREATOR_NAME,
        "creatorPlatform": CREATOR_PLATFORM,
        "creatorNiche": CREATOR_NICHE,
        "senderName": c.sender_name,
        "brandDescription": c.brand_description,
        "campaignContext": c.draft_campaign_context(),
        "dealDescription": c.deal_description(),
        "round": 1,
    }


def _template_draft(purpose: str, *, round: int | None = None) -> dict:
    """A deterministic (mock) draft for a standalone purpose."""
    det = DeterministicProvider()
    c = CAMPAIGN
    payload = {
        "purpose": purpose,
        "creatorName": CREATOR_NAME,
        "creatorPlatform": CREATOR_PLATFORM,
        "creatorNiche": CREATOR_NICHE,
        "senderName": c.sender_name,
        "campaignContext": c.mock_campaign_context(),
        "deliverables": c.deliverables,
        "timeline": c.timeline,
        "rewardDescription": c.reward_description,
    }
    if round is not None:
        payload["round"] = round
    return det.draft(payload)


def _plan_text(template_only: bool) -> str:
    passes = "deterministic template ONLY" if template_only else "AI (endpoints) + deterministic (template)"
    lines = [f"DRY RUN - no network calls. Passes: {passes}.", ""]
    lines.append("Standalone copy (once):")
    if not template_only:
        lines.append("  - /draft initial_outreach                 [AI]")
    lines.append("  - outreach / follow-up template            [deterministic]")
    lines.append("  - max-rounds close template                [deterministic]")
    lines.append("")
    n_conv = len(ALL_CONVERSATIONS)
    n_turns = sum(len(c.turns) for c in ALL_CONVERSATIONS)
    lines.append(f"Then {n_conv} conversations (each replayed {'once (template)' if template_only else 'twice: AI + template'}):")
    for cat in CATEGORY_ORDER:
        convs = [c for c in ALL_CONVERSATIONS if c.category == cat]
        lines.append(f"  [{CATEGORY_LABELS[cat]}]")
        for conv in convs:
            lines.append(f"    > {conv.title}  ({len(conv.turns)} turn(s))")
    lines.append("")
    if template_only:
        lines.append("Endpoint calls: 0 (fully deterministic — NO cost).")
    else:
        lines.append(
            f"AI endpoint calls (approx): 1 outreach draft + up to {n_turns} negotiate + "
            f"{n_turns} draft + {n_conv} classify. Cost depends on the model."
        )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass

    ap = argparse.ArgumentParser(prog="samples", description="Generate founder-facing sample copy.")
    ap.add_argument("--agent-url", default=os.getenv("AGENT_URL", "http://127.0.0.1:8003"),
                    help="Base URL of a running agent (default env AGENT_URL or :8003).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output markdown path.")
    ap.add_argument("--dry-run", action="store_true", help="Print the plan, NO network calls (no cost).")
    ap.add_argument("--template-only", action="store_true",
                    help="Only the deterministic path — NO LLM/endpoint calls (no cost).")
    ap.add_argument("--ai-only", action="store_true",
                    help="Only the AI path — skip the deterministic column. Also generates "
                         "an AI follow-up email.")
    ap.add_argument("--chat", action="store_true",
                    help="Render the conversations as a WhatsApp/Insta-style DM thread "
                         "(creator msg + our sent email). Implies --ai-only.")
    ap.add_argument("--only", default=None, help="Comma-separated conversation keys to run.")
    args = ap.parse_args(argv)

    # --chat is a chat-view of what we send → AI path only.
    if args.chat:
        args.ai_only = True

    # A representative 5-case default for a small, cheap AI-only run.
    if args.ai_only and not args.only:
        args.only = "straightforward_accept,multi_round_haggle,present_offer_first,push_commission_then_ultimatum,over_ceiling_firm"

    if args.dry_run:
        print(_plan_text(args.template_only))
        print(f"\nWould write: {args.out}")
        return 0

    run_ai = not args.template_only
    client = AgentClient(args.agent_url)

    if run_ai:
        try:
            health = client.health()
        except Exception as exc:
            print(f"ERROR: agent health check failed at {args.agent_url}/health: {exc}", file=sys.stderr)
            print("Start a fresh agent first (see samples/README.md), or use --template-only.", file=sys.stderr)
            return 2
        print(f"Agent OK at {args.agent_url}: {health}")

    meta = _resolve_meta(args.agent_url)
    if not run_ai:
        meta.update({"provider": "none (template-only)", "model": "n/a", "draft_model": "n/a", "strategy": "n/a"})
    try:
        from datetime import datetime, timezone

        meta["generated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    except Exception:
        meta["generated_at"] = "n/a"

    # ---- standalone copy -------------------------------------------------
    outreach_ai = None
    outreach_error = None
    if run_ai:
        print("Generating outreach email (AI) ...")
        try:
            outreach_ai = client.draft(_outreach_draft_payload())
        except (AgentHTTPError, AgentConnectionError) as exc:
            outreach_error = str(exc)
            print(f"  outreach AI draft failed: {exc}", file=sys.stderr)

    # AI follow-up (ai-only mode): the live pipeline sends a template follow-up,
    # but the founder asked to see the AI version, so generate it via /draft.
    followup_ai = None
    followup_error = None
    if run_ai and args.ai_only:
        print("Generating follow-up email (AI) ...")
        try:
            followup_ai = client.draft(_followup_draft_payload())
        except (AgentHTTPError, AgentConnectionError) as exc:
            followup_error = str(exc)
            print(f"  follow-up AI draft failed: {exc}", file=sys.stderr)

    outreach_template = _template_draft("initial_outreach")
    followup_template = _template_draft("follow_up")
    close_template_body = templates.render(
        templates.MAX_ROUNDS_CLOSE_BODY, creator_name=CREATOR_NAME,
        brand_name=CAMPAIGN.brand_name, sender_name=CAMPAIGN.sender_name,
    )
    standalone_block = emit.render_standalone_block(
        CAMPAIGN, outreach_ai, outreach_template, followup_template,
        close_template_body, outreach_error,
        ai_only=args.ai_only, followup_ai=followup_ai, followup_error=followup_error,
    )

    # ---- conversations ---------------------------------------------------
    runner = ConversationRunner(client)
    run_template = not args.ai_only  # ai-only skips the deterministic column
    only = set(k.strip() for k in args.only.split(",")) if args.only else None
    results = []
    for conv in ALL_CONVERSATIONS:
        if only and conv.key not in only:
            continue
        print(f"[{conv.category}] {conv.title} ({len(conv.turns)} turn(s)) ...")
        res = runner.run(conv, run_ai=run_ai, run_template=run_template)
        if run_ai:
            _log_pass("AI", res.ai)
        if run_template:
            _log_pass("template", res.deterministic)
        results.append(res)

    # ---- write -----------------------------------------------------------
    if args.chat:
        from samples import emit_chat

        doc = emit_chat.render_document(
            CAMPAIGN, meta, outreach_ai, followup_ai, close_template_body, results,
        )
        # Default the chat view to its own file so it doesn't clobber the detailed one.
        if args.out == DEFAULT_OUT:
            args.out = args.out.parent / "SAMPLE_COPY_CHAT.md"
    else:
        doc = emit.render_document(CAMPAIGN, meta, standalone_block, results, ai_only=args.ai_only)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(doc, encoding="utf-8")
    print(f"\nWrote {args.out}  ({len(doc):,} chars)")

    # ---- token usage + Opus cost projection ------------------------------
    # Every endpoint response carries llmUsage.totals (HARD-O1). Sum them across
    # the AI pass and project the OpenRouter/Opus cost from the published rate, so
    # a FREE Ollama run tells us what the paid Opus run would roughly cost.
    if run_ai:
        _report_cost(results, outreach_ai)

    return 0


# OpenRouter/Opus published rate (per app/telemetry price table): $5/MTok in,
# $25/MTok out for anthropic/claude-opus-4.8.
_OPUS_IN_PER_1K = 0.005
_OPUS_OUT_PER_1K = 0.025


def _sum_usage(*raws) -> tuple[int, int, int]:
    """Sum (input, output, calls) from a set of raw endpoint responses' llmUsage."""
    in_t = out_t = calls = 0
    for raw in raws:
        if not isinstance(raw, dict):
            continue
        usage = raw.get("llmUsage")
        if not isinstance(usage, dict):
            continue
        totals = usage.get("totals") or {}
        in_t += int(totals.get("inputTokens") or 0)
        out_t += int(totals.get("outputTokens") or 0)
        calls += int(totals.get("calls") or 0)
    return in_t, out_t, calls


def _report_cost(results, outreach_ai) -> None:
    raws = []
    if outreach_ai:
        raws.append(outreach_ai)
    for res in results:
        for tr in res.ai.turns:
            raws.extend([tr.classify_raw, tr.negotiate_raw, tr.draft_raw])

    in_t, out_t, calls = _sum_usage(*raws)
    total_t = in_t + out_t
    reported = sum(1 for r in raws if isinstance(r, dict) and isinstance(r.get("llmUsage"), dict))
    projected = round(in_t / 1000 * _OPUS_IN_PER_1K + out_t / 1000 * _OPUS_OUT_PER_1K, 4)

    print("\n" + "=" * 64)
    print("TOKEN USAGE  (from this run's llmUsage telemetry)")
    print("=" * 64)
    print(f"  LLM calls (reported): {calls}   ·  responses with usage: {reported}/{len(raws)}")
    print(f"  input tokens : {in_t:,}")
    print(f"  output tokens: {out_t:,}")
    print(f"  total tokens : {total_t:,}")
    print("-" * 64)
    print("PROJECTED cost if this SAME run were on anthropic/claude-opus-4.8")
    print(f"  rate: ${_OPUS_IN_PER_1K*1000:.0f}/MTok in, ${_OPUS_OUT_PER_1K*1000:.0f}/MTok out")
    print(f"  ≈ ${projected:.4f} USD")
    print("=" * 64)
    print("NOTE: token counts come from the model that actually ran (e.g. Ollama/")
    print("qwen). Opus uses a different tokenizer, so treat this as a BALLPARK —")
    print("Opus prompts tokenize slightly differently and it may write longer copy.")
    if reported < len(raws):
        print(f"WARN: {len(raws) - reported} response(s) had no usage telemetry; the")
        print("      real total is higher than shown.")


def _log_pass(label: str, pass_res) -> None:
    for i, tr in enumerate(pass_res.turns, 1):
        act = (tr.negotiate_raw or {}).get("action") if tr.negotiate_raw else None
        state = tr.terminal_state or "continue"
        flag = f" ERROR={tr.error}" if tr.error else ""
        print(f"    [{label}] turn {i}: action={act} state={state}{flag}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
