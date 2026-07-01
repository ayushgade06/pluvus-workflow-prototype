# Pluvus AI Agents & Nylas Integration — Focused Gap Analysis

> Scoped gap analysis for the **current priority**: making the **Nylas email integration**
> and the **AI agents** (reply classification, negotiation, drafting) work properly for real
> users — proper reply handling end to end.
>
> **Explicitly out of scope right now:** authentication, authorization, multi-tenancy,
> billing/usage metering, SaaS platform features, workflow-builder DAG authoring, horizontal
> scaling. Those are real future concerns but are **not** what we are solving in this phase,
> so they are deliberately omitted here.
>
> This is **not** a code-quality or bug review. It maps the distance between what the AI +
> email layer does today and what "the agents work properly for users" requires.
>
> _Analysis date: 2026-07-01. Reflects the codebase through Phase 12 (brand description)._

---

## What we are actually trying to make work

```
Outreach email (Nylas send)
   → creator replies (Nylas inbound webhook)
   → Reply Classification  (positive / negative / question / opt-out / unknown)
   → Negotiation           (accept / counter / present-offer / reject / escalate)
   → reply handling loops until a deal closes, is rejected, or escalates to a human
```

Everything below serves that single loop: **email goes out, a reply comes back, the agents
read it correctly, respond appropriately, and drive the instance to the right outcome
without a human unless one is genuinely needed.**

---

## Readiness scorecard (out of 10)

Rating **production-readiness for real users**, not "does a demo work." Scores are for the
current priority scope (AI agents + Nylas reply handling). Auth/tenancy/billing/scale are out
of scope and not rated.

### Core priority areas

| Area | Score | Verdict |
|---|---|---|
| **Negotiation decision logic** | **8.5 / 10** | Strongest part of the codebase |
| **Reply classification** | **7.5 / 10** | Solid gates; eval is synthetic |
| **AI safety / guardrails** | **8 / 10** | Genuinely well-designed |
| **Graceful degradation / resilience** | **8 / 10** | Fail-safe-to-human wired end to end |
| **Nylas outbound (send)** | **6 / 10** | Works, but thin and unmonitored |
| **Nylas inbound (reply handling)** | **5 / 10** | The weakest link in the actual loop |
| **AI eval / measurable correctness** | **4 / 10** | Classification only; negotiation untested |
| **AI observability / debuggability** | **3 / 10** | Near-blind when something goes wrong |
| **Model quality / provider flexibility** | **5 / 10** | Local 7B / OpenAI only; no Claude |
| **Prompt management** | **3 / 10** | Inline constants, no versioning |

> **Weighted readiness for the current goal: ~6.0 / 10** — the *brain* is strong, the
> *senses and instrumentation* are weak.

### Why each score

- **🟢 Negotiation decision logic — 8.5.** The `_decide_action` ladder
  (`agent/app/routes/negotiate.py:230-349`) is production-grade thinking: deterministic (not
  model-sampled), unit-testable, fails safe on unreadable rates, never fabricates an agreed
  price, never regresses its own offer, has a convergent stepping counter + final-round close.
  *Held back from 10 by:* no real-trajectory eval to prove it negotiates well, and it leans on
  a weak model for the intent read feeding it.
- **🟢 AI safety / guardrails — 8.** Opt-out and prompt-injection decided in *code* not the
  model (`classify.py:152-219`), output guard blocks price-band leaks
  (`server/src/engine/guards/outputGuard.ts`), rate/question gates correct small-model
  mislabels. *Held back by:* no tone/hallucination/claims guard — only band-leak.
- **🟢 Graceful degradation — 8.** Classify fail → UNKNOWN → manual review; negotiate fail →
  escalate; draft fail → template; circuit breaker + timeout on the agent service
  (`server/src/adapters/agentServiceClient.ts`). An AI failure never strands the instance.
  *Held back by:* engine-side stranding (jobless non-terminal instances) is still possible.
