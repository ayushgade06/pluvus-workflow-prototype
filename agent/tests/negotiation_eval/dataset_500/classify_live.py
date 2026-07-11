"""
Live classify audit — runs the 40 CLASSIFY_CASES through the REAL /classify
endpoint and asserts the returned intent equals expect_intent.

Mirrors audit_live.py: incremental write so a long run is never lost, per-case
error isolation, and a final PASS/FAIL tally. Classify is a single LLM call per
case (no /draft), so it is faster than the negotiate banks (~5-15s/case).

Usage:
    python classify_live.py
    python classify_live.py --limit 10
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

OUT = os.path.join(_HERE, "audit_live_results.json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    cases = list(loader.CLASSIFY_CASES)
    if args.limit:
        cases = cases[:args.limit]
    print(f"Live-auditing {len(cases)} classify cases (/classify)\n", flush=True)

    results = []
    for i, case in enumerate(cases, 1):
        cid = case["id"]
        expect = case["expect_intent"]
        t = time.time()
        status, resp, dt, err = run_eval.post("/classify", {"message": case["message"]})
        took = time.time() - t
        if err or not isinstance(resp, dict) or "intent" not in resp:
            print(f"[{i}/{len(cases)}] {cid}: CLASSIFY ERROR {err} status={status}", flush=True)
            results.append({"id": cid, "verdict": "FAIL", "expect": expect,
                            "got": None, "error": str(err), "status": status})
        else:
            got = resp.get("intent")
            verdict = "PASS" if got == expect else "FAIL"
            mark = "OK  " if verdict == "PASS" else verdict
            print(f"[{i}/{len(cases)}] {cid}: {mark} expect={expect} got={got} ({took:.0f}s)"
                  + ("" if verdict == "PASS" else "  <-- MISMATCH"), flush=True)
            results.append({"id": cid, "verdict": verdict, "expect": expect,
                            "got": got, "confidence": resp.get("confidence"),
                            "reasoning": resp.get("reasoning"),
                            "message": case["message"]})
        # incremental write so a long run is never lost
        with open(OUT, "w", encoding="utf-8") as fh:
            json.dump({"category": "classify", "results": results}, fh, indent=2, ensure_ascii=False)

    passed = sum(1 for r in results if r.get("verdict") == "PASS")
    failed = [r for r in results if r.get("verdict") == "FAIL"]
    print(f"\n=== {passed} passed / {len(failed)} failed of {len(results)} ===", flush=True)
    for r in failed:
        print(f"  FAIL {r['id']}: expect={r.get('expect')} got={r.get('got')}"
              + (f" ({r.get('error')})" if r.get("error") else ""), flush=True)
    print(f"\nWrote {OUT}", flush=True)


if __name__ == "__main__":
    main()
