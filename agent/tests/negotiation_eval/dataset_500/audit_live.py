"""
Live question-answering audit — runs cases through the REAL /draft and records
every body_has_all pattern the model actually failed to satisfy (the real
"did the model answer this question" gaps, as opposed to audit_coverage.py's
offline "is the fact even available" check).

Writes results to audit_live_results.json so fixes can be driven off concrete
failures. Category-scoped so it can run one bank at a time (each ~35s/case on
local qwen3:30b).

Usage:
    python audit_live.py answerable        # bank C (70)
    python audit_live.py multi-question    # bank B (70)
    python audit_live.py fixed-term        # bank H (30)
    python audit_live.py answerable --limit 10
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_EVAL = os.path.dirname(_HERE)
for p in (_EVAL, _HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

import run_eval  # noqa: E402
import loader  # noqa: E402

run_eval.ASSERTS = loader.ASSERTS
run_eval.BAND = loader.BAND

OUT = os.path.join(_HERE, "audit_live_results.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("category")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    cases = [c for c in loader.CASES if c["category"].split(":")[0] == args.category]
    if args.limit:
        cases = cases[:args.limit]
    print(f"Live-auditing {len(cases)} '{args.category}' cases (/negotiate -> /draft)\n")

    results = []
    for i, case in enumerate(cases, 1):
        cid = case["id"]
        t = time.time()
        status, resp, dt, err = run_eval.post("/negotiate", run_eval.build_request(case))
        if err or not isinstance(resp, dict):
            print(f"[{i}/{len(cases)}] {cid}: NEGOTIATE ERROR {err}")
            results.append({"id": cid, "stage": "negotiate", "error": str(err)})
            continue
        action = resp.get("action")
        rate = (resp.get("proposedTerms") or {}).get("rate")
        cqs = resp.get("creatorQuestions") or []
        pfts = resp.get("pushedFixedTerms") or []
        draft = run_eval.call_draft(action, rate, case["reply"],
                                    creator_questions=cqs, pushed_fixed_terms=pfts)
        verdict, fails = run_eval.check_case(cid, action, rate, cqs, pfts, draft)
        took = time.time() - t
        mark = "OK  " if verdict == "PASS" else verdict
        print(f"[{i}/{len(cases)}] {cid}: {mark} {action} Q={len(cqs)} ({took:.0f}s)"
              + (f" -- {'; '.join(fails)}" if fails else ""))
        results.append({
            "id": cid, "verdict": verdict, "action": action,
            "creatorQuestions": cqs, "pushedFixedTerms": pfts,
            "fails": fails,
            "subject": (draft or {}).get("subject"),
            "body": (draft or {}).get("body"),
        })
        # incremental write so a long run is never lost
        with open(OUT, "w", encoding="utf-8") as fh:
            json.dump({"category": args.category, "results": results}, fh, indent=2, ensure_ascii=False)

    passed = sum(1 for r in results if r.get("verdict") == "PASS")
    failed = [r for r in results if r.get("verdict") == "FAIL"]
    print(f"\n=== {passed} passed / {len(failed)} failed of {len(results)} ===")
    for r in failed:
        print(f"  FAIL {r['id']}: {'; '.join(r.get('fails', []))}")
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