- **🟡 Reply classification — 7.5.** Good deterministic-gates-then-LLM pipeline. *Held back
  by:* a 34-case synthetic eval set ("tripwire, not an accuracy claim" per its own README),
  and replies aren't cleaned (quoted history/signatures) before classifying — real replies
  score worse than the harness suggests.
- **🟡 Nylas outbound — 6.** Real send works, HTML formatting, thread-id resolution for
  correlation. *Held back by:* single send, no permanent-vs-transient error distinction, no
  rate limiting, no bounce/delivery handling — a hard bounce loops instead of stopping.
- **🔴 Nylas inbound / reply handling — 5** *(most important gap for the goal)*. Correlation
  is **thread-id only**, and a reply with no/unknown thread is **silently acked and dropped**
  (`server/src/routes/webhooks.ts:131-150`) — the creator replied, the agent never sees it,
  the instance waits forever. No recipient/recent-window fallback, no orphaned-reply record.
  Signature verification + producer pattern are good; correlation robustness is not.
- **🔴 AI eval / measurable correctness — 4.** Classification has a real harness + CI gate.
  **Negotiation — the financial decision — has zero accuracy eval**, only fixed-input unit
  tests. You currently *cannot measure* whether the agent negotiates correctly for users.
- **🔴 AI observability — 3.** Intent/confidence/action are in the DB, but **not** the raw
  model output, which prompt, which model, token usage, or latency (`usage_metadata` is never
  read, `agent/app/structured.py:79-80`). Debugging a bad negotiation is guesswork.
- **🔴 Model quality / provider — 5.** Only Ollama + OpenAI (`agent/app/llm.py:92-95`); no
  Anthropic/Claude, no OpenRouter. The hard negotiation read runs on a local 7B whose
  mislabels are patched with deterministic gates. A better model is high-leverage and the
  `get_llm` seam is ready for it.
- **🔴 Prompt management — 3.** Inline string constants, no version tag, no registry — a
  decision can't be tied back to the prompt that produced it.

### The honest summary

> **The decision-making is ~8.5/10 (genuinely good). The email reliability and instrumentation
> around it are ~4/10. For "make the agents work properly for users," the bottleneck is not
> the AI's intelligence — it's (1) replies getting silently dropped, (2) no way to prove or
> debug what the agents decide, and (3) a weak model feeding a strong decision engine.**

Fixing the three P0s below — **inbound correlation fallback, reply-text cleaning, and a real
negotiation eval set** — moves the weighted score from ~6 to ~8, because those are exactly the
load-bearing weaknesses dragging the average down.

---

## Where the AI layer is genuinely strong today (keep this)

These are deliberate, well-reasoned design choices. They should be **preserved**, not
reworked — listing them so we don't accidentally "fix" what already works:

- **The money decision is deterministic, not model-sampled.** `_decide_action`
  (`agent/app/routes/negotiate.py:230-349`) is a pure `if`-ladder: the LLM only classifies
  intent and extracts a rate; the accept/counter/escalate split is explicit code, unit-testable
  without the model. This is the right boundary and the reason the system is safe.
- **It fails safe to a human.** An unreadable rate → `ESCALATE` (`negotiate.py:341-344`); a
  bare "yes I'm interested" with no number ever on the table → `PRESENT_OFFER` rather than a
  fabricated acceptance (`negotiate.py:265-288`); above-ceiling → escalate. The agent never
  invents an agreed price.
- **Offers never silently regress.** The stepping counter (`_step_offer`, `negotiate.py:212-227`)
  always moves toward the creator and never below our own prior offer
  (`negotiate.py:307-314`).
- **Classification has compliance-critical deterministic gates ahead of the model**
  (`agent/app/routes/classify.py:152-219`): opt-out and prompt-injection are decided in code,
  never by the (injectable) LLM; rate-statement and question gates correct known small-model
  mislabels before they can terminate an instance wrongly.
