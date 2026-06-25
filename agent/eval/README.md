# Classification eval set + accuracy gate (FIX-5)

Closes the audit's headline gap: *"There is no labeled evaluation set anywhere
in the repo. No precision/recall/F1 per intent. No accuracy number at all."*

## What's here

| File | Role |
|---|---|
| `dataset_v1.jsonl` | Versioned, labeled eval set. One JSON object per line: `{id, message, expected, tags}`. Synthetic, anonymized — **no real creator PII**. Covers all five intents plus hard/ambiguous and injection cases. |
| `scorer.py` | Pure scorer: confusion matrix, per-intent precision/recall/F1, macro-F1. No network. |
| `reference_classifier.py` | Deterministic rule-based classifier (reuses the production FIX-7 OPT_OUT + injection gates and mirrors the TS mock's keywords). What CI gates on. |
| `run.py` | CLI publisher — prints the accuracy table + misses. |
| `../tests/test_eval_gate.py` | The CI gate: fails the build if macro-F1 / per-intent F1 / OPT_OUT recall drop below threshold. |

## Run it

```bash
# from agent/
python -m eval.run                 # deterministic path (no model, offline, CI-safe)
RUN_LLM_EVAL=1 python -m eval.run  # live LLM path (needs Ollama/OpenAI configured)

pytest tests/test_eval_gate.py     # the gate
```

## Honest limitations (read this)

- **The deterministic gate scores ~1.0 on `dataset_v1` by construction.** The
  reference classifier and this curated set are aligned, so the deterministic
  number is a **regression tripwire**, not a measure of real-world accuracy. If
  a future change breaks OPT_OUT detection, the injection gate, or keyword
  routing, macro-F1 drops below the threshold and CI fails. That is its job.
- **Real accuracy = the LLM path.** `RUN_LLM_EVAL=1` runs the *same* labeled set
  through the live `classify_message` (the production path, gates included). Its
  threshold is deliberately looser (track, don't pretend perfection). This is
  the number to quote for "how good is the classifier", and it must be re-run
  per model/prompt change.
- **`dataset_v1` is small (34 cases) and synthetic.** Phase A's exit criterion
  calls for ≥ ~500 real, anonymized replies. This is the versioned scaffold to
  grow into that: add lines, bump to `dataset_v2.jsonl`, keep the scorer/gate.
- **OPT_OUT recall is gated at 1.0** because a missed opt-out is a compliance
  risk (CAN-SPAM / GDPR), not just an accuracy point.
