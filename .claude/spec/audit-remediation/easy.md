# EASY — Localized Low-Risk Fixes

Small, well-contained diffs (usually one file, a few lines). Low risk. Good warm-up tasks or
fill-in work between larger changes.

Naming: `EASY-P*` prompt/agent, `EASY-S*` security, `EASY-W*` workflow, `EASY-D*` docs/cleanup.

---

## [EASY-P1] Fix `ceiling=inf` rendering "$no fixed cap"

**Where**
- `agent/app/routes/negotiate.py:864` — `ceiling_rate if ceiling_rate != float("inf") else "no fixed cap"`
  produces the prompt line `Internal ceiling (maximum you may agree to): $no fixed cap`.

**Fix**
Render the whole line conditionally (omit the `$` and the "maximum" framing when there's no cap), e.g.
"No fixed ceiling for this campaign — use judgment." Note this also means the over-ceiling ACCEPT guard
(`negotiate.py:590`) is a no-op for uncapped campaigns — acceptable, but document it.

---

## [EASY-P2] Remove the dead `confidence` field from negotiation output

**Where**
- `agent/app/routes/negotiate.py:1055` — `_NEGOTIATE_PROMPT` requests `confidence`.
- `agent/app/routes/negotiate.py:142` — `_NegotiateLLMOutput.confidence` typed but read nowhere.

**Fix**
Drop `confidence` from the prompt and schema (wasted generation tokens; there is no confidence gate on
negotiation intent anyway). Note: HARD-P1 removes this prompt entirely — do EASY-P2 only if HARD-P1 isn't
scheduled first.

---

## [EASY-P3] Fix incoherent missing-rate fallback strings

**Where**
- `agent/app/routes/negotiate.py:1591` — missing rate → `offer_rate = "our proposed fee"`, producing the
  rule `State the fixed fee EXACTLY as our proposed fee (same number, same "$")` (`1430`).
- `agent/app/routes/negotiate.py:1530` — onboarding missing-rate fallback yields "confirm the agreed rate
  of the agreed rate, written EXACTLY as given".

**Fix**
When no concrete rate is available, don't emit a "state the fee EXACTLY as <words>" instruction — either
skip the fee sentence or escalate. These fallbacks currently invite the model to invent a number.

---

## [EASY-P4] Fix `_build_offer_prompt` numbered-point gaps and fabricated premise

**Where**
- `agent/app/routes/negotiate.py:1690-1694` — asserts "the creator asked about deliverables" whether or not
  they did, contradicting "only address topics the creator actually raised" (`1393`).
- `agent/app/routes/negotiate.py:1629,1682,1738` — `deal_goal` can be "" (point "1.") while deliverables is
  hard-coded "3." and fixed-terms "4.", so the model sees "1." then "3." and sometimes invents a "2.".

**Fix**
Only include the deliverables sentence when the creator actually raised it; renumber the assembled points
dynamically so there are no gaps.

---

## [EASY-P5] Fix hardcoded USD in `_format_rate`

**Where**
- `agent/app/routes/negotiate.py:1258` — `_format_rate` hardcodes `$`/USD.

**Fix**
Thread a currency symbol from campaign config; non-USD campaigns are currently misstated. Low priority if
all campaigns are USD today, but cheap to parameterize.

---

## [EASY-P6] `_scrub_brand` false positives on legit bracketed copy

**Where**
- `agent/app/routes/negotiate.py:1938,1963` — `_PLACEHOLDER_TOKEN_RE` rewrites *any* short `[words]`/
  `<words>` token to the brand name, so legit copy like "[link to media kit]" becomes the sender mid-sentence.

**Fix**
Narrow the regex to actual placeholder patterns (`[Your Name]`, `[Name]`, `[Brand]`, `<Name>`), not any
bracketed phrase.

---

## [EASY-S1] Redact raw model output from HTTP error detail

**Where**
- `agent/app/structured.py:106-111` — `ValueError` embeds the entire raw response (`{raw!r}`) into the
  repair suffix and the exception.
- `agent/app/routes/classify.py:231`, `negotiate.py:1996,2008` — exception text returned in HTTP `detail`.
- `server/src/adapters/agentServiceClient.ts:127-133` — echoed into TS error strings + console.

**Problem**
Confidential figures the model quoted can transit logs/errors. Also, embedding the full raw output in the
repair prompt can exceed `num_ctx` and cause silent prompt-head truncation on retry.

**Fix**
Truncate/redact `raw` in the repair suffix and remove it from HTTPException detail.

---

## [EASY-S2] Mask leak values in observability event payloads

**Where**
- `server/src/observability/repository.ts:407-419` — guard-leak details (e.g. `leaks: ["ceiling:500"]`) are
  written to event payloads and served raw.

**Fix**
Store/serve a masked marker (e.g. `leaks: ["ceiling:<redacted>"]`) instead of the actual band value.
Defense-in-depth so the internal band value never sits raw in event payloads for anyone with DB/log
access. (Endpoint-level auth is the parent system's job — see the CRITICAL-5 removal — so this masking is
the component's own contribution to not leaking band values.)

---

## [EASY-S3] Delete diagGrant after use

**Where**
- `server/src/diagGrant.ts` — CLI script that prints creator name/email + env presence; marked
  "delete after use" but still in the tree.

**Fix**
Remove it (or gate it behind an explicit debug flag and move it out of the shipped source).

---

## [EASY-W1] `maxRounds` semantics are inconsistent

**Where**
- `agent/app/routes/negotiate.py:1988-1992` — route pre-check REJECTs when `round >= maxRounds`.
- `agent/app/routes/negotiate.py:1116` — `is_final_round` treats `maxRounds <= 0` as "no final round".

**Problem**
`maxRounds=0` REJECTs immediately in one place while being treated as "unlimited" in another. Dead code
today (the executor pre-empts at `negotiation.ts:300`), but any round-accounting drift terminates a creator
as REJECTED with no human review.

**Fix**
Make the semantics consistent (either `maxRounds=0` = unlimited everywhere, or reject everywhere) and add
a comment. Consider routing the pre-check to a brand decision instead of REJECT to match the server path.

---

## [EASY-W2] `expireBrandDecision` partial-failure leaves a re-swept PENDING row

**Where**
- `server/src/engine/runtime.ts:706-719` — the transition can commit while the row update fails, leaving a
  PENDING row that the 72h sweep re-processes forever.

**Fix**
Update the row and commit the transition atomically (same transaction), or make the sweep idempotent
against an already-transitioned instance.

---

## [EASY-W3] PaymentInfo/instance divergence bricks the payout form

**Where**
- `server/src/routes/payment.ts:120-124` — `PaymentInfo.status` is set to PAYMENT_RECEIVED before the OCC
  step; if the step throws non-stale, the form thereafter renders "already submitted" while the instance is
  stuck in PAYMENT_PENDING with no recovery.

**Fix**
Set the status only after the OCC step succeeds, or make the "already submitted" check also require the
instance to have advanced. (The reconciliation sweep in HARD-R1 would also recover it.)

---

## [EASY-D1] Update stale docs

**Where**
- `negotiation.md:386` — claims "midpoint" anchoring; actual default is floor (position 0.0).
- `agent/app/routes/negotiate.py:144-146` — comment claims the prompt doesn't yet emit comprehension fields
  ("Phase 2") but the working-tree prompt does (`990-1012`).

**Fix**
Correct both to match the shipped behavior.
