"""
Live monitor for the running audit — reprints progress from audit_live_results.json
every few seconds. Run in its own terminal while audit_live.py runs.

    python watch.py            # refresh every 3s
    python watch.py 5          # refresh every 5s

Ctrl-C to stop (does not affect the audit).
"""
from __future__ import annotations

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(HERE, "audit_live_results.json")

# per-category totals so we can show N/total
TOTALS = {"answerable": 70, "multi-question": 70, "fixed-term": 30,
          "money": 90, "deferred": 45, "unrelated": 45, "escalate": 40,
          "injection": 18, "opt-out": 12, "negative": 10}


def main():
    interval = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    last_n = -1
    last_mtime = 0.0
    while True:
        try:
            mtime = os.path.getmtime(RESULTS)
            with open(RESULTS, encoding="utf-8") as fh:
                d = json.load(fh)
        except (FileNotFoundError, json.JSONDecodeError):
            print("waiting for audit_live_results.json ...", flush=True)
            time.sleep(interval)
            continue

        cat = d.get("category", "?")
        r = d.get("results", [])
        total = TOTALS.get(cat, "?")
        p = sum(1 for x in r if x.get("verdict") == "PASS")
        f = [x for x in r if x.get("verdict") == "FAIL"]
        other = [x for x in r if x.get("verdict") not in ("PASS", "FAIL")]

        # Only redraw when something changed (new case) or file touched.
        if len(r) != last_n or mtime != last_mtime:
            os.system("cls" if os.name == "nt" else "clear")
            age = round(time.time() - mtime)
            print(f"AUDIT: {cat}   {len(r)}/{total} done   "
                  f"PASS {p}   FAIL {len(f)}   ERR {len(other)}   "
                  f"(last update {age}s ago)\n")
            for x in r[-15:]:
                v = x.get("verdict", "?")
                mark = {"PASS": "OK  ", "FAIL": "FAIL"}.get(v, v)
                q = len(x.get("creatorQuestions") or [])
                line = f"  [{mark}] {x['id']}  (Q={q}, {x.get('action','?')})"
                if x.get("fails"):
                    line += "  <- " + "; ".join(x["fails"])[:90]
                print(line)
            if len(r) == last_n:
                print("\n  ...case in flight (model ~35s/turn, 2 turns/case)...")
            last_n = len(r)
            last_mtime = mtime
        time.sleep(interval)


if __name__ == "__main__":
    main()
