"""
30-case SUBSET runner — the cost-efficient way to validate a hosted model (Opus).

The full 500-case bank exists to shake out failures on a WEAK model (qwen3:8b),
where ~470 already pass. Re-running all 500 on a premium hosted model pays a lot
to confirm the safe direction. This subset carries the actual signal for a
stronger model at a fraction of the cost:

  * FAILED / high-signal cases (15) — the cases qwen3:8b did NOT clear, so the
    "a stronger model is expected to clear this" predictions become MEASURED:
    the strict ESCALATE-only escalate cases (equity / legal / hostile / advance /
    exclusivity-buyout stacks), the flip-flop conversation, and an answerable miss.
  * SMOKE cases (15) — one of every decision type (accept, below-floor, discovery,
    over-ceiling via escalate, multi-question, deferred, unrelated, opt-out,
    negative, injection, fixed-term, 3 classify intents, a converge conversation).
    Catches a model-specific regression (format drift breaking JSON, over-chatty
    output) without the full-bank spend.

Handles all three case shapes: single-turn (/negotiate + optional /draft, scored
by run_eval.check_case), classify (/classify, intent == expect_intent), and
conversation (multi-turn /negotiate replayed with executor-fidelity history and
the same 8 arc checkers as conversations_live.py).

Run (free, local qwen on :8002):
  AGENT_URL=http://127.0.0.1:8002 TIMEOUT_S=180 python subset_live.py

Run against a hosted model later: point the agent's LLM_PROVIDER/model env at it,
restart the agent, then run this exact command. Same harness, ~30 calls.

Cost: pass observed/estimated token rates to print a $ estimate per-case and total
(defaults are conservative Opus 4.x list prices; override via env — see COST).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))                      # dataset_500
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))     # negotiation_eval (run_eval)

import run_eval  # noqa: E402
import loader     # noqa: E402

# run_eval ships a small LEGACY ASSERTS/BAND; the dataset_500 asserts live in
# loader. audit_live.py monkeypatches these before check_case — mirror it or every
# single-turn case scores "N/A".
run_eval.ASSERTS = loader.ASSERTS
run_eval.BAND = loader.BAND

# ---------------------------------------------------------------------------
# Cost model (override any via env). Opus 4.x list prices as a conservative
# default: $15 / 1M input tokens, $75 / 1M output tokens. A hosted call also pays
# for the FULL prompt each turn (system + rules + history + reply); we estimate
# input/output tokens per call from the actual request/response sizes (chars/4),
# so the $ figure tracks the real payload rather than a flat guess.
# ---------------------------------------------------------------------------
COST_IN_PER_MTOK = float(os.getenv("COST_IN_PER_MTOK", "15"))
COST_OUT_PER_MTOK = float(os.getenv("COST_OUT_PER_MTOK", "75"))
CHARS_PER_TOKEN = 4.0  # rough English proxy; good enough for a planning estimate


def _toks(obj) -> int:
    """Rough token count of a JSON-serializable payload (chars / 4)."""
    if obj is None:
        return 0
    if isinstance(obj, str):
        s = obj
    else:
        s = json.dumps(obj, ensure_ascii=False)
    return int(len(s) / CHARS_PER_TOKEN)


def _cost(in_tok: int, out_tok: int) -> float:
    return (in_tok * COST_IN_PER_MTOK + out_tok * COST_OUT_PER_MTOK) / 1_000_000.0


# ---------------------------------------------------------------------------
# The 30 IDs — a STRICT split (see EVAL_SUBSET_30.md §"strict principle").
#
#   FAILED (15) — cases qwen3:8b GENUINELY FAILS on its CURRENT behavior and that
#     are NOT already code-fixed. A case that passes on qwen would also pass on a
#     stronger model, so running it on Opus buys nothing — it is excluded on
#     principle. Every id here is verified against the saved live results
#     (escalate: audit_live_results_escalate_v2.json 14/40 fail; conversation:
#     audit_live_results.json). These are the "weak model fails / strong model
#     should pass" cases — the whole reason to spend on Opus.
#       * The 14 escalate fails: qwen under-reasons about WHEN to route a legal /
#         equity / advance / hostile / scope-blowup demand to a human. All are
#         strict ESCALATE-only (COUNTER is not an allowed answer). Opus is expected
#         to escalate correctly — this measures that.
#       * conv-flip-flops-interest: qwen read a transient "maybe another time" as a
#         terminal reject and gave up; Opus is expected to hold through the
#         hot-cold-hot swing and converge.
#
#   SMOKE (15) — cases qwen PASSES today, one per decision type. Purpose is the
#     OPPOSITE: catch a regression a STRONGER model could introduce (JSON-format
#     drift, over-chatty output breaking the parser, revealing the hidden floor/
#     ceiling). A FAIL here on Opus is a real red flag. (Several — A-14/A-53 — were
#     pre-fix fails earlier this session but PASS on current qwen after the money
#     fixes, so they are legitimate qwen-passers now.)
# ---------------------------------------------------------------------------

# FAILED single-turn (14 escalate — all verified qwen fails, all ESCALATE-only):
FAILED_SINGLE = [
    "F-10-exclusivity-payment-demand",
    "F-11-equity-stake-ask",
    "F-13-lawyer-review-contract",
    "F-14-threaten-legal-action",
    "F-15-remove-usage-rights-entirely",
    "F-16-massive-scope-blowup",
    "F-17-hostile-insulting",
    "F-23-commission-to-40-percent",
    "F-24-commission-only-huge",
    "F-27-perpetual-buyout-only",
    "F-28-demand-competitor-kill-fee",
    "F-29-threatens-public-callout",
    "F-32-advance-plus-per-diem",
    "F-36-hostile-you-people",
]
# SMOKE single-turn (10 — one per decision type; all pass on current qwen):
SMOKE_SINGLE = [
    "A-01-rate-discovery-whats-budget",          # rate discovery -> present offer
    "A-14-in-band-proposal-usually-charge-280",  # in-band accept (post-fix passer)
    "A-53-below-floor-just-150",                 # below-floor -> accept at floor (post-fix passer)
    "B-01-usage-rights-plus-payment-timing",     # multi-question (answer every part)
    "D-01-exact-launch-date",                    # deferred (honest defer, no fabrication)
    "E-01-career-growth-advice",                 # unrelated (stay on the deal)
    "H-01-bump-commission-to-fifteen",           # fixed-term push (hold at 10%)
    "F-optout-01-plain-unsubscribe",             # opt-out (never keep selling)
    "F-negative-01-too-busy-this-quarter",       # genuine decline
    "F-inject-01-ignore-and-accept-2000",        # injection (neutralized/escalated)
]
# FAILED conversation (1 — verified un-fixed qwen behavior fail):
FAILED_CONV = [
    "conv-flip-flops-interest",
]
# SMOKE conversation (1 — a clean arc qwen passes; the fail-set conv already
# exercises multi-turn, so one smoke arc is enough to reach exactly 30):
SMOKE_CONV = [
    "conv-gradual-concession-into-band",   # a clean converge-in-band arc
]
# Classify: bank was 40/40 on qwen — NO residuals, so classify is smoke-only. Four
# intents covered to catch an Opus format/label regression (dropped UNKNOWN to
# land on exactly 30; the four kept are the ones that drive a state transition).
FAILED_CLASSIFY = []
SMOKE_CLASSIFY = [
    "CL-01-pos-interested-warm",  # POSITIVE
    "CL-19-neg-no-footwear",      # NEGATIVE (a real refusal, not a bare rate)
    "CL-21-q-whats-the-budget",   # QUESTION
    "CL-??-optout",              # placeholder resolved below to a real OPT_OUT id
]

# ---------------------------------------------------------------------------
# Arc checkers for conversations — reuse conversations_live.py wholesale.
# ---------------------------------------------------------------------------
import conversations_live as convmod  # noqa: E402


def run_single(case):
    req = run_eval.build_request(case)
    status, resp, dt, err = run_eval.post("/negotiate", req)
    in_tok = _toks(req)
    if err or not isinstance(resp, dict):
        return "ERROR", f"{err} (status {status})", in_tok, 0, dt
    out_tok = _toks(resp)
    action = (resp.get("action") or "").upper()
    rate = (resp.get("proposedTerms") or {}).get("rate")
    cqs = resp.get("creatorQuestions") or []
    pfts = resp.get("pushedFixedTerms") or []
    # Mirror the executor: rate-bearing actions also draft an email (real cost).
    draft = run_eval.call_draft(action, rate, case["reply"], None, cqs, pfts)
    if draft and not draft.get("err"):
        in_tok += _toks(draft.get("_prompt")) if draft.get("_prompt") else _toks(case["reply"]) + 400
        out_tok += _toks((draft.get("subject") or "") + (draft.get("body") or ""))
    verdict, fails = run_eval.check_case(case["id"], action, rate, cqs, pfts, draft)
    note = f"{action}@{rate}" + ("" if verdict == "PASS" else "  <- " + "; ".join(fails))
    return verdict, note, in_tok, out_tok, dt


def run_classify(case):
    payload = {"message": case["message"]}
    status, resp, dt, err = run_eval.post("/classify", payload)
    in_tok = _toks(payload) + 300  # classify prompt overhead
    if err or not isinstance(resp, dict) or "intent" not in resp:
        return "ERROR", f"{err} (status {status})", in_tok, 0, dt
    out_tok = _toks(resp)
    got = resp.get("intent")
    ok = got == case["expect_intent"]
    return ("PASS" if ok else "FAIL"), f"{got} (expect {case['expect_intent']})", in_tok, out_tok, dt


def run_conv(case):
    # conversations_live.run_conversation already replays the arc and scores it; we
    # re-run it here but also tally tokens by summing each turn's request/response.
    verdict, why, trace = convmod.run_conversation(case)
    in_tok = sum(_toks(t.get("creator", "")) + 1500 for t in trace)  # +prompt/history per turn
    out_tok = sum(300 for _ in trace)
    return verdict, why, in_tok, out_tok, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="don't call the model; just print the 30-case plan + cost estimate")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    # Resolve the OPT_OUT classify placeholder to a real id.
    optout_ids = [c["id"] for c in loader.CLASSIFY_CASES if c["expect_intent"] == "OPT_OUT"]
    if "CL-??-optout" in SMOKE_CLASSIFY and optout_ids:
        SMOKE_CLASSIFY[SMOKE_CLASSIFY.index("CL-??-optout")] = optout_ids[0]

    single_ids = FAILED_SINGLE + SMOKE_SINGLE
    classify_ids = FAILED_CLASSIFY + SMOKE_CLASSIFY
    conv_ids = FAILED_CONV + SMOKE_CONV

    by_id_single = {c["id"]: c for c in loader.CASES}
    by_id_classify = {c["id"]: c for c in loader.CLASSIFY_CASES}
    by_id_conv = {c["id"]: c for c in loader.CONVERSATIONS}

    plan = []
    for i in single_ids:
        plan.append(("single", by_id_single.get(i), i, i in FAILED_SINGLE))
    for i in classify_ids:
        plan.append(("classify", by_id_classify.get(i), i, i in FAILED_CLASSIFY))
    for i in conv_ids:
        plan.append(("conv", by_id_conv.get(i), i, i in FAILED_CONV))

    missing = [i for _, c, i, _ in plan if c is None]
    if missing:
        print("MISSING ids (fix the subset list):", missing, flush=True)
        return 2

    total = len(plan)
    url = os.getenv("AGENT_URL", "http://127.0.0.1:8001")
    print(f"Subset: {total} cases ({len(FAILED_SINGLE)+len(FAILED_CLASSIFY)+len(FAILED_CONV)} failed/high-signal, "
          f"{total - (len(FAILED_SINGLE)+len(FAILED_CLASSIFY)+len(FAILED_CONV))} smoke)  |  agent {url}")
    print(f"Cost model: ${COST_IN_PER_MTOK}/M in, ${COST_OUT_PER_MTOK}/M out\n", flush=True)

    if args.dry_run:
        print("DRY RUN — plan only (no model calls):")
        for kind, c, i, failed in plan:
            print(f"  [{'FAIL-SET' if failed else 'smoke'}] {kind:8} {i}")
        print(f"\n{total} cases planned. Run without --dry-run to execute + measure real cost.")
        return 0

    passed = failed = errored = 0
    tot_in = tot_out = 0.0
    rows = []
    for kind, c, i, is_failset in plan:
        if kind == "single":
            v, note, it, ot, dt = run_single(c)
        elif kind == "classify":
            v, note, it, ot, dt = run_classify(c)
        else:
            v, note, it, ot, dt = run_conv(c)
        tot_in += it
        tot_out += ot
        case_cost = _cost(it, ot)
        rows.append((v, kind, i, note, it, ot, case_cost, dt))
        if v == "PASS":
            passed += 1
        elif v == "ERROR":
            errored += 1
        else:
            failed += 1
        dts = f"{dt:.0f}s" if dt is not None else "multi"
        print(f"  [{v:5}] {kind:8} {i}: {note}  | ~{it}in/{ot}out tok  ${case_cost:.4f}  ({dts})", flush=True)

    total_cost = _cost(int(tot_in), int(tot_out))
    print("\n" + "=" * 70)
    print(f"RESULT: {passed} PASS / {failed} FAIL / {errored} ERROR  of {total}")
    print(f"TOKENS: ~{int(tot_in):,} input + ~{int(tot_out):,} output")
    print(f"COST (at ${COST_IN_PER_MTOK}/M in, ${COST_OUT_PER_MTOK}/M out):")
    print(f"   per case (avg): ${total_cost/total:.4f}")
    print(f"   all {total} cases: ${total_cost:.2f}")
    print("=" * 70)
    return 0 if errored == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
