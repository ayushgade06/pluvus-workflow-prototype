# Spec: Thread creator-comprehension from `/negotiate` into `/draft`

**Status:** Implemented (both phases — llm-mode + rules-mode parity). See §11.
**Area:** Negotiation agent — the `/negotiate` → `/draft` seam
**Goal:** Make the sent email (`/draft`) reliably answer *every* question in a
creator's message and *acknowledge* any non-negotiable term they tried to change,
by carrying `/negotiate`'s already-done understanding of the message across the
seam instead of forcing `/draft` to re-derive it from raw text.

---

## 1. Problem statement

The email the creator actually receives is written by **`/draft`**, not
`/negotiate`. In production, every negotiation turn makes **two** LLM calls:

1. **`/negotiate`** — reads the full history + the creator's reply, decides the
   action (ACCEPT / COUNTER / PRESENT_OFFER / REJECT / ESCALATE) and the rate,
   and produces a `responseDraft`. **This `responseDraft` is discarded.**
2. **`/draft`** — writes the `subject` + `body` that is actually sent.

The two calls do **not** share comprehension. `/negotiate` reads and understands
the creator's message (its questions, which fixed terms they pushed on), then the
executor keeps only three fields from the response (`outcome`, `message`,
`proposedRate`) and hands `/draft` a deliberately narrow request. `/draft` then
**re-parses the raw creator reply from scratch** to rediscover what was asked.

This double-comprehension is where quality is lost. The second pass (`/draft`,
temp 0.7) can miss a question the higher-discipline `/negotiate` pass caught.

### Evidence (from the eval, `agent/tests/negotiation_eval/NEGOTIATION_EVAL_8B.md`)

