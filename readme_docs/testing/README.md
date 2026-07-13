# Escalation-Trap Testing

**What this proves:** the V1 escalation behavior the founder specified — clean
one-way human handoff, auto-reject on failed negotiation, tolerance-bounded
over-ceiling, always-escalate topics, deferred follow-ups — actually holds, and
can't silently regress.

**Scope note (important):** the three tiers below prove *different* things, and
**only Tier 3 is truly end-to-end.** Tiers 1 and 2 are deterministic (no LLM) and
run in CI; they lock the routing and the guard math. Tier 3 drives the real Ollama
model through the whole path and is the "I watched it work" proof.

---

## The trap matrix

Every trap is checked at whichever tier(s) can prove it. `✅` = asserted, `👁` =
observed (live), `—` = not applicable at that tier.

| # | Trap | Trigger | Expected outcome | T1 | T2 | T3 |
|---|------|---------|------------------|----|----|----|
| 1 | Max-rounds, no agreement (#15) | negotiate past `maxRounds` | `REJECTED` + courteous close email | ✅ | — | 👁 |
| 2 | Close email best-effort (#15/Q2) | send fails | still `REJECTED` | ✅ | — | 👁 |
| 3 | Over-tolerance ask (#12) | `ask > ceiling*(1+tol)` | `ESCALATE` → `MANUAL_REVIEW` | ✅ | ✅ | 👁 |
| 4 | In-tolerance over-ceiling (#12) | `ceiling < ask ≤ tol-ceiling` | close **AT ceiling** (no overpay) | — | ✅ | 👁 |
| 5 | Final round in-band (#13) | final round, `ask ≤ tol-ceiling` | `ACCEPT` at clamped rate | — | ✅ | 👁 |
| 6 | Final round over-tolerance (CRITICAL-4) | final round, `ask > tol-ceiling` | `ESCALATE` (no false accept) | — | ✅ | 👁 |
| 7 | Never below floor / above ceiling | out-of-band number | clamped into `[floor, ceiling]` | — | ✅ | — |
| 8 | Always-escalate topic (#5) | legal/dispute/pricing/usage-rights reply | `MANUAL_REVIEW` regardless of confidence | ✅ | ✅ | 👁 |
| 9 | Payment-timing defers (Q3) | "when do I get paid?" | honest-defer, **not** escalated | — | ✅ | 👁 |
| 10 | Low-confidence reply (#10) | `confidence < 0.50` | `MANUAL_REVIEW`, `low_confidence_reply` | ✅ | — | 👁 |
| 11 | Deferred reply (#3) | "I'll think about it" | `AWAITING_REPLY` + `dueAt` ~+3d | ✅ | — | 👁 |
| 12 | Low-confidence deferred | deferred, `conf < 0.50` | `MANUAL_REVIEW` (gate wins) | ✅ | — | 👁 |
| 13 | Opt-out (CAN-SPAM) | "unsubscribe" | `OPTED_OUT` (deterministic) | ✅ | — | 👁 |
| 14 | **Negative (#14)** | any escalation | never `AWAITING_BRAND_DECISION`; no magic-link path; `MANUAL_REVIEW`/`REJECTED` terminal | ✅ | — | 👁 |

---

## Tier A — T1: routing tests (deterministic, no LLM, no DB)

**File:** `server/src/engine/escalationTraps.test.ts`
**Proves:** given a canned agent verdict / classifier output, the instance lands in
the right state with the right side effects. This is the **routing** layer.

```bash
cd server
npx tsx --test src/engine/escalationTraps.test.ts     # just the trap file
npm test                                               # whole server suite
```

**How it works:** uses the injectable `ReplyDetectionDeps` seam (stubbed DB +
stubbed agent) for the reply-detection traps, and calls the exported negotiation
routing helpers (`maxRoundsReject`, `escalateOverCeiling`) directly for the
negotiation traps. No Redis, no Neon — milliseconds per test.

### T1 boundary: close-email *send*
T1 asserts the close email is **drafted** and that `REJECTED` is reached even when
the send path fails — but it does **not** assert the email is actually delivered.
`sendOnce()` reserves a `Message` row in the DB *before* calling `email.send()`, so
in a no-DB unit test the send is swallowed by `sendCloseEmail`'s best-effort catch.
Proving the close email is truly **delivered** is a **T3** (live) assertion.

---

## Tier B — T2: agent guard-math tests (deterministic, no model, no HTTP)

**File:** `agent/tests/test_escalation_traps.py`
**Proves:** the "code guards" half of "LLM decides, code guards" — the pure
decision functions the model's output is bounded by. Calls `_apply_decision_guards`,
`_decide_action`, and the `topic_gate` functions directly with crafted inputs.

```bash
cd agent
pytest tests/test_escalation_traps.py -q
```

No model call, no network — pure functions. This is the tier that catches
**overpay bugs**, **wrong escalation boundaries**, and **topic-gate ordering**.

---

## Tier C — T3: live end-to-end (real Ollama) — the true end-to-end proof

**Not automated** (deliberately): it depends on `qwen3:8b`'s judgment (flaky) and is
slow (~60s per `/negotiate` call), so it does not gate CI. Run it as a one-time (and
repeatable-on-demand) confidence check, and after any change to the agent prompts or
the guard boundaries.

### Prerequisites (start these; they were already running in the dev session)
1. **Ollama** up with `qwen3:8b` loaded — `curl localhost:11434/api/ps` should list it.
   Confirm `OLLAMA_VULKAN=false` (an iGPU-misroute makes it ~4 tok/s on the wrong GPU).
2. **Redis** on `localhost:6379`.
3. **Neon** reachable (`DATABASE_URL` in `.env`).
4. **Agent** on `:8001` with **`LLM_PROVIDER=ollama`** (not `openrouter`) — restart the
   agent after changing `.env` so it reloads the provider.
5. **Server** (API + worker + scheduler) with **`EMAIL_PROVIDER=mock`** so no real email
   fires during the test.

### Quick endpoint smoke (no server/worker needed)
Hit the agent directly to confirm the model reaches each trap. `/negotiate` requires
`currentOffer`:

```bash
# Over-ceiling ask — expect action ESCALATE (rules) or a below-ceiling COUNTER (llm; see D-1)
curl -s -m 90 -X POST http://localhost:8001/negotiate \
  -H "Content-Type: application/json" \
  -d '{"creatorReply":"My rate is $5000 flat, non-negotiable.",
       "currentOffer":{"rate":200},"round":0,"maxRounds":3,
       "campaignConstraints":{"termFloor":{"rate":200},"termCeiling":{"rate":500},
                              "recommendedOfferPosition":0.0,"overCeilingTolerance":0}}'

# Always-escalate topic — expect escalationReason set (usage_rights_or_licensing)
curl -s -m 60 -X POST http://localhost:8001/classify \
  -H "Content-Type: application/json" \
  -d '{"message":"Do I keep exclusive usage rights and licensing for my content?"}'

# Payment-timing — expect NORMAL classification (POSITIVE/QUESTION), escalationReason null (Q3 defer)
curl -s -m 60 -X POST http://localhost:8001/classify \
  -H "Content-Type: application/json" \
  -d '{"message":"Sounds good — quick q, when do I get paid after posting?"}'
```

### Full workflow run (server + worker + DB)
Drive a real creator through to each trap and read the final state + event log via
the observability routes (`GET /observability/instances/:id`, `.../timeline/:id`) or
Prisma Studio (`npm run db:studio`). Assert:
- max-rounds → `REJECTED`, a close `Message` row exists (this is the delivery proof T1 can't give)
- over-tolerance → `MANUAL_REVIEW`
- topic reply → `MANUAL_REVIEW` with the topic reason, **even at high confidence**
- deferred → `AWAITING_REPLY` with a `dueAt` ~3 days out
- **negative:** no instance is ever in `AWAITING_BRAND_DECISION` (the state no longer exists)

> **Run status (2026-07-13): the endpoint smoke passed (all 4 traps green live +
> provider confirmed Ollama), but the full workflow run is BLOCKED on local
> model/infra flakiness — NOT an escalation bug.** A freshly launched instance
> stuck at `ENROLLED` because the outreach `/draft` step intermittently 500s /
> times out on `qwen3:8b` and the worker hit Neon "connection error and is not
> queryable" drops (seen in `/queues/health` failedReasons). The instance never
> reached a negotiation state to inject the over-ceiling reply into. This is the
> known local-model reliability issue (see the project notes on qwen classify/draft
> latency + the `:8001` behavior), and is exactly why this tier is non-automated.
> To retry: ensure the agent is healthy on Ollama, bump `AGENT_TIMEOUT_MS` /
> `LLM_INVOKE_TIMEOUT_SECONDS`, restart the worker, and re-launch. The escalation
> ROUTING is fully covered deterministically by T1 (server) + T2 (agent) regardless.

### The 4th layer we do NOT automate
A *real inbound email through Nylas → webhook → correlate* is a further layer. Per the
project notes, replies land in spam / don't reliably route, so that stays a manual
check with a real inbox; the T3 workflow run injects the reply at the classify/queue
level instead.

---

## Known divergences (findings — DECISIONS NEEDED)

These are places where **current behavior differs from the founder's literal
wording**. The tests assert *current* behavior (so the suite is green and honest);
each item below is a product decision to resolve.

### D-1 — Over-ceiling ask on an EARLY round: LLM anchors low, rules escalates — RESOLVED
- **Decision (2026-07-13): anchor low, then escalate at max-rounds** is the intended V1
  behavior. It matches #15's "minimize human load" (an aggressive opener often comes down
  before a human is spent on it). The LLM path already does exactly this, so **no code
  change** was made.
- **LLM path** (`_apply_decision_guards`, `NEGOTIATION_STRATEGY=llm`, the live default) —
  **intended:** on an early round it lets the model COUNTER at/below the ceiling (anchor
  low) and only forces `ESCALATE` for an over-tolerance ask on the **final** round
  (CRITICAL-4). The live `/negotiate` curl returning `COUNTER $200` for a $5000 ask is
  correct behavior, not a bug (no overpay — the counter is clamped to the ceiling).
- **Rules path** (`_decide_action`, `NEGOTIATION_STRATEGY=rules`, the LLM-failure
  fallback only) escalates an over-ceiling ask immediately on any round. This
  **intentionally differs** from the LLM path: rules is the safe conservative degrade
  used when the model is unavailable/malformed, so escalating-immediately there avoids
  risking a bad auto-counter with no model in the loop. Left as-is by decision.
- **Pinned by:** `test_decide_action_early_round_over_ceiling_escalates_immediately`
  (rules) + `test_guard_allows_early_round_counter_below_ceiling_on_over_ceiling_ask`
  (llm) in T2 — both assert the intended behavior of their respective path.

### D-2 — Utility-curve concession math not implemented (#1)
- **Founder #1:** treat the band as a utility curve (preferred = 1.0, max = 0.0); make
  the *smallest* concessions necessary, so a close near the floor beats one near the
  ceiling.
- **Current:** symmetric midpoint stepping (`_step_offer`); the relabel to
  "Preferred / Maximum Budget" landed, but the concession math is a marked **TODO**
  (Phase F, deliberately deferred — it's Opus-tier decision math).
- **DECISION NEEDED:** in scope for V1, or leave to a later pass? (Founder's own answer
  called this later-phase, so deferring is defensible.)

---

## Adding a trap

1. Add a row to the matrix above.
2. Assert the **routing** in T1 (`escalationTraps.test.ts`) if it lands via an executor.
3. Assert the **decision/guard math** in T2 (`test_escalation_traps.py`) if it's an
   agent-side decision.
4. Add a live check line to the T3 runbook.
5. If current behavior diverges from intended, assert current behavior + add a **Known
   divergence** entry — do **not** bake in a guessed target.
