# MEDIUM — Correctness & Safety Hardening

Real bugs and safety gaps that are not full redesigns. Each is a bounded change to 1-3 files. Do these
after Criticals; several can be done alongside the Hard work.

Naming: `MED-W*` workflow, `MED-N*` negotiation, `MED-S*` security, `MED-L*` LLM integration,
`MED-R*` reliability, `MED-A*` architecture/maintainability.

---

## [MED-W1] Mid-flow opt-out is never honored (CAN-SPAM exposure)

**Where**
- `server/src/engine/executors/replyDetection.ts:77-96` — once `negotiationRound >= 1`, the reply skips
  classification entirely, so the opt-out gate never runs.
- `server/src/engine/executors/paymentReply.ts:64-78` — payment-reply handler auto-replies marketing copy;
  never classifies for opt-out.
- Unreachable transitions confirm it: OUTREACH_SENT→OPTED_OUT, FOLLOWED_UP→OPTED_OUT,
  NEGOTIATING→OPTED_OUT, AWAITING_BRAND_DECISION→OPTED_OUT have no caller (`stateMachine.ts`).

**Problem**
"stop emailing me" / "unsubscribe" mid-negotiation gets a counter-offer or a "rate is fixed" auto-reply
instead of opting the creator out. Legal exposure.

**Fix**
Run the deterministic OPT_OUT gate (`agent/app/injection.py` opt-out patterns / the mock classifier
patterns) on **every** inbound regardless of state/round, before dispatching to any handler, and route to
OPTED_OUT. Add the missing state-machine edges.

**Verify**
Inbound "unsubscribe" in NEGOTIATING and in PAYMENT_PENDING → OPTED_OUT, no further emails.

---

## [MED-W2] Second question at the same round is silently swallowed

**Where**
- `server/src/engine/executors/negotiation.ts:368-374` — present-offer send is keyed
  `negotiation:present:<id>:<round>`.
- `server/src/engine/executors/idempotentSend.ts:92-101` — same key → deduped, no email.

**Problem**
PRESENT_OFFER doesn't consume a round by design, so a creator's second question at the same round produces
an event but **no reply** — silent drop.

**Fix**
Key present-offer sends on the inbound message id (or round+message id), not round alone.

---

## [MED-W3] Unbounded present_offer LLM loop

**Where**
- `server/src/engine/executors/negotiation.ts:376-388` — PRESENT_OFFER never increments the round.

**Problem**
A persistently curious creator (or a model mislabeling proposals as PRESENT_OFFER) loops forever, each
turn an LLM call — cost and abuse vector.

**Fix**
Cap consecutive PRESENT_OFFERs (e.g. escalate after N without progress), or count them toward a soft limit.

---

## [MED-W4] Remove the B9 "final counter" option until its sub-state exists

**Where**
- `server/src/engine/executors/negotiation.ts:154-165` — escalation email offers the brand a COUNTER.
- `server/src/engine/executors/brandDecision.ts:408-431` — resolution parks it in MANUAL_REVIEW pending
  manual delivery; the brand's counter is never actually sent.

**Fix**
Remove the COUNTER option from the escalation email until the final-offer delivery sub-state is built, so
the brand isn't told a counter went out when it didn't.

---

## [MED-N1] Loose keyword money decisions

**Where**
- `server/src/engine/brandDecisionParse.ts:37-40` — `APPROVE_RE` matches bare `YES|OK|OKAY|SOUNDS GOOD`.
- `server/src/engine/providerFactory.ts:216-228` — `classifyBrandDecision` maps POSITIVE **and QUESTION** → APPROVE.

**Problem**
A brand asking a *question* currently approves an over-ceiling spend; a stray "ok" approves a deal. (The
sender-identity fix in CRITICAL-1 is the primary defense; this narrows the parser as defense-in-depth.)

**Fix**
Require the literal instructed cue (`APPROVE`) or a first-line match for token confidence 1.0; map
QUESTION → AMBIGUOUS, not APPROVE.

---

## [MED-N2] No-number pushback loops the identical counter