- **Case 10 (multi-question + non-negotiable):** creator asked for 15% commission,
  2 pairs of shoes, a $450 fee, and the timeline. The **`/negotiate` decision
  draft** explicitly rebuts each ("our commission rate is fixed at 10%… the
  product perk is a standard part… content is due by October 10"). The **sent
  `/draft` email** merely *lists* "10% commission" and "one pair of shoes" as flat
  facts — it never acknowledges the creator *asked to change them*. The
  comprehension `/negotiate` had did not reach `/draft`.
- **Case 21 (multi-question, all answerable):** routed to `PRESENT_OFFER` — the
  branch that most often receives multi-question messages — yet that branch passes
  `/draft` the **least** structured info about what was asked (see §3).

### Non-goals / explicit exclusions

- **Do NOT** pass the internal **floor / ceiling** to `/draft`. Withholding them is
  a security decision (the outward-facing model can't leak what it never received;
  the output guard `scanOutboundDraft` is the backstop). This is preserved.
- **Do NOT** pass `/negotiate`'s raw **reasoning** text — it's noise once the
  structured items below are passed.
- We are **not** merging `/negotiate` and `/draft`. They stay separate for the
  withholding/blast-radius reasons above. We only make the *seam carry more
  structured state*.

---

## 2. Architecture context (how the seam works today)

```
  /negotiate (agent, Python)               executor (Node, negotiation.ts)            /draft (agent, Python)
 ┌──────────────────────────┐            ┌────────────────────────────────┐        ┌──────────────────────┐
 │ reads creatorReply + full│            │ line 314: destructure keeps    │        │ RE-READS creatorReply│
 │ history; understands the │──NegResp──▶│   { outcome, message,          │        │ from scratch to find │
 │ ask, the questions, the  │  (rich)    │     proposedRate }             │        │ every question       │
 │ pushed fixed terms       │            │        ▲ everything else DROPS │        │ RE-DERIVES pushed    │
 │ returns responseDraft    │            │        │                       │        │ fixed terms          │
 │ (discarded)              │            │ line 518: extractRequestedRate │        │                      │
 └──────────────────────────┘            │   (creatorReply) ← 2nd parse   │──Draft─▶ writes SENT email    │
                                         │ lines 329/414/519: build       │  Req    └──────────────────────┘
        comprehension never              │   `extra` object → /draft      │ (thin)
        reaches /draft  ───────────X     └────────────────────────────────┘
```

Key invariants (do not break):

- **The agent service is stateless per call.** The executor is the sole reader/
  writer of instance state and rebuilds history each turn from persisted
  `NEGOTIATION_TURN` events (`buildPriorContextFromEvents`,
  `server/src/engine/executors/negotiationHistory.ts`). Nothing lives in the LLM
  between rounds.
- **Hard constraints live in code, not the prompt.** `_apply_decision_guards`
  (negotiate.py) clamps the model's rate to `[floor, ceiling]`; `scanOutboundDraft`
  scans the rendered email for leaks. This spec adds no money-affecting field, so
  these guards are untouched.
- **`NEGOTIATION_STRATEGY`** switches the `/negotiate` path: `rules` (default;
  model only classifies intent + extracts one rate, code decides) and `llm`
  (model picks action + rate from full history, guards clamp). This spec's new
  fields are **easy to populate in `llm` mode, harder in `rules` mode** — see §6.

### The exact seam (line numbers, `server/src/engine/executors/negotiation.ts`)

- **Line 314 — capture point:** `const { outcome, message, proposedRate } = await agent.negotiate(...)`
  — everything else from the response is dropped here.
- **Three forward points — the `extra` objects handed to `agent.draftEmail(...)`:**
  - **PRESENT_OFFER** — lines 329–333, purpose `"counter_offer"`
  - **ACCEPT** — lines 414–418, purpose `"onboarding"` or `"acceptance"`
    (only reached on **legacy graphs**; when `hasPostAcceptEmailNode` is true —
    line 389 — the acceptance email is sent by a downstream Content Brief node and
    this branch does NOT call `/draft`)
  - **COUNTER** — lines 519–525, purpose `"counter_offer"`
- **Line 518 — the redundant parse:** `extractRequestedRate(creatorReply)`
  (regex, defined lines 93–123) re-extracts the creator's rate independently of
  `/negotiate`. Left in place as a safe deterministic backstop.

### What each branch forwards today (the inconsistency)

| Field passed to `/draft`      | present_offer | accept | counter |
|-------------------------------|:---:|:---:|:---:|
| `proposedTerms.rate`          | ✅ | ✅ | ✅ |
| `creatorReply` (raw text)     | ✅ | ✅ | ✅ |
| `dealDescription`             | ✅ | ✅ | ✅ |
| `creatorRequestedRate`        | ❌ | ❌ | ✅ |
| `round`                       | ❌ | ❌ | ✅ |
| **question list**             | ❌ | ❌ | ❌ |
| **pushed fixed terms**        | ❌ | ❌ | ❌ |

Note: `present_offer` — the most question-heavy branch — has the **thinnest**
handoff. Normalizing this is part of the change.

---

## 3. The change, in one sentence

Have `/negotiate` **emit its comprehension as two structured fields**, thread them
through the executor into all three `/draft` call sites, and have `/draft`'s offer
prompt **answer against that explicit checklist** instead of re-parsing raw text.

---

## 4. New fields — canonical definition

| Field | Type | Meaning | Produced by |
|---|---|---|---|
| `creatorQuestions` | `list[str]` / `string[]` | Every distinct question or request the creator raised this message, one per element (e.g. `["what is the fee?", "when does content go live?", "can I get 15% commission?"]`). Empty list = none. | `/negotiate` model output |
| `pushedFixedTerms` | `list[str]` / `string[]` | Which **fixed** (non-negotiable) terms the creator tried to change, drawn from the closed vocabulary `"commission" \| "perk" \| "deliverables" \| "timeline"`. Empty = none pushed. | `/negotiate` model output |

**Type decisions (deliberate — do not "tighten" these):**

1. **Non-optional with default `[]`** (not `Optional[...] = None`). Empty list =
   "the model looked and found none," which is distinct from "field absent." A
   default `[]` is backward-compatible with old callers and lets `/draft` iterate
   without a `None` guard.
2. **`pushedFixedTerms` stays a plain `list[str]`, NOT a Pydantic `Literal`.**
   Pin the four-value vocabulary in the **prompt** and normalize in **code** — the
   same pattern `_NegotiateDecisionLLMOutput.action` uses (loose `str`, normalized
   by `_apply_decision_guards`). A `Literal[...]` would 422 the entire negotiate
   call if the model emitted `"commission rate"` instead of `"commission"` — i.e.
   fail a money decision over copy-metadata. Keep the schema loose; normalize the
   values in code before use.

---

## 5. Field-by-field spec — the five declaration sites

The same two fields must be declared in **five** places to survive two languages
and two HTTP hops. Listed in data-flow order.

### End 1 — `/negotiate` OUTPUT (producer). File: `agent/app/routes/negotiate.py`

**5.1 `_NegotiateDecisionLLMOutput`** (llm-mode model output, ~lines 147–172)
```python
class _NegotiateDecisionLLMOutput(BaseModel):
    action: str
    rate: Any | None = None
    response: str
    reasoning: str | None = None
    creatorQuestions: list[str] = []   # NEW
    pushedFixedTerms: list[str] = []   # NEW
```
Also add the two keys to the `## Output` JSON block of `_LLM_NEGOTIATE_PROMPT`
(~lines 676–680) and instruct the model to enumerate questions and tag pushed
fixed terms from the closed vocabulary. No new field validator (empty list valid).

**5.2 `_NegotiateLLMOutput`** (rules-mode model output, ~lines 126–137)
```python
class _NegotiateLLMOutput(BaseModel):
    intent: str
    response: str
    creatorRateMentioned: Any | None = None
    confidence: float | None = None
    creatorQuestions: list[str] = []   # NEW (see §6 — rules-mode phasing)
    pushedFixedTerms: list[str] = []   # NEW
```
Populating these in rules mode requires adding question/term extraction to
`_NEGOTIATE_PROMPT` (the classify prompt, ~lines 791–901). If deferred, they stay
`[]` in rules mode (safe — see §6).

**5.3 `NegotiateResponse`** (public wire response, ~lines 119–123)
```python
class NegotiateResponse(BaseModel):
    action: NegotiationAction
    proposedTerms: dict[str, Any] | None = None
    responseDraft: str | None = None
    reasoning: str | None = None
    creatorQuestions: list[str] = []   # NEW
    pushedFixedTerms: list[str] = []   # NEW
```
Both negotiate paths (`_llm_negotiate_decision`, `_rules_negotiate`) must copy the
values from their internal `_Negotiate*LLMOutput` onto this response.

### Bridge — TS adapter. File: `server/src/adapters/negotiation/types.ts`

**5.4 `NegotiationResponse`** (~lines 56–61) — what the executor destructures
```typescript
export interface NegotiationResponse {
  action: NegotiationAction;
  proposedTerms?: NegotiationTerm;
  responseDraft?: string;
  reasoning?: string;
  creatorQuestions?: string[];   // NEW
  pushedFixedTerms?: string[];   // NEW
}
```

**5.5 `DraftRequest`** (~lines 67–105) — the object handed to `/draft`
```typescript
export interface DraftRequest {
  // ... existing fields ...
  dealDescription?: string | undefined;
  creatorQuestions?: string[] | undefined;   // NEW
  pushedFixedTerms?: string[] | undefined;    // NEW
}
```
Optional (`?:`) on the TS side — no runtime defaults; use-sites coalesce with `?? []`.

### End 2 — `/draft` INPUT (consumer). File: `agent/app/routes/negotiate.py`

**5.6 `DraftRequest`** (~lines 175–208)
```python
class DraftRequest(BaseModel):
    # ... existing fields ...
    dealDescription: str | None = None
    # NEW — creator's questions, extracted upstream so /draft answers an explicit
    # checklist instead of re-parsing the raw reply.
    creatorQuestions: list[str] = []
    # NEW — fixed terms the creator pushed on (commission|perk|deliverables|
    # timeline), so the copy ACKNOWLEDGES the ask ("we can't move to 15%") rather
    # than silently restating the fixed value.
    pushedFixedTerms: list[str] = []
```

> Note: there are **two `DraftRequest` types** (Python 5.6 and TS 5.5). Both need
> the fields, matched by JSON key name.

---

## 6. Executor wiring (`server/src/engine/executors/negotiation.ts`)

**6.1 Capture — line 314.** Extend the destructure:
```typescript
const { outcome, message, proposedRate, creatorQuestions, pushedFixedTerms }
  = await agent.negotiate(instance.negotiationRound, config, creatorReply, priorContext);
```

**6.2 Forward — all three `extra` objects.** Spread the fields into each, using
`?? []` so absent (rules mode) becomes an empty array:
- **present_offer** (lines 329–333)
- **accept** (lines 414–418) — legacy-graph branch only
- **counter** (lines 519–525)

```typescript
// applies to each `extra` / inline object handed to agent.draftEmail(...)
{
  // ... existing spreads ...
  ...(creatorQuestions?.length ? { creatorQuestions } : {}),
  ...(pushedFixedTerms?.length ? { pushedFixedTerms } : {}),
}
```

**6.3 Normalize the three branches (cleanup, recommended).** Give `present_offer`
and `accept` the `creatorRequestedRate` that only `counter` has today (via the
existing `extractRequestedRate(creatorReply)` — it's already computed for the
guard call at lines 350/437). This removes the "present_offer is the thinnest
handoff" inconsistency and is low-risk (deterministic regex, allowlisted by the
guard).

