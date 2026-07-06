# Reply Classification Layer

In-depth reference for the **reply-intent classification layer** of the Pluvus
workflow prototype: every class, function, gate, and decision boundary, plus how
a creator's email reply travels from raw text to a privileged state transition.

> **TL;DR** — A creator's email reply is untrusted input. The classifier turns it
> into one of five intents (`POSITIVE` / `NEGATIVE` / `QUESTION` / `OPT_OUT` /
> `UNKNOWN`). The *intent directly drives a state transition* (continue
> negotiating, reject, opt out for compliance, or send to a human). Because a
> wrong label has real consequences (a missed opt-out is a CAN-SPAM/GDPR
> violation; a mislabeled price kills a live deal), the layer is built around one
> rule: **never let raw model output drive a privileged transition without a
> deterministic, model-independent sanity gate.**

---

## 1. The big picture — where classification sits

Classification is invoked when a creator **replies** to an outreach email. The
TypeScript workflow engine detects the reply, asks the classifier for an intent,
and routes the instance accordingly.

```
 Creator reply (email)
        │
        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  TypeScript server (workflow engine)                                   │
│                                                                        │
│  executeReplyDetection()                                               │
│    ├─ if negotiationRound >= 1 → skip classify, go to NEGOTIATION      │
│    └─ else  agent.classify(replyBody)                                  │
│                  │                                                      │
│                  ▼                                                      │
│        AgentProviderAdapter.classify()  ── try/catch → degrade safe    │
│                  │                                                      │
│        ClassificationProvider (picked by AGENT_PROVIDER env)           │
│          ├─ "mock"      → MockClassificationProvider  (keyword, no LLM)│
│          └─ "langgraph" → LangGraphClassificationProvider ──HTTP──┐    │
└───────────────────────────────────────────────────────────────────┼───┘
                                                                     │ POST /classify
                                                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Python agent service (FastAPI + LangGraph)                            │
│                                                                        │
│  POST /classify → classify_message()                                   │
│    1. sanitize_creator_text()      (normalize + bound)                 │
│    2. looks_like_opt_out()  → force OPT_OUT      (compliance)          │
│    3. looks_like_injection()→ force UNKNOWN      (security)            │
│    4. mentions_rate()       → force POSITIVE     (don't kill a deal)   │
│    5. looks_like_question() → force QUESTION     (engaged-but-asking)  │
│    6. _langgraph_classify() → LLM + schema validation                 │
│       └─ low-confidence (<0.50) → force UNKNOWN                        │
└──────────────────────────────────────────────────────────────────────┘
                  │
                  ▼  { intent, confidence, reasoning }
        back to executeReplyDetection() → state transition
```

The deterministic gates (steps 2–5) run **in code, before the model**. They are
the real guarantee; the LLM is only consulted for the genuinely ambiguous middle.

---

## 2. The five intents

`ReplyIntent` is the closed enum every layer agrees on. Defined identically in
Python (`Literal`) and TypeScript (`ReplyIntentValue`).

| Intent | Meaning | Resulting state (engine) |
|---|---|---|
| `POSITIVE` | Interested in collaborating — **includes naming a price/rate** ("I charge $480"). A number means engaged, not declining. | `NEGOTIATING` |
| `NEGATIVE` | Actually refusing ("no thanks", "not a good fit"). A bare price is **not** a refusal. | `REJECTED` (terminal) |
| `QUESTION` | Has a question, hasn't committed either way ("what's the budget?"). Still engaged. | `NEGOTIATING` |
| `OPT_OUT` | Wants to stop receiving email. Legally significant. | `OPTED_OUT` (terminal) |
| `UNKNOWN` | Genuinely ambiguous, low-confidence, or flagged for safety. | `MANUAL_REVIEW` (human) |

The critical design point: **`POSITIVE` and `QUESTION` both continue the deal**,
`NEGATIVE` and `OPT_OUT` are terminal, and `UNKNOWN` is the safe escape hatch to a
human. The whole layer is biased so that *when in doubt, a human looks* — never
"guess and auto-advance".

---

## 3. The decision pipeline (`classify_message`)

File: `agent/app/routes/classify.py` → `classify_message(message: str)`.

This is pure orchestration over the gates and the LLM call — unit-testable with a
fake LLM. **Order is deliberate and load-bearing.**