**Where**
- `agent/app/routes/negotiate.py:453-456` — OBJECTION/NEGOTIATION with no number → COUNTER at the same
  `our_offer` every round, burning rounds and reading as a broken record.

**Fix**
On OBJECTION/no-number, hold without consuming a round and explicitly ask for their number; escalate after
2 repeats.

---

## [MED-N3] Rate extraction feeds the money path via regex

**Where**
- `server/src/engine/executors/negotiation.ts:93-127` — `extractRequestedRate` regex (`MIN_BARE_RATE=50`),
  commented "acknowledgement-only," but the extracted number becomes `context.creatorRate` →
  `approvedRate` on a brand APPROVE (`negotiation.ts:147`, `brandDecision.ts:386`).
- `agent/app/routes/negotiate.py:270-294` — `_coerce_rate` misparses: `"480-500"` → `480500.0`;
  European `"1.500"` → `1.5`.

**Problem**
A regex sets the recorded deal price; ranges/locale formats corrupt it.

**Fix**
Use the `/negotiate` LLM's extracted rate for the money path (with deterministic bounds-checking only),
and validate that the extracted number's digits actually appear in the reply. Reject multi-number ranges
rather than concatenating.

---

## [MED-N4] Reward-confirmation contract formation by regex

**Where**
- `server/src/engine/executors/rewardReply.ts:26-101` — AGREEMENT_PATTERNS / RENEGOTIATION_PATTERNS
  regexes decide whether a deal is confirmed; "yes" leading a hedged sentence confirms.

**Fix**
Move agreement detection to LLM comprehension with a deterministic allowlist only for the literal "I Agree"
the email requests.

---

## [MED-S1] Harden the output guard against non-numeric / non-band leaks

**Where**
- `server/src/engine/guards/outputGuard.ts:63-79` — `numberAppears` matches digits only.
- `server/src/engine/guards/outputGuard.ts:114-156` — scans only exact floor/ceiling, configured
  `internalTerms`, and foreign commission %.
- `server/src/engine/guards/outputGuard.ts:176-181` — allowlists `creatorRequestedRate`, so a creator who
  guesses the ceiling can get it confirmed.

**Problem**
"our ceiling is five hundred dollars" passes; a fabricated "$2,000 upfront bonus" passes; an invented
figure ≠ floor/ceiling passes.

**Fix**
Add word-number matching, and an allowlist rule: block any `$`-amount in the draft that is not in
`{allowedRate, creatorRate, commission}`. Reconsider auto-allowlisting `creatorRequestedRate` near the
ceiling.

---

## [MED-S2] Run injection detection on /negotiate and /draft; escape delimiter tags

**Where**
- `agent/app/routes/classify.py:179-185` — injection gate runs only on `/classify`.
- `agent/app/injection.py:55-72` — `sanitize_creator_text` strips control chars but not a literal
  `</creator_reply>` closing tag or role tags.
- `agent/app/routes/negotiate.py:1790-1794,1877-1881` — the copywriter (`/draft`) embeds the creator reply
  in plain quotes with no delimiters and no "DATA not instructions" line.

**Fix**
Run `looks_like_injection` on `/negotiate` and `/draft` inputs; escape/strip `</creator_reply>` and
`system:`/role-tag sequences in the sanitizer; wrap the draft-prompt creator reply in the same tagged,
"DATA not instructions" block used by classify/negotiate.

---

## [MED-S3] Auth + validation on /uploads