**Do NOT touch:** line 518's `extractRequestedRate` (safe backstop),
`guardConstraintsFromConfig` / `scanOutboundDraft` (floor/ceiling withholding).

---

## 7. Consumer behavior (`_build_offer_prompt`, negotiate.py ~lines 1420–1575)

`_build_offer_prompt` already has strong scaffolding: it acknowledges the
requested rate (`ack_clause_fmt`), answers product questions (`brand_goal`), has a
dedicated fixed-terms point (`fixed_terms_goal`, ~line 1538), and pins the
commission against the creator's number (`commission_guard`, ~lines 1481–1487).
The change makes these fire **precisely** instead of on generic heuristics:

1. **`creatorQuestions`** → render an explicit "You must answer EACH of the
   following the creator asked: 1) … 2) … 3) …" checklist, replacing reliance on
   the model re-parsing `creatorReply`.
2. **`pushedFixedTerms`** → the `fixed_terms_goal` block currently fires whenever
   the campaign *has* fixed terms. Change it to fire when the creator *actually
   pushed* one (i.e. when `pushedFixedTerms` is non-empty), and name the specific
   term(s) they pushed so the copy acknowledges the ask rather than silently
   restating the fixed value. This directly closes the Case-10 gap.

`creatorReply` stays passed (useful for tone/continuity), but comprehension no
longer depends on re-parsing it.

