# Production-Readiness Remediation Specs

Source: full 14-section Staff-Engineer audit run 2026-07-08 on branch `feat/llm-driven-negotiation`
(5 parallel deep-read agents: workflow engine, AI service, negotiation quality, security, testing).
Every issue below is verified against the working tree with `file:line` evidence.

> **READ [`PRINCIPLES.md`](./PRINCIPLES.md) FIRST.** It is the governing design principle for the whole
> set — aligned with Anthropic's **Project Deal**: the **LLM decides the negotiation** (action, number,
> concessions, when to close); **code only defines the sandbox** (hard floor/ceiling/injection/opt-out
> bounds) and, when a bound is crossed, escalates or clamps AND forces a re-draft so the email can't
> contradict the guarded decision. Soft discipline (don't regress, don't exceed the ask, don't repeat) is
> prompt-level, NOT code-clamped. `NEGOTIATION_STRATEGY=llm` is the intended production default; the
> deterministic `rules` ladder is a fallback for when the model is unavailable. Where any tier file's
> wording predates `PRINCIPLES.md`, that doc wins.

## How to use these specs

Each tier file lists issues as `[TIER-N]`. Each issue has:
- **Where** — exact file:line locations of the offending code.
- **Problem** — what is wrong and why it matters in production.
- **Fix** — the concrete approach, enough for an implementer to work from cold.
- **Verify** — how to confirm the fix works.
- **Blast radius** — what else the change touches.

Implement in tier order: **Critical → Hard → Medium → Easy**. Within Critical, the first
five are true deploy-blockers (visible wrong outcomes to real brands/creators).

## Scoring context (current → target 8+)

| Area | Now | Reachable by code alone? |
|---|---|---|
| Architecture | 5 | Yes (HARD-A*) |
| Workflow | 4 | Yes (CRITICAL + HARD) |
| Negotiation | 4 | Yes (CRITICAL-4, HARD-N*) |
| Prompt Engineering | 4 | Yes (HARD-P*) |
| Maintainability | 5 | Yes (MED) |
| Scalability | 3 | **No** — needs multi-instance deploy + load evidence (HARD-S*) |
| Reliability | 4 | Yes (CRITICAL + HARD) |
| Observability | 2 | **No** — needs metrics/tracing/alert stack (HARD-O*) |
| LLM Integration | 5 | Mostly (MED-L*) |
| Knowledge Handling | 3 | Yes (HARD-K*) |
| Security | 3 | Component-scope only (CRITICAL-1 sender identity, MED-S*, EASY-S*); perimeter auth is the parent system's job — see CRITICAL-5 removal |
| Testing | 4 | **No** — needs real ≥500-case dataset + CI (HARD-T*) |

Three areas (Scalability, Observability, Testing) cannot reach 8 with a code diff alone; the
specs cover the code scaffolding, but the score only moves once the surrounding infra/data exist.

## Tier files

- [`PRINCIPLES.md`](./PRINCIPLES.md) — **read first.** LLM-negotiates / code-guards design principle (Project Deal alignment).
- [`RUN_PLAN.md`](./RUN_PLAN.md) — **implementation order.** 50 fixes in 5 dependency-ordered batches of 10, with parallel lanes and single-file-owner rules.
- [`critical.md`](./critical.md) — deploy blockers: wrong outcomes to real parties, lost data, sender-identity gap (5 active; CRITICAL-5 API-auth removed as parent-system scope).
- [`hard.md`](./hard.md) — structural redesigns: decision seam, prompt rearchitecture, infra splits, eval/observability scaffolding.
- [`medium.md`](./medium.md) — correctness + safety hardening that isn't a redesign.
- [`easy.md`](./easy.md) — localized fixes, small diffs, low risk.

## Architecture primer (read before implementing)

- **Two services.** TypeScript engine (`server/`) = HTTP API + 2 BullMQ workers + 30s scheduler, all in
  one process (`server/src/index.ts:104-105`). Python AI service (`agent/`) = FastAPI hosting the LLM
  (`/classify`, `/negotiate`, `/draft`).
- **State machine.** 17 states, legality table in `server/src/engine/stateMachine.ts:7-86`. `WorkflowRuntime.stepInstance`
  (`server/src/engine/runtime.ts:185-300`) = loadContext → executor → assertTransition → OCC update → append event.
- **AI seam.** `IAgentProvider` (`server/src/engine/providers.ts:101-154`) → `AgentProviderAdapter` degradation
  (`server/src/engine/providerFactory.ts:175-340`) → `LangGraph*Provider` HTTP → shared client
  (`server/src/adapters/agentServiceClient.ts`) with one circuit breaker.
- **Two negotiation strategies** (`agent/app/routes/negotiate.py`): `rules` (default) = LLM classifies/extracts,
  deterministic `_decide_action` (line 337) makes the money call; `llm` (`NEGOTIATION_STRATEGY=llm`) = model picks
  action+rate, `_apply_decision_guards` (line 559) clamps.
- **Money safety is the strength** — floor/ceiling clamps, round caps, escalate-on-uncertainty are code-enforced.
  **Sender identity is the weakness in scope** — no sender verification (CRITICAL-1). **Perimeter security
  (API auth, session, rate limiting) is OUT OF SCOPE** — this is a component inside a larger parent system
  that owns the perimeter (see the CRITICAL-5 removal note). Only the component's own correctness/data
  lifecycle stays: sender identity, token expiry, content validation, leak-value masking.
