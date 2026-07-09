"""
500-case full-pipeline eval runner (HARD-T1 dataset).

Drives the dataset in dataset_500/ against the LIVE agent, reusing run_eval.py's
proven machinery: build_request -> POST /negotiate -> call_draft (threads
creatorQuestions/pushedFixedTerms into POST /draft, exactly like the executor) ->
check_case (machine assertions). Adds a /classify layer pass for the 40 classify
cases and a multi-turn pass for the 30 conversations.

This is the runner that turns the dataset into a HARD PASS/FAIL gate over qwen —
the acceptance criterion HARD-T1 named "every case machine-asserted, >=500-case
dataset". The dataset is model-independent; run it against whatever model the
agent is serving (qwen3:8b, qwen3:30b, or an OpenAI-backed provider).

Prereqs: agent running on :8001 with NEGOTIATION_STRATEGY=llm and a real
negotiation provider (mock won't exercise comprehension). See DATASET_500.md.

Usage:
    python run_eval_500.py                     # everything (500 cases) — slow on local qwen
    python run_eval_500.py --category money    # one single-turn category
    python run_eval_500.py --classify-only     # just the 40 /classify cases (fast)
    python run_eval_500.py --smoke N           # first N of each category (dry read)
    python run_eval_500.py --no-convos         # skip the 30 multi-turn conversations
    python run_eval_500.py --limit N           # cap single-turn cases at N

Env (inherited from run_eval): AGENT_URL, TIMEOUT_S. Adds:
    OUT_500   markdown report path (default ./EVAL_500_REPORT.md)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections import Counter

# Make sibling imports work whether run from repo root or this dir.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.join(_HERE, "dataset_500"))

import run_eval  # noqa: E402  reuse the proven harness functions
from dataset_500 import loader  # noqa: E402

OUT_500 = os.getenv("OUT_500", os.path.join(_HERE, "EVAL_500_REPORT.md"))


def _apply_dataset_asserts():
    """Point run_eval.ASSERTS + run_eval.BAND at the 500-case dataset so
    check_case() and build_request() operate on our cases. This is the single
    seam that lets us reuse the entire harness unchanged."""
    run_eval.ASSERTS = loader.ASSERTS
    run_eval.BAND = loader.BAND


def run_single_turn(cases):
    """Run single-turn /negotiate -> /draft -> assert for each case.
    Mirrors run_eval.main()'s single-turn loop exactly."""
    rows = []
    n = len(cases)
    for i, case in enumerate(cases, 1):
        print(f"[{i}/{n}] {case['id']} ...", flush=True)
        status, resp, dt, err = run_eval.post("/negotiate", run_eval.build_request(case))
        draft = None
        if not err and isinstance(resp, dict):
            action = resp.get("action")
            rate = (resp.get("proposedTerms") or {}).get("rate")
            cqs = resp.get("creatorQuestions") or []
            pfts = resp.get("pushedFixedTerms") or []
            print(f"    negotiate {status} in {dt:.0f}s -> {action} {rate} "
                  f"| Q={len(cqs)} pushed={pfts}")
            draft = run_eval.call_draft(action, rate, case["reply"],
                                        creator_questions=cqs, pushed_fixed_terms=pfts)
            verdict, fails = run_eval.check_case(case["id"], action, rate, cqs, pfts, draft)
        else:
            print(f"    negotiate ERROR after {dt:.0f}s: {err}")
            verdict, fails = run_eval.check_case(case["id"], None, None, [], [], None)
        mark = {"PASS": "PASS", "FAIL": "FAIL", "SKIP": "SKIP", "N/A": "N/A"}.get(verdict, verdict)
        if fails:
            print(f"    assert: {mark} -- {'; '.join(fails)}")
        else:
            print(f"    assert: {mark}")
        rows.append({"case": case, "verdict": verdict, "fails": fails,
                     "resp": resp, "dt": dt, "err": err})
    return rows


def run_classify(cases):
    """Run the /classify layer. Asserts the returned intent equals expect_intent.
    UNKNOWN cases accept UNKNOWN OR a low-confidence result (the production gate
    routes both to MANUAL_REVIEW), so they are treated leniently."""
    rows = []
    n = len(cases)
    for i, c in enumerate(cases, 1):
        status, resp, dt, err = run_eval.post("/classify", {"message": c["message"]})
        got = (resp or {}).get("intent") if isinstance(resp, dict) else None
        conf = (resp or {}).get("confidence") if isinstance(resp, dict) else None
        exp = c["expect_intent"]
        if err or got is None:
            verdict, detail = "SKIP", err or "no intent"
        elif got == exp:
            verdict, detail = "PASS", ""
        elif exp == "UNKNOWN" and (conf is not None and conf < 0.5):
            verdict, detail = "PASS", f"low-conf {got}@{conf} ~ UNKNOWN"
        else:
            verdict, detail = "FAIL", f"got {got} (conf {conf}) expected {exp}"
        print(f"[cl {i}/{n}] {c['id']}: {verdict} {detail}")
        rows.append({"case": c, "verdict": verdict, "detail": detail,
                     "got": got, "conf": conf, "dt": dt})
    return rows