**Where**
- `server/src/routes/uploads.ts:37` — unauthenticated (also covered by CRITICAL-5's blanket auth).
- `server/src/routes/uploads.ts:23-53` — extension+mime check only; content not validated.

**Fix**
Behind the CRITICAL-5 auth, add `%PDF-` magic-byte verification and a per-IP quota (disk-fill DoS; an
unvalidated "PDF" is later emailed to creators as the brand's brief).

---

## [MED-S4] Brand-decision magic-link expiry + prefetch safety

**Where**
- `server/src/routes/brandDecision.ts:55-140` — GET-that-mutates; `expiresAt` exists in schema
  (`schema.prisma:488-490`) but is only checked by the sweep, not on click.

**Fix**
Enforce `expiresAt` in the route; serve a confirm-POST interstitial so an email security gateway
prefetching the link can't silently auto-resolve the decision.

---

## [MED-S5] Payment token expiry + rate limiting

**Where**
- `prisma/schema.prisma:526-547` — `PaymentInfo` has no expiry.
- No rate limiter anywhere on the Express app.

**Fix**
Add `expiresAt` (e.g. 30 days) checked in the GET/POST payment routes; rate-limit the token endpoints.

---

## [MED-L1] Widen the LLM fallback catch (and make LLM the default) — see PRINCIPLES.md

**Where**
- `agent/app/routes/negotiate.py:1128` — the `NEGOTIATION_STRATEGY=llm` path catches only
  `StructuredOutputError`; a `ConnectionError` or `RuntimeError("all LLM candidates failed")`
  (`agent/app/llm.py:214`) propagates → HTTP 500, no rules fallback (contradicts the docstring at 1070).
- `agent/app/routes/negotiate.py` strategy dispatch (`_langgraph_negotiate`) — `rules` is the effective
  default; per `PRINCIPLES.md` the LLM must decide every turn, with rules as a fallback only.

**Fix**
1. Make `llm` the effective production default; the deterministic `rules` ladder runs ONLY as the
   availability fallback.
2. Catch transport/timeout exception types (or a broad `except Exception` with logging) so a model outage —
   not just `StructuredOutputError` — degrades to the rules fallback instead of 500ing the negotiation.
3. Reframe the comments/docstrings on `_decide_action`/`_rules_negotiate` as "deterministic safety
   fallback," not "the audited default."

**Verify**
Simulate a ConnectionError from the model client → the turn falls back to rules and returns a decision.

---

## [MED-L2] Fix the timeout model and prevent thread-pool saturation

**Where**
- `agent/app/structured.py:37,71-88` — shared `ThreadPoolExecutor(8)` + `future.result(timeout)`; orphaned
  generations can't be killed → 8 orphans saturate the pool.
- `agent/app/structured.py:80` wraps the whole `FailoverChat.invoke` (`llm.py:201`), so a hung primary
  consumes the full 60s budget and the fallback never runs.
- `agent/app/llm.py:127` — `num_predict=512` can truncate the verbose llm-negotiate JSON mid-string.

**Fix**
Per-generation timeout (not one budget spanning primary+fallback); bound/kill orphaned generations or
size the pool to real concurrency; raise `num_predict` for the llm-negotiate output.

---

## [MED-L3] Real determinism or drop the claim

**Where**
- `agent/app/llm.py:129-137,153-157` — no `seed`, no `format="json"`/JSON mode, no `top_p` pin.
- `agent/app/routes/negotiate.py:1160-1162` — comment claims "identical inputs yield identical decisions".

**Fix**
Add `seed` + JSON mode + `top_p` pin on both providers, or remove the determinism claim from the comments.

---

## [MED-A1] Fail-fast on unset EMAIL_PROVIDER; require notifyEmail for escalations

**Where**
- `server/src/engine/providerFactory.ts:106` — EMAIL defaults to **mock even in prod** (AGENT/NEGOTIATION
  default to langgraph). A misconfigured deploy advances the whole funnel while sending zero real emails.
- `server/src/notifications/escalation.ts:35,72-78` — brand money decisions fall back to a hardcoded
  operator inbox.

**Fix**
Fail startup when `EMAIL_PROVIDER` is unset outside test; require campaign `notifyEmail` for brand-decision
escalations rather than a hardcoded fallback.

---

## [MED-A2] Generate the mock classifier from a shared spec

**Where**
- `server/src/adapters/classification/MockClassificationProvider.ts:14-27` — hand-maintained TS mirror of
  the Python classify gates (admitted dual-maintenance → guaranteed drift).

**Fix**
Generate both from a shared spec/fixture, or have the mock call a shared rule module, so the gates can't
diverge silently.