- **The internal price band can't leak into outbound copy** — the output guard
  (`server/src/engine/guards/outputGuard.ts`) scans every AI-rendered email and routes a leak
  to manual review instead of sending.
- **Graceful degradation is wired end to end** — classify failure → `UNKNOWN` → manual review;
  negotiate failure → `escalate` → manual review; draft failure → template fallback
  (`server/src/engine/providerFactory.ts`). A circuit breaker + timeout guards the agent
  service (`server/src/adapters/agentServiceClient.ts`).

The gaps below are about **confidence in correctness, model quality, and email reliability** —
not about replacing this architecture.

---

## How to read each item

Every item carries: **Why it matters · Current limitation (with evidence) · Proposed
solution · Priority · Complexity · Now vs. Later.**

- **Priority** is relative to "make the agents work properly for users *now*."
- **Complexity:** S / M / L (S ≈ <1 wk, M ≈ 1–3 wk, L ≈ 4+ wk).

---

## 1. Reply Handling & Nylas Round-Tripping

This is the spine of the priority: an outreach goes out, a reply must reliably come back and
reach the right instance.

### 1.1 — Inbound correlation robustness (thread-id only today)

- **Why it matters.** If a reply can't be matched to its instance, the whole loop stalls —
  the creator replied but the agent never sees it. This is the most common real-world failure
  mode for email automation.