```python
def classify_message(message: str) -> ClassifyResponse:
    clean = sanitize_creator_text(message)              # 1

    if looks_like_opt_out(clean):                       # 2  → OPT_OUT  (conf 1.0)
        return OPT_OUT
    if looks_like_injection(clean):                     # 3  → UNKNOWN  (conf 0.0)
        return UNKNOWN
    if mentions_rate(clean):                            # 3.5 → POSITIVE (conf 1.0)
        return POSITIVE
    if looks_like_question(clean):                      # 3.6 → QUESTION (conf 1.0)
        return QUESTION

    result = _langgraph_classify(clean)                 # 4  LLM + schema
    if result.confidence < LOW_CONFIDENCE_THRESHOLD:    #     low-confidence gate
        result = UNKNOWN
    return result
```

### Step-by-step

1. **Sanitize** (`sanitize_creator_text`). Untrusted text is normalized and
   bounded *before it can reach a prompt*. Everything downstream operates on the
   clean string.

2. **OPT_OUT gate** (`looks_like_opt_out`). Decided **by code, never the model**.
   If the text clearly opts out, return `OPT_OUT` at confidence `1.0` and stop.
   Compliance-critical: no prompt injection can *suppress* an opt-out because the
   model is never asked. (CAN-SPAM / GDPR.)

3. **Injection gate** (`looks_like_injection`). If the text looks like a
   jailbreak / instruction-injection attempt, do **not** trust the model to
   auto-advance state. Return `UNKNOWN` at confidence `0.0` → routes to
   `MANUAL_REVIEW`. Note the ordering: an opt-out that *also* contains injection
   still opts out, because step 2 already returned.

4. **Rate-statement gate** (`mentions_rate`, step 3.5). A creator stating a price
   ("I charge 480 dollars") is **engaged in the deal**, not declining. Small/local
   models sometimes mislabel a bare price as `NEGATIVE`, which would wrongly
   terminate the instance at `REJECTED` and never let the negotiation agent
   compare the rate to the band. This gate forces `POSITIVE`. Conservative:
   suppressed when rejection language is present.

5. **Question gate** (`looks_like_question`, step 3.6). A creator asking about the
   product/budget/terms is engaged-but-asking. Small models return `UNKNOWN` /
   low confidence on question-heavy replies, pushing them to `MANUAL_REVIEW`
   needlessly. This gate forces `QUESTION` so they reach the negotiation agent.
   Conservative: suppressed when rejection language is present.

6. **LLM path** (`_langgraph_classify`). Only the genuinely ambiguous middle
   reaches the model. The output is validated against a schema (see §6). After,
   the **low-confidence gate**: if `confidence < 0.50`, override to `UNKNOWN` so
   the reply is reviewed rather than auto-advanced on a weak signal.

> **Why gates *before* the model?** The model is fooled or wrong some of the time,
> and on this path "wrong" means a privileged, sometimes irreversible transition.
> The gates encode the cases where correctness matters most (compliance, security,
> not killing a live deal) in deterministic code that an injection or a flaky model
> cannot override.

---

## 4. The Python layer — files & classes

All under `agent/app/`.

### 4.1 `routes/classify.py` — the route and orchestrator

| Symbol | Kind | Role |
|---|---|---|
| `ReplyIntent` | `Literal` type | The five-value intent enum. |
| `LOW_CONFIDENCE_THRESHOLD = 0.50` | const | Below this, override to `UNKNOWN`. |
| `ClassifyRequest` | Pydantic model | Request body: `{ message: str }`. |
| `ClassifyResponse` | Pydantic model | Response: `{ intent, confidence, reasoning? }`. The public contract. |
| `_ClassifyLLMOutput` | Pydantic model | **Schema the raw model output is validated against** (FIX-6). `intent` must be a valid enum value; `confidence` is coerced to float and clamped to `[0,1]`. |
| `_CLASSIFY_PROMPT` | str template | The classification prompt. Creator text is wrapped in `<creator_reply>` tags and the model is told to treat it as *data, never instructions* (FIX-7 prompt-side delimiting). |
| `_langgraph_classify(message)` | function | Builds a one-node LangGraph `StateGraph`, runs the LLM via `invoke_structured`, and fails **safe to `UNKNOWN`/0.0** on schema failure. |
| `classify_message(message)` | function | The full pipeline of §3. The unit-testable core. |
| `classify(req)` | FastAPI route | `POST /classify`, guarded by `require_api_key` + `rate_limiter("classify")`. Wraps `classify_message`; any exception → HTTP 500. |

