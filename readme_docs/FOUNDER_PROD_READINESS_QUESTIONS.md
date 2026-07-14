# Prod-Readiness — Founder Decisions Needed

**Date:** 2026-07-14 · **For:** founder sign-off before pointing real creators at the AI
**Context:** We're about to (a) land two hardening fixes (H1/H2), (b) swap negotiation → **Opus 4.8**
and drafting → **DeepSeek**, and (c) cut over to prod. Before that, a set of decisions are *yours*,
not the engineering team's — either because they trade business risk for speed, or because they
change stated V1 behavior. This doc lays out each with its current build status so you can answer
with full context.

The two that gate everything else are **Q1** and **Q2** — please answer those first; several of the
others collapse depending on how you answer them.

---

## Q1 — Launch shape: supervised pilot, or real launch? 🔴 lead question

Is v1 a **controlled pilot** (a few creators, one trusted brand, a human eyeballs every AI send at
first) or a **real autonomous launch** (the AI sends without per-message review)?

**Why it's load-bearing:** if a human reviews every send for the first N conversations, then Q3, Q4,
and Q6 below all drop from "blocker" to "fast-follow." If it's autonomous from day one, they're hard
blockers.

- [ ] Supervised pilot — human reviews every send at first
- [ ] Autonomous launch — AI sends unattended
- Scope: how many creators / which campaign(s) for v1? ________________

---

## Q2 — Money-path risk tolerance 🔴 lead question

The AI transacts real dollars and holds an internal floor/ceiling it must never reveal.

**Ask yourself:** *what is the worst-case cost of (a) the AI accepting a bad rate, or (b) leaking the
internal floor/ceiling to a creator?*

**Why it's load-bearing:** your answer sets the eval bar. We have a cheap stratified subset (~30
cases, ~$1–2) ready to run on the new Opus+DeepSeek models. Whether that's *enough* — versus the full
500-case regression (low tens of $) before launch — is your risk call, not ours to make silently.

- [ ] Subset is enough for launch; full 500 is a fast-follow
- [ ] Require full 500-case eval green before any real creator
- Worst-case $ of a wrong accept: ________________

---

## Q3 — Failed negotiation: escalate, or hard auto-reject? ⚠️ changes stated V1 behavior

Your V1 answer #15 was: *max rounds with no deal → auto-close/reject, no human (volume).*

**Current reality:** under LLM-driven negotiation (the mode we're shipping with Opus), the model on
its final round always **ACCEPTs or ESCALATEs** — it never COUNTERs — so the auto-reject path
**never fires**. In practice, a stalled negotiation goes to a human, not to auto-reject.

**Status:** known gap, documented. Making auto-reject actually fire under LLM mode is a
strategy-logic change, not a config flip.

- [ ] Escalating a stalled negotiation to a human is acceptable for v1 (ship as-is)
- [ ] I require the hard auto-reject I specified — treat as a blocker

---

## Q4 — Observability: OK to launch blind on cost? ⚠️ operational risk

There is **no per-conversation token/latency/cost telemetry** today (it's scaffolded, not wired).
Opus is materially more expensive than the local model we've been testing on.

**Status:** telemetry is a known deferral (HARD-O1). Shippable without it, but you'd be flying blind
on spend-per-negotiation at launch.

- [ ] OK to launch without cost visibility; add telemetry as fast-follow
- [ ] I need to see per-negotiation cost before real creators — treat as a blocker

---

## Q5 — Model swap: Opus (negotiate) + DeepSeek (draft) — approved? ⚠️ new external dependency + cost

We're moving negotiation to **Opus 4.8** and drafting to **DeepSeek**. DeepSeek is a *new external
provider* on the draft path — the path with the hard "never leak floor/ceiling, answer every creator
question" invariant. It has **not yet been validated** against those draft guards on the new model.

**Status:** swap not yet wired; DeepSeek draft-guard validation pending (part of the eval above).

- [ ] Approved — including the cost profile and adding DeepSeek as a dependency
- [ ] Want to discuss model/cost/vendor choice first

---

## Q6 — Uncapped-campaign policy (product decision)

We just added a safety backstop: a campaign with a **preferred budget but no maximum** can't be
auto-negotiated (there's no ceiling to negotiate within), so it's handed to a human with a clear
"set a maximum budget" message.

**Question:** is *"escalate to a human"* the right behavior — or should the brand simply be **blocked
from publishing** a campaign with no max budget in the first place?

**Status:** runtime escalation is built (H1). Publish-time blocking would live in the parent app and
is not built.

- [ ] Escalate at runtime is fine (current behavior)
- [ ] Block publishing an uncapped campaign entirely (new parent-side work)

---

## Summary — what's a blocker depends on Q1

| Q | Decision | If Q1 = supervised pilot | If Q1 = autonomous |
|---|----------|--------------------------|--------------------|
| Q2 | Eval depth | subset likely enough | your risk call, likely full 500 |
| Q3 | Stall → escalate vs reject | fast-follow | possible blocker |
| Q4 | Cost telemetry | fast-follow | likely blocker |
| Q5 | Model swap approval | needed either way | needed either way |
| Q6 | Uncapped policy | current behavior fine | current behavior fine |

**Bottom line:** the *code* is nearly ready (H1/H2 + tests, tsc clean). "Prod-ready" for the *system*
hinges on your answers to Q1 and Q2 — everything else is downstream of those two.