- **Current limitation.** The webhook correlates **only by `threadId`** (`server/src/routes/webhooks.ts:131-150`):
  if there's no threadId, or the thread isn't found, the reply is acked and **silently
  dropped** ("ignored: thread not found"). There is no fallback to recipient + recent-window
  matching, and no record of a dropped/orphaned reply for an operator to recover. The
  open-questions doc itself recommended a fallback ("recipient + recent-window matching and
  flag for review") that isn't implemented.
- **Proposed solution.** Add a correlation fallback chain: thread-id → in-reply-to/message-id
  headers → recipient + recent outbound window. When all fail, persist the orphaned inbound as
  an "unmatched reply" row and surface it for manual correlation instead of dropping it.
- **Priority: P0. Complexity: M. Now.**

### 1.2 — Nylas send path is minimal and unmonitored

- **Why it matters.** Send failures, bounces, and rate limits are normal at volume; if a send
  silently fails the creator never gets the email and the instance waits forever.
- **Current limitation.** `NylasEmailProvider.send` (`server/src/providers/nylas/nylasEmailProvider.ts:45-67`)
  does a single send with no provider-level retry, no bounce/delivery handling, and no
  outbound rate limiting; it relies entirely on the enclosing BullMQ job's 3 retries. There's
  no handling of Nylas-side send errors distinct from transient failures.
- **Proposed solution.** Distinguish permanent vs. transient send errors; add a send rate
  limiter (deliverability + Nylas limits); ingest bounce/delivery webhook events so a hard
  bounce marks the instance instead of looping. Keep the thin-adapter shape.
- **Priority: P1. Complexity: M. Now-ish.**

### 1.3 — Real-reply test fixtures for the inbound path

- **Why it matters.** "Proper reply handling" can only be trusted if it's tested against
  realistic inbound emails (quoted history, signatures, HTML, forwards), not just clean
  synthetic bodies.
- **Current limitation.** The inbound body is taken fairly directly (`extractInboundMessage`,
  `webhooks.ts:54-72`, falls back to `snippet`). There's no quoted-trailer/signature stripping
  before classification, so a creator's one-line reply arrives wrapped in the entire prior
  thread — which degrades small-model classification.
- **Proposed solution.** Strip quoted history + signatures before classifying (a reply-parser
  step). Add fixtures of real-shaped inbound emails to the harness.
- **Priority: P0. Complexity: S–M. Now** — directly improves classification accuracy on real
  replies for almost no cost.

---

## 2. AI Model Quality & Provider

### 2.1 — Wire Anthropic / better models for negotiation

- **Why it matters.** The negotiation intent-classification and rate-extraction are the
  hardest language tasks in the system, and the notes already flag that the local 7B model
  mislabels (the rate/question gates exist precisely to paper over small-model errors —
  `classify.py:187-209`, `negotiate.py:316-321`). Using a more capable model for the
  negotiation read directly improves deal outcomes.
- **Current limitation.** Only **Ollama and OpenAI** are supported (`agent/app/llm.py:92-95`);
  there is no Anthropic/Claude path and no `base_url` override on `ChatOpenAI`
  (`llm.py:85-89`). Provider is global env-only — the same model serves classify, negotiate,
  and draft, varying only by temperature.
- **Proposed solution.** Add an Anthropic factory (the latest Claude models are strongest for
  nuanced negotiation reads) and/or an OpenRouter-compatible `base_url`. Allow the negotiation
  task to use a more capable model than trivial classification — a per-task model knob, not a
  full router.
- **Priority: P1. Complexity: M. Now** — the `get_llm` seam already exists to extend, and it's
  high-leverage for negotiation quality.

### 2.2 — Confidence is uncalibrated and partly hardcoded

- **Why it matters.** Confidence is the dial that decides auto-advance vs. manual review
  (`LOW_CONFIDENCE_THRESHOLD`, `classify.py:213-218`). If it's wrong, we either bother humans
  too often or auto-advance bad classifications.
- **Current limitation.** Deterministic gates hardcode confidence (opt-out 1.0, injection 0.0,
  rate 1.0, question 1.0); only the LLM middle path produces a model number, and it's not
  calibrated against real outcomes. The threshold is a single hardcoded constant.
- **Proposed solution.** Once a real-reply eval set exists (§3), plot a reliability curve and
  set the threshold from data rather than a guess; consider per-intent thresholds.
- **Priority: P2. Complexity: M. Later** — needs the eval data first.

---

## 3. AI Evaluation & Trust

### 3.1 — Negotiation has no eval harness (highest-risk untested surface)

- **Why it matters.** `_decide_action` is the financial decision boundary. It has thorough
  unit tests on fixed inputs, but **no labeled accuracy eval** on real negotiation
  trajectories — so we can't measure "does the agent negotiate *correctly*" the way we measure
  classification.
- **Current limitation.** There is an eval set + scorer + CI gate for **classification only**
  (`agent/eval/`, 34 synthetic cases). Nothing scores the negotiation decision (accept/counter/
  escalate correctness, floor/ceiling adherence, no-fabricated-price) or draft quality.
- **Proposed solution.** Build a labeled negotiation-trajectory eval set (anonymized real
  threads): for each turn, the expected action + an acceptable rate range. Score the decision
  ladder against it and gate CI. Add an LLM-judge for draft quality (tone, no band leak,
  personalization).
- **Priority: P0. Complexity: L. Now-ish** — start collecting real threads immediately; it's
  the only way to *prove* the negotiation agent works for users.

### 3.2 — Grow the classification eval set toward real data

- **Why it matters.** The current 34-case set is synthetic and self-admittedly a "tripwire,
  not an accuracy claim" (`agent/eval/README.md`). Real creator replies are messier.
- **Current limitation.** Small, synthetic dataset; the README itself targets ~500 real replies
  as the goal.
- **Proposed solution.** Pipe real (anonymized) inbound replies into the eval set; re-baseline
  per model/prompt change.
- **Priority: P1. Complexity: M. Now-ish.**

### 3.3 — AI decision observability (what did the model actually do?)

- **Why it matters.** When the agent makes a wrong call for a user, we need to see *why* — the
  raw model output, which prompt, which model, and the cost. Today debugging a bad negotiation
  is guesswork.
- **Current limitation.** The DB stores intent/confidence/action on `Message`/`Event`, but
  **not** the model's raw output, the prompt version, which model produced it, token usage, or
  latency. `usage_metadata` is never read (`agent/app/structured.py:79-80`); prompts are inline
  constants with no version tag; no LangSmith/OTel tracing.
- **Proposed solution.** Stamp every AI call with `{model, promptVersion, rawOutput,
  inputTokens, outputTokens, latencyMs}` onto an event/record. Version prompts (hash + tag).
  Token/cost capture is cheap to add once `usage_metadata` is read and pays for itself the
  first time a negotiation goes wrong in production.
- **Priority: P1. Complexity: M. Now** — this is the difference between debuggable and opaque
  when a user reports "the agent did something weird."

---

## 4. Negotiation & Drafting Behavior Coverage

### 4.1 — Generalize "memory" / context the agent sees per turn

- **Why it matters.** A good negotiation reply uses the *whole* relationship: prior turns,
  the creator's stated constraints, brand voice. Better context = better drafts and reads.
- **Current limitation.** Cross-turn context is reconstructed by the engine from
  `NEGOTIATION_TURN` events and passed per call (`buildPriorContextFromEvents`,
  `server/src/engine/executors/negotiationHistory.ts`) — which is the right place for it, but
  it's negotiation-only. The classifier and drafter don't get full relationship context.
- **Proposed solution.** Assemble a single instance-context object (creator profile + full
  message history + prior outcomes + campaign brand voice) and pass it to every AI node, so
  classification and drafting are relationship-aware too.
- **Priority: P2. Complexity: M. Later** (after the eval harness, so we can measure the gain).

### 4.2 — Draft quality guardrails beyond band-leak

- **Why it matters.** The output guard catches price-band leaks, but not tone problems,
  hallucinated commitments, or off-brand copy — which users *will* notice.
- **Current limitation.** `outputGuard.ts` checks for leaked floor/ceiling numbers and
  `internalTerms` strings; `_scrub_brand` (`negotiate.py`) regex-cleans placeholders. No check
  for tone, fabricated promises, or unapproved claims.
- **Proposed solution.** Add a lightweight draft-review pass (rule-based first, LLM-judge later
  per §3.1) for tone/claims; surface borderline drafts to manual review.
- **Priority: P2. Complexity: M. Later.**

### 4.3 — Make the agent service multi-worker-safe

- **Why it matters.** The agent's rate limiter is in-process (`agent/app/security.py` notes
  this); under more than one uvicorn worker it under-counts, and the agent has no shared state.