**`_ClassifyLLMOutput` — confidence coercion:**

```python
class _ClassifyLLMOutput(BaseModel):
    intent: ReplyIntent          # invalid value → validation error → model retry
    confidence: float = 0.5
    reasoning: str | None = None

    @field_validator("confidence", mode="before")
    @classmethod
    def _coerce_confidence(cls, v):
        try:
            f = float(v)             # tolerate "0.94" strings
        except (TypeError, ValueError):
            return 0.5
        return max(0.0, min(1.0, f)) # clamp to [0,1]
```

An invalid `intent` does **not** leak through as a wrong-but-trusted label — it
fails validation, which forces a model retry, and on total failure the route
falls to `UNKNOWN`. (Verified by `test_injection_cannot_force_invalid_intent_label`.)

**`_langgraph_classify` — why a graph for one node?** The route models classify as
a single-node `StateGraph` (`classify → END`). It's deliberately minimal now but
gives a place to grow multi-step classification later without restructuring the
route. The node calls `invoke_structured(llm, prompt, _ClassifyLLMOutput,
retries=2)` and catches `StructuredOutputError` → `UNKNOWN`/0.0.

### 4.2 `injection.py` — the model-independent defense layer

This is **the enforcement that does not depend on the model obeying anything**.
Pure functions, no LLM.

| Symbol | Role |
|---|---|
| `MAX_CREATOR_TEXT_CHARS = 4000` | Hard cap on creator text fed to the model. Long enough for any genuine reply, short enough to blunt a padded adversarial payload. |
| `sanitize_creator_text(text)` | NFKC-normalize (collapse homoglyph/fullwidth tricks) → strip control chars (keep tab/newline/CR) → collapse >2 blank lines → cap length → `strip()`. Pure & deterministic. |
| `looks_like_opt_out(text)` | Deterministic keyword scan (`_OPT_OUT_RE`). Forces `OPT_OUT`. Mirrors the TS `MockClassificationProvider` so both classifiers agree. |
| `looks_like_injection(text)` | Heuristic for instruction-injection patterns ("ignore previous instructions", "you are now", "reveal your budget/ceiling", …). A hit means the model's output must not be trusted to auto-advance → caller routes to `MANUAL_REVIEW`. |
| `looks_like_question(text)` | Product/deal question phrases **and no rejection language** → force `QUESTION`. |
| `mentions_rate(text)` | An unambiguous price *statement* (`$480`, `480 dollars`, "my rate is …", or a bare amount) **and no rejection language** → force `POSITIVE`. |

**Pattern groups (regex):**

- `_OPT_OUT_PATTERNS` — unsubscribe, opt out, remove me, stop emailing, do not
  contact, etc. Mirrors the TS opt-out keywords.
- `_INJECTION_PATTERNS` — ignore/disregard/forget previous instructions, "you are
  now", "new instructions", "system prompt", "respond with intent …", "set your
  confidence to …", "reveal … floor/ceiling/budget", etc.
- `_QUESTION_PATTERNS` — "what is the product/budget/rate", "how much do you pay",
  "tell me more", "quick question", "before I commit", etc.
- `_RATE_STATEMENT_PATTERNS` — "I charge $X", "my rate is X", "I'd do it for X",
  "rate: X", or a reply that is essentially just an amount.
- `_REJECTION_PATTERNS` — "no thanks", "not interested", "not a good fit", "I'll
  pass", "I can't", "decline", "too low", "way more". **Used to suppress** the
  question and rate gates so e.g. "no thanks, I'd need way more than 480" is **not**
  force-classified `POSITIVE`/`QUESTION` — it falls through to the model.

The `_AMOUNT` sub-pattern recognizes `$480`, `480 dollars`, `480 usd`, `1,500`,
`480.00`, `480 bucks`.

