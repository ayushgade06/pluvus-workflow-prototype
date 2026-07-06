# Negotiation Logic

This document describes how Pluvus negotiates creator deals end‑to‑end: how an
inbound reply becomes a money decision, where that decision is made, and every
guardrail that wraps it.

> **One‑line mental model:** the **LLM only classifies intent and extracts a
> rate**. The **financial decision is made by deterministic Python code**
> (`_decide_action`). The **TypeScript engine owns all state and round
> mechanics**. When anything is uncertain or the agent is unreachable, the
> system **routes to a human** — it never guesses a price.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [The end‑to‑end flow](#2-the-end-to-end-flow)
3. [The decision boundary (`_decide_action`)](#3-the-decision-boundary-_decide_action)
4. [Rate handling: extraction, stepping, prior offers](#4-rate-handling-extraction-stepping-prior-offers)
5. [The negotiation executor (state machine)](#5-the-negotiation-executor-state-machine)
6. [Guardrails](#6-guardrails)
7. [Data model](#7-data-model)
8. [Configuration / environment variables](#8-configuration--environment-variables)
9. [Worked examples](#9-worked-examples)
10. [Glossary of actions and states](#10-glossary-of-actions-and-states)

---

## 1. Architecture overview

The system spans three services:

| Service | Stack | Responsibility in negotiation |
|---|---|---|
| `agent/` | Python (FastAPI + LangGraph) | Hosts the LLM. Classifies intent, extracts a rate, and runs the **deterministic** `_decide_action`. Returns an action + draft copy. |
| `server/` | TypeScript (Node + Prisma + BullMQ) | Owns workflow state, rounds, persistence, queues/workers, output guard, idempotent sending, brand notifications, manual queue. Calls the agent over HTTP. |
| `web/` | React | Campaign builder + manual‑queue UI. Not part of the decision path. |

The clean split is intentional: the **money decision is an explicit `if` ladder
in Python**, not an implicit consequence of model sampling, so it is
unit‑testable without the LLM and reproducible (the model runs at
`temperature=0` for negotiation decisions).

```
inbound reply
    │
    ▼
[server] executeReplyDetection ──(NEGOTIATING)──► [server] executeNegotiation
                                                          │
                                                          │  agent.negotiate(round, config, reply, priorContext)
                                                          ▼
                                          [server] AgentProviderAdapter ──HTTP──► [agent] POST /negotiate
                                          (circuit breaker + timeout + auth)              │
                                                                                          │  LLM: classify intent + extract rate
                                                                                          ▼
                                                                            [agent] _decide_action (deterministic)
                                                                                          │
                                          ◄──────────── action + proposedTerms + draft ───┘
                                                          │
                                                          ▼
                                          [server] output guard ► idempotent send ► state transition
                                          (ACCEPTED / REJECTED terminal,
                                           COUNTER→AWAITING_REPLY round++,
                                           PRESENT_OFFER→AWAITING_REPLY same round,
                                           ESCALATE / guard‑block / max‑rounds → MANUAL_REVIEW + brand notice)
```

---

## 2. The end‑to‑end flow

### Triggering
- **Enroll** (`server/src/routes/workflows.ts`) creates `ExecutionInstance`s in
  state `ENROLLED`. **Launch** enqueues a node‑execution job per instance.
- Outreach / follow‑up emails are sent; the instance moves to `AWAITING_REPLY`.
- An **inbound reply** arrives via `POST /queues/inbound-email`
  (`server/src/routes/queues.ts`) or the Nylas webhook, and is enqueued as an
  inbound‑email job.

### Reply detection (`server/src/engine/executors/replyDetection.ts`)
- **Active‑negotiation short‑circuit:** if `instance.negotiationRound >= 1`, the
  reply is treated as a negotiation turn and routed straight to `NEGOTIATING`
  (intent `NEGOTIATION_IN_PROGRESS`) — it bypasses the first‑reply classifier.
  This is the fix for mid‑negotiation messages like *"I charge $480"* being
  wrongly classified `NEGATIVE`/`REJECTED`.
- **First reply (round 0):** `agent.classify` runs. The confidence threshold is
  `LOW_CONFIDENCE_THRESHOLD = 0.50`; below it the intent is overridden to
  `UNKNOWN`. Then:
  - `POSITIVE` / `QUESTION` → `NEGOTIATING`
  - `NEGATIVE` → `REJECTED`
  - `OPT_OUT` → `OPTED_OUT`
  - `UNKNOWN` / default → `MANUAL_REVIEW` (event `MANUAL_REVIEW_FLAGGED`)

### Workers (the loop)
- **inboundEmailWorker** — idempotent on `externalMessageId`, takes a per‑instance
  Redis lock, calls `injectReply` then `stepInstance` (runs reply detection).
  When the result is `NEGOTIATING`, it **auto‑enqueues** a negotiation
  node‑execution job, keyed per inbound message id (not per round) so a
  `PRESENT_OFFER` reply at the same round doesn't collide.
- **nodeExecutionWorker** — `expectedState` idempotency, lock, `stepInstance`,
  then auto‑chains: `OUTREACH_SENT`/`FOLLOWED_UP` re‑enqueue follow‑up;
  `NEGOTIATING` re‑enqueues a negotiation step keyed `auto-negotiate-<id>-r<round>`.
- **Retry/backoff** — `attempts: 3`, exponential backoff base 5s
  (immediate → 5s → 25s). Deterministic `jobId`s dedup retries.

---

## 3. The decision boundary (`_decide_action`)

File: `agent/app/routes/negotiate.py`. This pure, deterministic function maps the
model's classified **intent** + **mentioned rate** to a bounded **action**.

```python
NegotiationAction = Literal["ACCEPT", "COUNTER", "REJECT", "ESCALATE", "PRESENT_OFFER"]
```

`PRESENT_OFFER` is deliberately distinct from `COUNTER`: presenting the standing
offer to a curious creator (*"what's the rate?"*) is **informational and does NOT
consume a negotiation round**.

Inputs:
- `intent` — one of `RATE_DISCOVERY | RATE_PROPOSAL | NEGOTIATION | OBJECTION | ACCEPTANCE | REJECTION`
- `creator_rate_raw` — the loosely‑typed rate the model extracted from the reply
- `recommended_offer` — midpoint of the price band `floor + (ceiling − floor) × 0.5`
- `ceiling_rate` — the hard cap (band ceiling)
- `prior_offer` — the concrete rate **we** last put on the table (`None` if we
  never named one). This is both "the number they can say yes to" and the base
  the stepping counter moves up from.
- `is_final_round` — `True` on the last allowed round; we stop holding out and
  close at the creator's ask if it's within the ceiling.

### The `if` ladder

**1. `ACCEPTANCE`** — *"yes, that works"*
- Creator named a rate this turn:
  - `rate > ceiling` → **ESCALATE** (accepted, but above what's workable)
  - else → **ACCEPT** at that rate
- No rate this turn, but a `prior_offer` exists → **ACCEPT** at the prior offer
  (they're agreeing to our number).
- **No number has ever been on the table** (a bare *"yes, I'm interested"*) →
  **PRESENT_OFFER** at `recommended_offer`.

  > **The false‑acceptance fix.** Previously this auto‑ACCEPTed at the midpoint,
  > silently inventing an agreed rate the creator never saw. Now an `ACCEPTANCE`
  > only closes a deal when there is a **real number** to say yes to; otherwise
  > we present the offer so the creator can agree to an actual figure.

**2. `REJECTION`** → **REJECT**.

**3. `RATE_DISCOVERY` with no readable number** — the creator is *asking* the rate.
→ **PRESENT_OFFER** at `prior_offer ?? recommended_offer`. We present the rate we
**already** put on the table if there is one — never regress below our last offer
(presenting the midpoint blindly would look like we lowered our own offer).

**4. Numeric path** — *any* readable number, regardless of the model's label
(the 7B model often calls a repeated price `NEGOTIATION`). Let `our_offer =
prior_offer ?? recommended_offer`:
- `rate > ceiling` → **ESCALATE**
- `rate <= our_offer` → **ACCEPT** (they met or beat our offer)
- `is_final_round` (and within ceiling) → **ACCEPT** at their ask (close rather
  than dead‑end)
- otherwise → **COUNTER** at the stepped midpoint `_step_offer(our_offer, rate, ceiling)`
  (if the step would meet/exceed their ask, **ACCEPT** instead)

**5. `RATE_PROPOSAL` but unreadable number** → **ESCALATE** (fail safe — *"do not
guess"*).

**6. Fallthrough** (`NEGOTIATION` / `OBJECTION` / unknown, no number) → **COUNTER**
at `our_offer` (hold; never below our last offer).

> **Invariant:** a `None` (unreadable) rate is **never** silently accepted. It is
> always failed safe to a human (`ESCALATE` → `MANUAL_REVIEW`).

---

## 4. Rate handling: extraction, stepping, prior offers

### Rate extraction — `_coerce_rate`
Best‑effort numeric coercion of the model's free‑form `creatorRateMentioned`:
- accepts a number, or a numeric string (`"480"`, `"$480"`, `"1,500"`)
- strips currency symbols / thousands separators, keeps digits + one dot
- explicitly **rejects `bool`** (it's an `int` subclass)
- returns `None` for null/garbage → caller fails safe to human review

### Stepping counter — `_step_offer`
The counter moves **toward** the creator each round rather than repeating a flat
number:

```python
step = round((our_last_offer + creator_ask) / 2.0, 2)
return min(step, creator_ask, ceiling_rate)   # never above their ask or the ceiling
```

A convergent midpoint that closes the gap a little every round. Example
(recommended 350, creator holds 500): **350 → 425 → 462 → 481 …**

### Prior‑offer detection — `_last_offered_rate`
Walks the negotiation history newest‑first; only `ACCEPT`, `COUNTER`, and
`PRESENT_OFFER` turns that carry a rate count as "a real number on the table."
This is what distinguishes a genuine acceptance from enthusiasm before any number
was discussed.

---

## 5. The negotiation executor (state machine)

File: `server/src/engine/executors/negotiation.ts`. The executor turns the agent's
action into a persisted state transition and an (idempotent, guarded) email.

Preconditions and round mechanics:
1. Requires state `NEGOTIATING`. Reads `maxRounds` from node config (default 5).
2. **Hard stop:** `negotiationRound >= maxRounds` → `MANUAL_REVIEW`,
   reason `max_rounds_reached` (before calling the agent).
3. Loads the latest inbound reply, then reconstructs prior context from persisted
   `NEGOTIATION_TURN` events via `buildPriorContextFromEvents` (threads
   `currentOffer` and the full history into the agent request).
4. Calls `agent.negotiate(round, config, creatorReply, priorContext)`.

Outcome handling:

| Agent outcome | Email sent | State after | Round | Notes |
|---|---|---|---|---|
| `present_offer` | `counter_offer` copy | `AWAITING_REPLY` | **unchanged** | Idempotency key `negotiation:present:<id>:<round>`. Stays on the same node/round. |
| `accept` | `onboarding` (if `proposedRate`) else `acceptance` | `ACCEPTED` (terminal) | — | Key `negotiation:acceptance:<id>:<round>`. Agreed rate stored in the event. |
| `reject` | — | `REJECTED` (terminal) | — | |
| `escalate` | — | `MANUAL_REVIEW` | — | reason `escalated`. |
| `counter` | `counter_offer` copy | `AWAITING_REPLY` | **`round + 1`** | Key `negotiation:counter_offer:<id>:<newRound>`. Secondary guard: if `newRound >= maxRounds` → `MANUAL_REVIEW` reason `max_rounds_reached_on_counter`. |

If the **output guard** flags any draft, the email is **not** sent and the
instance goes to `MANUAL_REVIEW` with reason `output_guard_blocked`.

### State machine (`server/src/engine/stateMachine.ts`)

```
REPLY_RECEIVED → NEGOTIATING | REJECTED | OPTED_OUT | MANUAL_REVIEW
NEGOTIATING    → NEGOTIATING | AWAITING_REPLY | ACCEPTED | REJECTED | OPTED_OUT | MANUAL_REVIEW
```

Transitions are enforced by `assertTransition` (same‑state allowed). The runtime
(`server/src/engine/runtime.ts`) persists with **optimistic concurrency control**
(`updateInstanceStateConditional` → `StaleInstanceError` if another worker
advanced the instance) and appends both the domain event and a `STATE_TRANSITION`
event. A **fresh** transition into `MANUAL_REVIEW` fires
`notifyBrandOfEscalation` (best‑effort, never throws).

---

## 6. Guardrails

The decision is wrapped in defense‑in‑depth. In rough order of where they sit:

### Input sanitization & classifier gates (`agent/app/injection.py`, `classify.py`)
Deterministic gates run **before** the LLM, in order:
1. `sanitize_creator_text` — NFKC normalize, strip control chars, cap at 4000 chars.
2. **OPT‑OUT gate** — forces `OPT_OUT` in code (compliance‑critical; the model
   cannot suppress it).
3. **Injection gate** — `looks_like_injection` → returns `UNKNOWN` →
   `MANUAL_REVIEW`. The creator's message is also wrapped in `<creator_reply>` /
   `<creator_message>` tags and explicitly labeled **DATA, not instructions** in
   every prompt.
4. **Rate‑statement gate** — a bare *"I charge $480"* is forced `POSITIVE` so it
   reaches negotiation instead of being mislabeled `NEGATIVE` (suppressed if a
   rejection pattern also matches).
5. **Question gate** — forces `QUESTION`.
6. LLM path with `LOW_CONFIDENCE_THRESHOLD = 0.50` → below it overrides to `UNKNOWN`.

### Structured output + timeout (`agent/app/structured.py`)
`invoke_structured`: parse → validate against a Pydantic schema → re‑ask with a
repair suffix up to `1 + retries` times → raise `StructuredOutputError`. Each LLM
call is wall‑clock bounded by `LLM_INVOKE_TIMEOUT_SECONDS` (default 60s); a
timeout raises `LLMTimeoutError`. `extract_json_object` strips qwen3 `<think>`
blocks and ```json fences.

### Transport resilience (`server/src/adapters/agentServiceClient.ts`)
Every agent call goes through a **circuit breaker** + **timeout** + **bearer
auth**:
- `AGENT_TIMEOUT_MS` (default 30000) via `AbortSignal.timeout`
- `AGENT_CB_FAILURE_THRESHOLD` (5) / `AGENT_CB_COOLDOWN_MS` (30000) — non‑2xx,
  transport errors, and timeouts all count as failures.

### Graceful degradation (`server/src/engine/providerFactory.ts`, `AgentProviderAdapter`)
When the agent is unavailable, the system **degrades to a human**, never a guess:
- `classify` failure → `{intent:"UNKNOWN", confidence:0}` → `MANUAL_REVIEW`
- `negotiate` failure → `{outcome:"escalate"}` → `MANUAL_REVIEW` (a money
  decision is never fabricated when the agent is down)
- `draftEmail` failure → `null` → executor falls back to template copy
- `draftEmail` strips the price band from the copy context
  (`minBudget/maxBudget/termFloor/termCeiling`) so the copy model can't leak it.

### Output guard (`server/src/engine/guards/outputGuard.ts`)
`scanOutboundDraft` scans every rendered draft for the floor/ceiling numbers
before sending. `numberAppears` uses look‑around so `500` doesn't match inside
`1500`; the intended offer (`allowedRate`) is allowlisted. Any hit →
`MANUAL_REVIEW` (reason `output_guard_blocked`), email **not** sent.

### Band resolution (`server/src/engine/band.ts`)
`resolveBand` accepts **either** `termFloor`/`termCeiling` (seed snapshots) **or**
`minBudget`/`maxBudget` (UI/templates), preferring the former. Without it a
UI‑built workflow sent an empty band → floor 0 / ceiling +∞, making
accept/counter/escalate inert.

### Idempotent send (`server/src/engine/executors/idempotentSend.ts`)
`sendOnce` reserves a `Message` row with a unique `idempotencyKey` **before**
calling `email.send()`. A unique‑violation on the reserve means a prior attempt
already sent → skip and return the prior identifiers. This closes the
crash‑between‑send‑and‑write double‑send window.

### Auth & rate limiting (`agent/app/security.py`)
`require_api_key` (constant‑time compare, gated by `AGENT_API_KEY`; no‑op +
warning when unset) and an in‑process fixed‑window `rate_limiter` (429 +
`Retry-After`), tuned by `AGENT_RATE_LIMIT` / `AGENT_RATE_WINDOW_SECONDS`.

---

## 7. Data model

File: `server/prisma/schema.prisma`.

### Key enums
- **`InstanceState`** — `ENROLLED, OUTREACH_SENT, AWAITING_REPLY, FOLLOWED_UP,
  REPLY_RECEIVED, NEGOTIATING`; terminal `ACCEPTED, REJECTED, OPTED_OUT,
  NO_RESPONSE`; plus `MANUAL_REVIEW`.
- **`ReplyIntent`** — `POSITIVE, NEGATIVE, QUESTION, OPT_OUT, UNKNOWN`.
- **`EventType`** — includes `REPLY_CLASSIFIED, NEGOTIATION_TURN,
  MANUAL_REVIEW_FLAGGED, BRAND_NOTIFIED, STATE_TRANSITION`.
- **`BrandNotificationStatus`** — `SENT, FAILED, SKIPPED`.

### Key models (negotiation‑relevant fields)
- **`Campaign`** — `notifyEmail` (manual‑queue escalation recipient),
  `brandDescription` (fed to the LLM, stamped into node config).
- **`ExecutionInstance`** — `currentState`, `currentNodeId`, **`followUpCount`**,
  **`negotiationRound`**, `dueAt`, `completedAt`; unique on
  `(workflowVersionId, creatorId)`.
- **`Message`** — `direction`, `subject`, `body`, `threadId`,
  `externalMessageId` (unique), **`idempotencyKey`** (unique, pre‑send dedup),
  `replyIntent`, `classifyConfidence`.
- **`Event`** — append‑only audit log. `NEGOTIATION_TURN` payload is
  `{ round, action }`; the prior context for each turn is rebuilt from these.
- **`BrandNotification`** — `recipient`, `reason`, `status`, **`idempotencyKey`**
  (unique = `instanceId + reason`), `error`. Reasons include
  `low_confidence_reply, max_rounds_reached, output_guard_blocked, escalated`.

---

## 8. Configuration / environment variables

From `.env.example` (root) and where each is read:

| Variable | Default | Read at | Purpose |
|---|---|---|---|
| `AGENT_SERVICE_URL` | `http://localhost:8000` (code) | `agentServiceClient.ts` | Agent base URL. |
| `AGENT_API_KEY` | (unset) | `agentServiceClient.ts`, `security.py` | Bearer auth between server and agent. |
| `AGENT_TIMEOUT_MS` | `30000` | `agentServiceClient.ts` | Per‑request timeout. |
| `AGENT_CB_FAILURE_THRESHOLD` | `5` | `agentServiceClient.ts` | Circuit‑breaker trip count. |
| `AGENT_CB_COOLDOWN_MS` | `30000` | `agentServiceClient.ts` | Circuit‑breaker cooldown. |
| `NEGOTIATION_PROVIDER` | `langgraph` | `providerFactory.ts` | `mock` or `langgraph`. |
| `AGENT_PROVIDER` | `langgraph` | `providerFactory.ts` | Classification provider. |
| `EMAIL_PROVIDER` | `mock` | `providerFactory.ts` | `mock` or `nylas`. |
| `LLM_INVOKE_TIMEOUT_SECONDS` | `60` | `structured.py` | Per LLM‑call wall clock. |
| `AGENT_RATE_LIMIT` / `AGENT_RATE_WINDOW_SECONDS` | `60` / `60` | `security.py` | Agent rate limiter. |
| `LLM_PROVIDER` / `LLM_FALLBACK_PROVIDER` | `ollama` | `llm.py` | Primary/fallback LLM. |
| `OLLAMA_MODEL` / `OLLAMA_MODEL_DIGEST` / `OLLAMA_BASE_URL` | see note | `llm.py` | Ollama config. |
| `OPENAI_MODEL` / `OPENAI_API_KEY` | `gpt-4o-mini` | `llm.py` | OpenAI config. |
| `BRAND_NOTIFY_EMAIL` | (unset) | `escalation.ts`, `manualQueue.ts` | Default escalation recipient. |

**Escalation recipient precedence:** campaign `notifyEmail` → `BRAND_NOTIFY_EMAIL`
→ operator fallback `affiliatepartner@pluvus.com`.

> ⚠️ **Mismatch to be aware of:** `.env.example` defaults `AGENT_SERVICE_URL` to
> port **8001**, but the **code default** in `agentServiceClient.ts` is
> `http://localhost:8000`. Set it explicitly in `.env` to avoid surprises.
> (`OLLAMA_MODEL` is aligned: both `.env.example` and the `llm.py` code default
> are **qwen3:30b-a3b**, the strongest local model.)

### Negotiation config (per‑workflow node config, **not** env)
Set on the `NEGOTIATION` node from the template (`server/src/templates/index.ts`):
`maxRounds`, `minBudget`/`maxBudget`, `commissionRate`, `approvalMode`.

| Template | minBudget | maxBudget | maxRounds | commissionRate | approvalMode |
|---|---|---|---|---|---|
| affiliate | 0 | 500 | 3 | 15% | auto |
| hybrid | 200 | 2000 | 4 | 10% | auto |
| fixed_fee | 500 | 5000 | 3 | — | manual |

The recommended offer is the **midpoint** of `minBudget`/`maxBudget`. When a
workflow is created from a template, `brandName`/`senderName`/`brandDescription`
are stamped into every node's config.

---

## 9. Worked examples

Assume band `[350, 500]` (recommended/midpoint = 425), `maxRounds = 4`.

**A. Bare interest, no number yet**
> Creator: *"Yes, I'd love to work with you!"*
- Intent `ACCEPTANCE`, no rate ever on the table → **PRESENT_OFFER @ 425**.
- State stays `AWAITING_REPLY`, round **unchanged**. The creator now sees a real
  figure to agree to. (This is the false‑acceptance fix.)

**B. Creator names a rate above our offer, within ceiling**
> Creator: *"I usually charge $480."*
- `our_offer = 425`, `rate = 480 ≤ ceiling 500`, not final round →
  **COUNTER @ 452** (`round((425+480)/2)`), round → +1.

**C. Creator meets/beats our offer**
> Creator (after we countered at 452): *"OK, $450 works."*
- `rate 450 ≤ our_offer 452` → **ACCEPT @ 450** → `ACCEPTED` (terminal),
  `onboarding` email sent.

**D. Creator's ask exceeds the ceiling**
> Creator: *"My rate is $800."*
- `rate 800 > ceiling 500` → **ESCALATE** → `MANUAL_REVIEW` (reason `escalated`),
  brand notified.

**E. Rate could not be parsed**
> Model returns `creatorRateMentioned: "negotiable-ish"` with intent
> `RATE_PROPOSAL`.
- `_coerce_rate` → `None` → **ESCALATE** (fail safe to a human).

**F. Final round, ask within ceiling**
> Round 4 (final), creator holds at $490.
- `is_final_round` and `490 ≤ ceiling` → **ACCEPT @ 490** (close rather than
  dead‑end).

---

## 10. Glossary of actions and states

**Agent actions** (`NegotiationAction`):
- `ACCEPT` — close the deal at a concrete rate → `ACCEPTED`.
- `COUNTER` — propose a stepped offer, consumes a round → `AWAITING_REPLY`, round++.
- `PRESENT_OFFER` — present the standing offer informationally, **no round
  consumed** → `AWAITING_REPLY`, same round.
- `REJECT` — decline → `REJECTED`.
- `ESCALATE` — hand off to a human → `MANUAL_REVIEW`.

**Instance states** (negotiation‑relevant):
- `NEGOTIATING` — actively exchanging offers.
- `AWAITING_REPLY` — waiting on the creator after we sent a counter/present.
- `ACCEPTED` / `REJECTED` / `OPTED_OUT` — terminal.
- `MANUAL_REVIEW` — escalated to a human (max rounds, low confidence, guard
  block, agent unavailable, or out‑of‑range rate). Surfaced in the Manual Queue;
  the brand is emailed.