---

## 8. Phasing & rules-mode stance

Ship in two phases to de-risk:

- **Phase 1 (llm mode only):** implement 5.1, 5.3, 5.4, 5.5, 5.6, §6, §7. In llm
  mode the model already reads the whole message, so emitting the two fields is
  nearly free. Rules mode emits `[]` (fields default), and `/draft` keeps its
  current raw-reply behavior there — **the audited deterministic path is
  unchanged.** llm mode (the path the eval exercises) gets the improvement.
- **Phase 2 (rules-mode parity, optional):** implement 5.2 by adding question/
  fixed-term extraction to `_NEGOTIATE_PROMPT`. No schema change needed — the
  fields already default to `[]`, so Phase 2 is purely prompt work.

---

## 9. Testing / acceptance

Re-run the eval suite (`agent/tests/negotiation_eval/run_eval.py`) against
`NEGOTIATION_STRATEGY=llm` and check:

1. **Case 10** — sent email now *acknowledges* the 15%-commission and 2-pairs asks
   as fixed ("the commission is set at 10% and can't be adjusted…"), not just
   lists the values.
2. **Case 21** — sent email answers all four points (fee, deliverables, timeline,
   commission) with no omission.
3. **No new leaks** — the "Sent-leak?" column stays clean (§ withholding preserved;
   `scanOutboundDraft` still runs).
4. **Regression** — rules-mode behavior byte-identical in Phase 1 (fields empty).
5. **Unit** — `_build_offer_prompt` renders the checklist when `creatorQuestions`
   is populated and the acknowledgement when `pushedFixedTerms` is populated;
   renders as today when both are empty.

## 10. Summary checklist