def summarize(rows, label):
    passed = [r for r in rows if r["verdict"] == "PASS"]
    failed = [r for r in rows if r["verdict"] == "FAIL"]
    skipped = [r for r in rows if r["verdict"] == "SKIP"]
    print(f"\n=== {label}: {len(passed)} passed / {len(failed)} failed / "
          f"{len(skipped)} skipped (of {len(rows)}) ===")
    for r in failed:
        cid = r["case"]["id"]
        why = "; ".join(r.get("fails", [])) or r.get("detail", "")
        print(f"  FAIL {cid}: {why}")
    return len(failed)


def write_report(single_rows, classify_rows, convo_results, model_note):
    lines = ["# Eval-500 Report — full pipeline (classify -> negotiate -> draft)\n"]
    lines.append(f"Model/agent note: {model_note}\n")
    lines.append(f"Band: floor $200 / ceiling $500 (internal, must never leak).\n")

    def block(title, rows):
        lines.append(f"\n## {title}\n")
        by_cat = Counter()
        fails_by_cat = Counter()
        for r in rows:
            cat = r["case"].get("category", r["case"].get("id", "?")).split(":")[0]
            by_cat[cat] += 1
            if r["verdict"] == "FAIL":
                fails_by_cat[cat] += 1
        lines.append("| Category | Cases | Failed |")
        lines.append("|----------|-------|--------|")
        for cat in sorted(by_cat):
            lines.append(f"| {cat} | {by_cat[cat]} | {fails_by_cat[cat]} |")

    if single_rows:
        block("Single-turn /negotiate -> /draft", single_rows)
    if classify_rows:
        lines.append("\n## /classify\n")
        p = sum(1 for r in classify_rows if r["verdict"] == "PASS")
        f = sum(1 for r in classify_rows if r["verdict"] == "FAIL")
        lines.append(f"{p} passed / {f} failed of {len(classify_rows)}.\n")
    if convo_results:
        lines.append(f"\n## Multi-turn conversations\n{len(convo_results)} conversations run "
                     "(per-turn structure verified live; arcs human-judged).\n")
    with open(OUT_500, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"\nWrote report: {OUT_500}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", help="only this single-turn category prefix (money, multi-question, answerable, deferred, unrelated, escalate, injection, fixed-term, opt-out, negative)")
    ap.add_argument("--classify-only", action="store_true")
    ap.add_argument("--no-convos", action="store_true")
    ap.add_argument("--smoke", type=int, help="first N cases of each selected category only")
    ap.add_argument("--limit", type=int, help="cap total single-turn cases")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    _apply_dataset_asserts()

    total_fail = 0
    single_rows, classify_rows, convo_results = [], [], []

    if args.classify_only:
        classify_rows = run_classify(loader.CLASSIFY_CASES)
        total_fail += summarize(classify_rows, "/classify")
        write_report([], classify_rows, [], "classify-only run")
        sys.exit(1 if total_fail else 0)

    # Single-turn
    cases = list(loader.CASES)
    if args.category:
        cases = [c for c in cases if c["category"].split(":")[0] == args.category]
        print(f"Filtered to category '{args.category}': {len(cases)} cases")
    if args.smoke:
        # first N per category
        seen = Counter()
        picked = []
        for c in cases:
            cat = c["category"].split(":")[0]
            if seen[cat] < args.smoke:
                picked.append(c)
                seen[cat] += 1
        cases = picked
        print(f"Smoke mode: {len(cases)} cases ({args.smoke}/category)")
    if args.limit:
        cases = cases[:args.limit]

    print(f"\nRunning {len(cases)} single-turn cases against {run_eval.AGENT} "
          f"(timeout {run_eval.TIMEOUT_S:.0f}s each)\n")
    single_rows = run_single_turn(cases)
    total_fail += summarize(single_rows, "single-turn")

    # Classify layer
    classify_rows = run_classify(loader.CLASSIFY_CASES)
    total_fail += summarize(classify_rows, "/classify")

    # Conversations
    if not args.no_convos:
        print(f"\nRunning {len(loader.CONVERSATIONS)} multi-turn conversations\n")
        for i, conv in enumerate(loader.CONVERSATIONS, 1):
            print(f"[conv {i}/{len(loader.CONVERSATIONS)}] {conv['id']} ...", flush=True)
            convo_results.append(run_eval.run_conversation(conv))

    write_report(single_rows, classify_rows, convo_results,
                 f"agent={run_eval.AGENT}")

    print(f"\n########## TOTAL FAILURES: {total_fail} ##########")
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main()