- **Current limitation.** In-process fixed-window rate limiter; fine for one worker, incorrect
  for several.
- **Proposed solution.** Back the limiter with a shared store (Redis) when the agent runs more
  than one worker.
- **Priority: P2. Complexity: S. Later** (only when we scale the agent process).

---

## Priority summary (for this phase only)

**Do now (P0):**

1. **Inbound correlation fallback** so replies are never silently dropped (§1.1).
2. **Reply parsing** — strip quoted history/signatures before classifying (§1.3); directly
   lifts real-reply accuracy.
3. **Negotiation eval harness** on real trajectories — start collecting threads now (§3.1).

**Do next (P1):**

4. **Anthropic/better model for negotiation** (§2.1).
5. **AI decision observability** — raw output + prompt version + model + tokens (§3.3).
6. **Nylas send hardening** — error classification, rate limit, bounce handling (§1.2).
7. **Real-reply classification eval growth** (§3.2).

**Later (P2):**

8. Confidence calibration from eval data (§2.2).
9. Generalized per-turn context for all AI nodes (§4.1).
10. Draft tone/claims guardrails (§4.2).
11. Multi-worker-safe agent rate limiting (§4.3).

---

## The one-sentence read

**The AI decision architecture is sound and safe — the remaining work to make the agents
"work properly for users" is reliability of the email round-trip (never drop a reply, clean
the text before classifying), confidence in correctness (a real negotiation eval set +
decision observability), and a more capable model for the negotiation read — not a redesign.**