| # | File | Symbol | Change |
|---|---|---|---|
| 5.1 | `agent/app/routes/negotiate.py` | `_NegotiateDecisionLLMOutput` + `_LLM_NEGOTIATE_PROMPT` output block | add 2 fields; emit in llm mode |
| 5.2 | `agent/app/routes/negotiate.py` | `_NegotiateLLMOutput` + `_NEGOTIATE_PROMPT` | add 2 fields (Phase 2: emit in rules mode) |
| 5.3 | `agent/app/routes/negotiate.py` | `NegotiateResponse` | add 2 fields; both paths copy through |
| 5.4 | `server/src/adapters/negotiation/types.ts` | `NegotiationResponse` | add 2 optional fields |
| 5.5 | `server/src/adapters/negotiation/types.ts` | `DraftRequest` | add 2 optional fields |
| 5.6 | `agent/app/routes/negotiate.py` | `DraftRequest` | add 2 fields |
| 6.1 | `server/src/engine/executors/negotiation.ts` | line 314 | capture both fields in destructure |
| 6.2 | `server/src/engine/executors/negotiation.ts` | lines 329/414/519 | spread both fields into all 3 `extra` objects |
| 6.3 | `server/src/engine/executors/negotiation.ts` | lines 329/414 | also add `creatorRequestedRate` for parity (cleanup) |
| 7 | `agent/app/routes/negotiate.py` | `_build_offer_prompt` | render question checklist + fire fixed-term ack on `pushedFixedTerms` |

---

## 11. Implementation notes (as built)

Both phases landed. Every §10 item is done. Two things the spec's line-numbered
plan did not surface, discovered while wiring the real seam:

- **`LangGraphNegotiationProvider.negotiate` reconstructs the response
  field-by-field** (`server/src/adapters/negotiation/LangGraphNegotiationProvider.ts`).
  It does NOT forward the raw JSON — it hand-copies `action`/`proposedTerms`/
  `responseDraft`/`reasoning`. So Python emitting the two fields is not enough:
  the adapter must explicitly copy `creatorQuestions`/`pushedFixedTerms` from the
  HTTP JSON or they are silently dropped before the executor ever sees them. This
  was added (with a string-array type guard). `draft()` forwards the whole request
  object, so the `DraftRequest` fields flow automatically — only the negotiate
  RESPONSE needed the explicit copy.
- **Two more TS hops carry the field between §5.4 and §6.1:** `NegotiateResult`
  (`server/src/engine/types.ts`) — the shape the executor actually destructures —
  and `mapNegotiationResponse` (`server/src/engine/providers.ts`), which maps the
  wire response into it per outcome. Both got the two fields. `draftEmail`'s
  `extra` type + request build were extended in BOTH `providerFactory.ts` (real)
  and the `providers.ts` interface; the mock `draftEmail` ignores `extra` and was
  left as-is.

**Code normalization (spec §4.2):** `pushedFixedTerms` is normalized to the closed
vocabulary in `_normalize_pushed_terms` (maps synonyms like "commission rate" →
"commission", drops garbage, de-dupes); `creatorQuestions` is trimmed/de-duped by
`_normalize_questions`. Both negotiate paths call these before the values leave the
producer, so the executor and `/draft` always get clean data. The TS side keeps the
schema loose (optional `string[]`, no runtime default) and coalesces with `?? []`.

**§7 consumer:** `_build_offer_prompt` now renders a numbered "The creator asked
the following …" checklist from `creatorQuestions`, and the fixed-terms point fires
on non-empty `pushedFixedTerms` (naming the specific pushed term + its fixed value)
instead of firing whenever the campaign merely HAS fixed terms. When both fields are
empty the built prompt is byte-identical to before (regression-tested), so the
audited path is unchanged.

**Tests:** `agent/tests/test_offer_prompt_rules.py` gained 6 unit tests (checklist
renders; pushed-term ack renders + names the term + normalizes synonyms; both blocks
absent when empty; byte-identical-when-empty guard). Full agent suite: 143 passed,
8 skipped (live-model). Server `tsc --noEmit`: clean except one pre-existing,
unrelated error in `src/routes/queues.ts` (`mockIntent`). Live probe against
`qwen3:8b` (NEGOTIATION_STRATEGY=llm) confirmed `/negotiate` emits
`creatorQuestions`/`pushedFixedTerms` correctly for a multi-question + fixed-term-
pushing message.
