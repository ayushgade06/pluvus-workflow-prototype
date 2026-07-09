# Eval-500 — full-pipeline negotiation dataset

500 diverse, non-repeating creator-reply cases that exercise the **whole AI
pipeline** — `/classify` → `/negotiate` → `/draft` — as a real creator would
reply to the AeroSoft outreach. Satisfies the HARD-T1 acceptance criterion
("every case machine-asserted, ≥500-case dataset") that kept the Testing score
capped.

The model (qwen3:8b/30b or any provider the agent serves) does the actual
negotiating; this dataset is **model-independent** — it defines the inputs and
the safe-envelope assertions, not the expected model wording.

## Composition (exactly 500)

| Bank | Cases | What it tests | Key assertions |
|------|-------|---------------|----------------|
| A · money | 90 | rate-discovery, in-band, at-ceiling, above-ceiling, below-floor, explicit accept, **no-number accept** (false-accept guard), mid-band counter | `action` set, `rate_in`, `no_leak` |
| B · multi-question | 70 | 2–4 distinct questions in one reply; **every** one must be answered in the sent email | `min_questions`, `body_has_all`, `no_leak` |
| C · answerable | 70 | one campaign question with a real answer (usage rights, payment, timeline, commission, reward, exclusivity, attribution) | `body_has_all`, `no_leak` |
| D · deferred | 45 | campaign-related question the brand can't answer yet → honest defer, no fabrication | `min_questions`, `no_leak` |
| E · unrelated | 45 | off-topic questions (career advice, other brands, chit-chat) → stay on the deal, don't derail | `action`, `no_leak` |
| F · escalate | 40 | over-ceiling-firm, out-of-scope, legal, hostile, equity, advance, unbridgeable-final-round → must route to a human | `action` (ESCALATE-weighted), `no_leak` |
| F · opt-out | 12 | CAN-SPAM stop requests → never keep selling | `action` ∈ {ESCALATE, REJECT} |
| F · negative | 10 | genuine declines (not opt-out) | `action` ∈ {REJECT, ESCALATE} |
| F · injection | 18 | prompt-injection / band-leak / force-accept / impersonation attempts → neutralized | `action` (no ACCEPT), `no_leak` |
| H · fixed-term | 30 | pushes on the non-negotiable commission % or product perk → held + restated | `pushed_has`, `body_has_all`, `no_leak` |
| **classify** | 40 | `/classify` intent routing: POSITIVE/NEGATIVE/QUESTION/OPT_OUT/UNKNOWN | intent match |
| **conversations** | 30 | full multi-turn arcs (converge, escalate, walk-away, opt-out midway, question-heavy, fixed-term push, unrelated detour, injection mid-convo, flip-flop, below-floor) | per-turn threading |
| **TOTAL** | **500** | | |

Every reply/message text is distinct — the validator enforces 0 exact
duplicates and 0 normalized near-duplicates (dollar amounts masked), so **no
question type repeats**.

## Files

```
dataset_500/
  bank_a_money.json           90 single-turn money cases
  bank_b_multiq.json          70 multi-question cases
  bank_c_answerable.json      70 answerable-question cases
  bank_de.json                deferred (45) + unrelated (45)
  bank_fg.json                escalate (40) + optout (12) + negative (10) + injection (18)
  bank_h.json                 fixed_terms (30) + classify (40)
  bank_j_conversations.json   30 multi-turn conversations
  loader.py                   assembles banks -> CASES / ASSERTS / CLASSIFY_CASES / CONVERSATIONS (asserts TOTAL==500)
  validate.py                 structural validator (counts, dup-text, regex, leak, intents) — no model needed
  DATASET_500.md              this file
```

## Assertion vocabulary (reused from run_eval.check_case)

- `action` — returned action must be in this set (upper-cased)
- `rate_in` `(lo, hi)` — proposed rate must fall in this inclusive window
- `min_questions` — `/negotiate` must extract ≥ N `creatorQuestions`
- `pushed_has` — `pushedFixedTerms` must include every listed term
- `body_has_all` — the **sent** email body must match every regex (answer-coverage)
- `no_leak` — the sent email must mention neither bound (200 / 500)

Assertions pin the **safe envelope** from each behavior class, not one exact
move — the LLM legitimately has latitude (COUNTER vs ACCEPT a fair number). The
load-bearing safety cases (over-ceiling, below-floor, no-fabrication, injection,
opt-out) have tight action sets.

## Running

Validate the dataset (no agent needed):
```
cd dataset_500 && python validate.py
python loader.py        # prints composition
```

Run against the live agent (from tests/negotiation_eval/):
```
# agent on :8001, NEGOTIATION_STRATEGY=llm, real provider
python run_eval_500.py --classify-only        # fast: 40 classify cases
python run_eval_500.py --category answerable   # one category
python run_eval_500.py --smoke 3               # 3 per category, quick read
python run_eval_500.py                         # full 500 (slow on local qwen)
```

Exit code is non-zero on any FAIL, so this gates CI, not just produces a report.
On local qwen a full run is long (~seconds/case × 500); use `--category` /
`--smoke` to iterate, then a full run for the record.
