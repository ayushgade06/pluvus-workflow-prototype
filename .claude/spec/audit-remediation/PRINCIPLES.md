# Governing Principle — LLM Negotiates, Code Guards the Sandbox

**Read this before implementing any spec.** It resolves the recurring question of what belongs to the
LLM versus deterministic code. Every issue in `critical.md` / `hard.md` / `medium.md` / `easy.md` is to be
implemented consistently with this document; where a tier file's wording predates this doc, this doc wins.

## Origin

Anthropic's **Project Deal** (published 2026-04-24; experiment ran Dec 2025, SF office): 69 Claude agents
autonomously negotiated 186 real deals (~$4,000) with **no human intervention once running**. Findings
relevant to us:

- Negotiation was **LLM-native, not rule-based**. System prompts set goals/personality but "did NOT
  deterministically control negotiation outcomes."
- **Stronger model → better outcomes** (Opus sellers +$2.68/item). Negotiation *quality* comes from model
  reasoning — so the model must be the one negotiating, not a formula.
- Anthropic's own writeup does **not** document budget-enforcement or spending guardrails (it was $100
  among trusted colleagues) and explicitly flags **prompt injection / jailbreaking as unsolved risks**.

**Our situation differs in two ways that MATTER:** (1) real brand budgets, and (2) an untrusted
counterparty (creators) emailing the agent. Project Deal validates the *philosophy* (LLM negotiates) but
left the *guardrail* (bounded authority, injection defense) as the open problem. Our design must supply
that guardrail. Keeping bounded guards is therefore *more* aligned with Project Deal's conclusions than
removing them — the paper names their absence as the risk.

## The two roles — never blur them

### Role 1 — the LLM DECIDES the negotiation (this is the product)
The model reads the full history and the creator's message and decides: the action (counter / accept /
present / reject / hold), the number, the concession size and pace, how to answer questions, when the deal
is done. **No deterministic formula computes offers, concessions, or accept/reject.** Anything that today
does this in code is a defect to migrate to the model:
- `_decide_action` stepping ladder (`agent/app/routes/negotiate.py:337-456`) — `midpoint(offer, ask)` etc.
- regex intent gates that classify the creator before the model runs
- regex that extracts the deal rate into the money path
- reward-agreement / renegotiation regex that decides contract formation

### Role 2 — code DEFINES THE SANDBOX the LLM negotiates inside (this is the guardrail)
Deterministic code enforces the hard, money/compliance/safety invariants the model must never cross:
- **Ceiling** — the brand's maximum. A commitment above it is never auto-sent.
- **Floor** — the brand's minimum. An offer below it is never auto-sent.
- **Injection / opt-out** — a hostile or unsubscribing creator can never steer a real commitment.
- **Irreversible actions** — sending a binding email, closing a deal, moving money.

These are guardrails, not decisions. They do not pick the number; they define the range and the exits.

## Enforcement mechanism (decided for this project)

When the LLM's chosen action/number crosses a **hard** bound, code takes over deterministically:

- **Over ceiling → ESCALATE to a human.** Never auto-commit above budget.
- **Below floor → clamp UP to floor.** Never auto-offer below the minimum.
- **Unreadable/absent number on a rate-bearing action → ESCALATE.** Never invent a price.
- **Unknown/garbage action → ESCALATE.**

This is a hard-clamp/escalate model (chosen deliberately for real-money safety), NOT a return-to-LLM loop.
The LLM negotiates freely *inside* [floor, ceiling]; the moment it would breach a wall, code — not the
model — resolves it safely.

**The one absolute rule this creates:** because a guard can change the action or number *after* the model
wrote its email, **the outgoing email must always be (re-)drafted from the guarded decision.** A pre-guard
draft may never ship. This is why `HARD-N1` step 3 ("always draft after guards; never ship
`responseDraft` verbatim") is load-bearing, not optional — it is the seam where "code overrode the number"
must not become "email says a different number than the deal."

### Soft bounds are advisory (prompt), not clamps
"Don't regress below your last offer," "don't offer above the creator's ask," "don't repeat wording,"
"concede in small steps" — these are **negotiation discipline, and they belong to the LLM.** State them in
the prompt. Do NOT hard-clamp them in code: clamping soft discipline in code is re-introducing the rule
tree Project Deal argues against, and it fights the model's reasoning. (Contrast: the *hard* money bounds
above ARE clamped, because they protect the brand from a bad/hostile decision, not just imperfect tactics.)

> Note: an earlier draft of `HARD-N1` proposed hard-clamping anti-regression/anti-over-ask in code. Per
> this principle, do NOT. Keep those as prompt rules; only floor/ceiling/injection/opt-out are code-clamped.

## Strategy default (decided for this project)

- `NEGOTIATION_STRATEGY=llm` is the **intended production path** — the LLM decides every turn.
- The deterministic `rules` ladder is demoted to a **fallback that runs ONLY when the model is unavailable
  or its output is malformed** (transport error, timeout, invalid JSON after retries). It is a safety net,
  not a co-equal default.
- Action items:
  1. Make `llm` the effective default (`agent/app/routes/negotiate.py` strategy dispatch, `_langgraph_negotiate`).
  2. Widen the fallback catch (see `MED-L1`) so ANY model failure — not only `StructuredOutputError` —
     degrades to the rules fallback instead of 500ing.
  3. Reframe `rules`/`_decide_action` in comments + docs as "deterministic safety fallback," not "the
     audited default."

## How to read each spec against this doc

- **Security, workflow-integrity, reliability, knowledge, observability, testing** issues are **orthogonal**
  to who-negotiates — they stand regardless of the LLM-vs-rules question (a lost reply, an unauthenticated
  API, or a wrong-fee email is a bug under any philosophy). Implement as written.
- **Negotiation / prompt / decision-seam** issues must follow the two roles above:
  - Anything that makes code *decide* → migrate to the LLM.
  - Anything that makes code *bound* hard money/safety limits → keep, and ensure a crossed bound forces a
    re-draft so the email can't contradict the guarded decision.
- If a spec says "clamp" for a **soft** rule (regression, over-ask, repetition), treat it as "prompt rule,"
  not code. If it says "clamp/escalate" for a **hard** bound (floor/ceiling/injection/opt-out), keep it.

## Quick classification table

| Concern | Owner | Mechanism |
|---|---|---|
| Which action, what number, concession pace | **LLM** | reasoning over full history |
| Answering product/campaign/logistics questions | **LLM** | prompt + threaded knowledge (HARD-K1) |
| When the deal is done / not worth pursuing | **LLM** | reasoning (bounded by round cap) |
| Don't regress / don't exceed ask / don't repeat | **LLM** | prompt discipline (NOT code clamp) |
| Ceiling (max commit) | **Code** | over → escalate to human |
| Floor (min offer) | **Code** | below → clamp up |
| Unreadable/absent rate, unknown action | **Code** | escalate (never invent) |
| Prompt injection / opt-out from untrusted email | **Code** | gate before the model, on every turn |
| Round cap / irreversible send | **Code** | hard limit + idempotent send |
| Email must match the guarded decision | **Code** | always re-draft after guards (HARD-N1.3) |