> **Why a rejection suppressor?** The rate and question gates are aggressive
> "force a continue-the-deal label" shortcuts. Without the suppressor, a refusal
> that happens to contain a number or a question mark would be force-labeled as
> engaged. Suppressing on rejection language keeps the gates conservative: they
> only fire on an unambiguous "I'm naming my number" / "I'm asking a question"
> reply, and anything with refusal cues is handed to the model to judge.

### 4.3 `structured.py` — schema-enforced output with bounded retry (FIX-6)

Replaces the old "json.loads, else brace-regex scrape, else regex-guess a field"
free-text parsing — which could silently latch onto the wrong value — with the
production pattern:

```
parse → validate against Pydantic schema → on failure, RE-ASK the model
(bounded retries) → raise StructuredOutputError if still invalid.
```

| Symbol | Role |
|---|---|
| `StructuredOutputError(ValueError)` | Raised when the model can't produce schema-valid output within the attempt budget. Carries `raw` last output for logging. |
| `LLMTimeoutError(StructuredOutputError)` | Raised when a single `llm.invoke` exceeds the wall-clock budget. Subclass so existing `except StructuredOutputError` callers keep working. |
| `extract_json_object(raw)` | Parse step only. Strips `<think>…</think>` (qwen3), ```` ```json ```` fences, leading/trailing prose; falls back to first balanced-looking brace span. Result is still schema-validated by the caller. |
| `invoke_structured(llm, prompt, schema, retries=2)` | The core. Tries `1 + retries` times; each retry appends a short repair instruction. Returns a validated `schema` instance or raises `StructuredOutputError`. |
| `_invoke_with_timeout(llm, ask)` | (FIX-9) Runs `llm.invoke` on a shared `ThreadPoolExecutor` with a wall-clock bound so a hung generation can't pin the FastAPI worker. Timeout → `LLMTimeoutError` (a *transport* failure, **not** malformed output — it propagates instead of burning a retry). |
| `_LLM_EXECUTOR` | Shared worker pool (max 8) bounding `llm.invoke` calls. |
| `_invoke_timeout_seconds()` | Reads `LLM_INVOKE_TIMEOUT_SECONDS` (default 60; `0`/unset disables). |

How the classifier uses this: `invoke_structured(llm, prompt, _ClassifyLLMOutput,
retries=2)`. So a single classify can call the model up to **3 times** (initial +
2 repairs) before giving up and failing safe to `UNKNOWN`.

### 4.4 `llm.py` — provider switch, failover, model pinning (FIX-8)

Every route gets its chat model from `get_llm()`. Switching providers is
**env-only — no code edits**.

| Symbol | Role |
|---|---|
| `get_llm(temperature=0.2)` | Public entry. Returns the primary chat model directly (zero overhead) or, if a fallback is configured, a `FailoverChat`. The classifier calls `get_llm(temperature=0)` for determinism. |
| `FailoverChat` | Tries an ordered list of `(label, factory)` candidates on every `invoke`; on failure falls over to the next (logged). Models built lazily and cached. |
| `_make_ollama(temperature)` | Builds `ChatOllama`. |
| `_make_openai(temperature)` | Builds `ChatOpenAI` (clear error if SDK/key missing). |
| `_ollama_model_id()` | Resolves model id, optionally **pinning an immutable digest** (`model@sha256:…`) so a later `ollama pull` can't silently change decision-path behavior. |
| `_candidate_chain()` | `[LLM_PROVIDER]` + optional `LLM_FALLBACK_PROVIDER` (dedup/blank-dropped). |

Lazy imports mean you only need the SDK for the provider(s) you actually select.

### 4.5 `security.py` — auth + rate limiting on the route (FIX-12)

The `POST /classify` route is guarded by two FastAPI dependencies, both env-gated
so local dev/harnesses work with zero config:

| Symbol | Role |
|---|---|
| `require_api_key` | Checks a shared secret (`AGENT_API_KEY`) via `Authorization: Bearer` or `X-API-Key`. Constant-time compare (`hmac.compare_digest`). No-op + one-time warning when unset. 401 on miss. |
| `rate_limiter(name)` | Builds a per-`(route, client)` fixed-window limiter dependency. 429 + `Retry-After` on breach. Dependency-free, in-process. |
| `_FixedWindowLimiter` | The counter. Thread-safe; injectable clock for tests. |

Defaults: 60 requests / 60s per client per route (`AGENT_RATE_LIMIT`,
`AGENT_RATE_WINDOW_SECONDS`). Client identity prefers the API key, falls back to
peer IP.

---

## 5. The TypeScript layer — how the server consumes a classification

All under `server/src/`. The engine never calls the Python service directly; it
goes through a provider abstraction so the LLM path and the mock path are
interchangeable.

### 5.1 The provider abstraction

| Symbol | File | Role |
|---|---|---|
| `ReplyIntentValue` | `adapters/classification/types.ts` | TS mirror of the five-intent enum. |
| `ClassificationRequest` / `ClassificationResponse` | same | The `{message}` → `{intent, confidence, reasoning?}` contract. |
| `ClassificationProvider` | `adapters/classification/ClassificationProvider.ts` | The interface: `classify(req) → Promise<ClassificationResponse>`. |
| `MockClassificationProvider` | `…/MockClassificationProvider.ts` | **Keyword-based, no LLM.** Deterministic. Order: OPT_OUT → NEGATIVE → POSITIVE → QUESTION → else UNKNOWN. Confidence 0.95/0.85/0.50. |
| `FixedClassificationProvider` | same file | Always returns a fixed intent — for harness scenarios. |
| `LangGraphClassificationProvider` | `…/LangGraphClassificationProvider.ts` | Calls `POST /classify` on the Python service via `agentPostJson`. **Strictly validates** the response (`isValidIntent` + numeric confidence) and **throws** on anything malformed — no silent mock fallback in prod. |

**Provider selection** (`engine/providerFactory.ts` → `classificationProvider()`):

```
AGENT_PROVIDER=mock       (default) → MockClassificationProvider   (keyword, offline)
AGENT_PROVIDER=langgraph            → LangGraphClassificationProvider (HTTP → Python)
```

### 5.2 The transport (`adapters/agentServiceClient.ts`)

`agentPostJson(baseUrl, "/classify", { message })` centralizes:

- **Base URL** — `AGENT_SERVICE_URL` (default `http://localhost:8000`).
- **Auth** — `AGENT_API_KEY` → `Authorization: Bearer …` (matches the Python
  service's env-gated auth).
- **Timeout** — `AGENT_TIMEOUT_MS` (default 30 000) via `AbortSignal.timeout`. The
  interactive reply path fails fast instead of holding a worker for two minutes.
- **Circuit breaker** (FIX-9) — one shared `CircuitBreaker` guards the whole agent
  service. After `AGENT_CB_FAILURE_THRESHOLD` (default 5) consecutive failures it
  opens for `AGENT_CB_COOLDOWN_MS` (default 30 000), fast-failing instead of
  hammering a dead backend.

### 5.3 Graceful degradation (`AgentProviderAdapter.classify`)

The `LangGraphClassificationProvider` is intentionally **strict** (throws on
malformed). The degrade-to-safe behavior lives one layer up, at the orchestration
seam, so the strict provider keeps its strict validation:

```ts
async classify(body) {
  try {
    const result = await this.classifier.classify({ message: body });
    return { intent: result.intent, confidence: result.confidence };
  } catch (err) {
    // Agent service down / breaker open / malformed → degrade to UNKNOWN/0.
    // The low-confidence gate then routes to MANUAL_REVIEW — never strands
    // the instance at REPLY_RECEIVED.
    return { intent: "UNKNOWN", confidence: 0 };
  }
}
```

So **an agent-service outage becomes "route to a human", never "lose or strand"**.

### 5.4 Intent → state transition (`engine/executors/replyDetection.ts`)

This is where the intent actually moves the workflow.

```
intent      → nextState        notes
─────────────────────────────────────────────────────────────────────
POSITIVE    → NEGOTIATING      go to the negotiation node
QUESTION    → NEGOTIATING      same — engaged, agent answers in the reply
NEGATIVE    → REJECTED         terminal (completedAt set)
OPT_OUT     → OPTED_OUT        terminal (compliance)
UNKNOWN     → MANUAL_REVIEW    terminal until a human acts; emits
            (default)          MANUAL_REVIEW_FLAGGED
```

Two important details:

1. **The low-confidence gate is enforced again here** (`LOW_CONFIDENCE_THRESHOLD =
   0.50`). Even if a provider returns a confident-looking intent below threshold,
   the executor overrides it to `UNKNOWN`. Belt-and-suspenders with the Python
   side. The raw confidence is still persisted on the message.

2. **Active-negotiation short-circuit.** A reply that arrives *after* at least one
   counter has been sent (`negotiationRound >= 1`) is a **negotiation turn, not a
   fresh first reply**. It skips classification entirely and goes straight to the
   negotiation agent (which compares the stated rate to the band). This is what
   stops a plain "I charge 480 dollars" mid-negotiation from being re-classified
   and wrongly `REJECTED`. Only the *first* reply (round 0) goes through the
   classifier.

   ```ts
   if (instance.negotiationRound >= 1) {
     return { nextState: "NEGOTIATING", /* routedToNegotiation: true */ };
   }
   ```

---

## 6. Schema enforcement & failure modes — exactly what happens when

A walk through every way the LLM path can go wrong and where it lands. (All
verified by `agent/tests/test_classify_structured.py`.)

| Model output | What happens | Final result |
|---|---|---|
| Valid JSON, valid intent, e.g. `{"intent":"POSITIVE","confidence":0.92}` | Parsed, schema-validated, returned. | `POSITIVE` @ 0.92 |
| `confidence: "1.5"` (string, out of range) | Coerced to float, clamped. | conf `1.0` |
| Invalid intent then valid on retry, e.g. `MAYBE` → `QUESTION` | First fails validation → repair re-ask → second validates. | `QUESTION` |
| Invalid intent every attempt, e.g. `IGNORE_PREVIOUS` ×3 | All fail validation → `StructuredOutputError`. | **`UNKNOWN` @ 0.0** → MANUAL_REVIEW |
| Unparseable garbage every attempt | No JSON object found, all attempts fail. | **`UNKNOWN` @ 0.0** → MANUAL_REVIEW |
| `llm.invoke` hangs past budget | `LLMTimeoutError` propagates (not retried — it's transport, not bad output). Caught by route → 500; TS adapter degrades to `UNKNOWN`/0. | MANUAL_REVIEW |
| Valid but `confidence < 0.50` | Low-confidence gate overrides. | `UNKNOWN` |

The throughline: **there is no path where a malformed or untrusted output becomes
a confident, trusted, auto-advancing label.** Every failure funnels to
`UNKNOWN` → `MANUAL_REVIEW`.

---

## 7. The two classifier implementations (and why both exist)

| | `MockClassificationProvider` (TS) / `reference_classifier` (Py) | LLM path (`classify_message` → Ollama/OpenAI) |
|---|---|---|
| **LLM?** | No — pure keyword/regex | Yes (gated) |
| **Determinism** | Fully deterministic | Deterministic gates + non-deterministic model middle |
| **Used for** | Default local dev (`AGENT_PROVIDER=mock`), offline CI, the eval **regression tripwire** | Production-quality classification (`AGENT_PROVIDER=langgraph`) |
| **Keyword agreement** | OPT_OUT keywords mirror the Python `_OPT_OUT_RE` so both sides agree | Shares the same Python gates |

The keyword lists are intentionally mirrored across `MockClassificationProvider.ts`,
`injection.py`, and `eval/reference_classifier.py` so the mock, the production
gates, and the CI gate all agree on what an opt-out (etc.) looks like.

---

## 8. Evaluation & accuracy gate (FIX-5)

Lives in `agent/eval/` (see `agent/eval/README.md` for full detail). The short
version:

- `dataset_v1.jsonl` — versioned, labeled, synthetic eval set (no real PII)
  covering all five intents + hard/ambiguous + injection cases.
- `scorer.py` — confusion matrix, per-intent precision/recall/F1, macro-F1.
- `reference_classifier.py` — the deterministic rule path (reuses the production
  FIX-7 gates). What CI gates on.
- `tests/test_eval_gate.py` — fails the build if macro-F1, any per-intent F1, or
  **OPT_OUT recall** drops below threshold. OPT_OUT recall is gated at **1.0**
  because a missed opt-out is a compliance risk, not just an accuracy point.

Run it:

```bash
# from agent/
python -m eval.run                 # deterministic (offline, CI-safe)
RUN_LLM_EVAL=1 python -m eval.run  # live LLM path (needs Ollama/OpenAI)
pytest tests/test_eval_gate.py     # the gate
```

> The deterministic gate scores ~1.0 by construction — it's a **regression
> tripwire**, not a real-world accuracy claim. Real accuracy = the `RUN_LLM_EVAL=1`
> path through the live `classify_message`.

---

## 9. Tests covering this layer

| Test file | What it pins |
|---|---|
| `tests/test_classify_structured.py` | The schema-enforced LLM path: valid output, retry-on-invalid-intent, confidence coercion/clamping, fail-safe to UNKNOWN, injection can't force an invalid label. |
| `tests/test_injection.py` | The gates: sanitization, OPT_OUT, injection, rate, question detection. |
| `tests/test_structured.py` | `invoke_structured` / `extract_json_object` parse + retry behavior. |
| `tests/test_llm_failover.py` | `FailoverChat` primary→fallback behavior. |
| `tests/test_llm_timeout.py` | `LLMTimeoutError` wall-clock bound. |
| `tests/test_security.py` | `require_api_key` + rate limiter. |
| `tests/test_eval_gate.py` | The accuracy/regression gate. |

---

## 10. Configuration reference

| Env var | Layer | Default | Effect |
|---|---|---|---|
| `AGENT_PROVIDER` | TS | `mock` | `mock` (keyword) vs `langgraph` (HTTP → Python). |
| `AGENT_SERVICE_URL` | TS | `http://localhost:8000` | Python agent base URL. |
| `AGENT_API_KEY` | both | _(unset)_ | Shared secret. Unset ⇒ unauthenticated (local/dev only). |
| `AGENT_TIMEOUT_MS` | TS | `30000` | Per-request HTTP timeout. |
| `AGENT_CB_FAILURE_THRESHOLD` | TS | `5` | Consecutive failures to open the breaker. |
| `AGENT_CB_COOLDOWN_MS` | TS | `30000` | Breaker open duration. |
| `AGENT_RATE_LIMIT` | Py | `60` | Requests per window per client/route. |
| `AGENT_RATE_WINDOW_SECONDS` | Py | `60` | Rate-limit window length. |
| `LLM_PROVIDER` | Py | `ollama` | Primary chat provider (`ollama` / `openai`). |
| `LLM_FALLBACK_PROVIDER` | Py | _(unset)_ | Optional failover provider. |
| `OLLAMA_MODEL` | Py | `qwen3:30b-a3b` | Ollama model tag. |
| `OLLAMA_MODEL_DIGEST` | Py | _(unset)_ | Pin an immutable digest. |
| `OLLAMA_BASE_URL` | Py | `http://localhost:11434` | Ollama endpoint. |
| `OPENAI_MODEL` | Py | `gpt-4o-mini` | OpenAI model id. |
| `OPENAI_API_KEY` | Py | _(unset)_ | Required when `LLM_PROVIDER=openai`. |
| `LLM_INVOKE_TIMEOUT_SECONDS` | Py | `60` | Per-`invoke` wall-clock bound. `0` disables. |

---

## 11. Design principles (the "why" in one place)

1. **Deterministic gates beat the model on the cases that matter.** Compliance
   (OPT_OUT), security (injection), and "don't kill a live deal" (rate/question)
   are decided in code the model can't override.

2. **Untrusted input is sanitized and bounded before it can reach a prompt.**
   NFKC, control-char stripping, length cap — defense that doesn't depend on the
   model obeying a "treat this as data" instruction (which it also gets, as
   defense-in-depth).

3. **Raw model output never drives a privileged transition unvalidated.** Schema
   validation + bounded retry + fail-safe to `UNKNOWN`. An invalid label can't
   masquerade as a confident one.

4. **When in doubt, a human looks.** Low confidence, injection, malformed output,
   and agent outages all funnel to `MANUAL_REVIEW` — never a silent guess.

5. **Failures degrade, they don't strand.** A down agent service ⇒ `UNKNOWN` ⇒
   review. A hung model ⇒ timeout ⇒ worker freed. The instance always keeps moving
   to a safe state.

6. **The mock and the model agree on the easy cases.** Mirrored keyword lists keep
   the offline mock, the production gates, and the CI eval consistent.
