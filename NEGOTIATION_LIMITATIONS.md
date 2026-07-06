# Negotiation & Agent Limitations — First-Principles Gap Analysis

> **Purpose.** A working list of where the current negotiation/agent layer is
> *thin* — not bugs, but structural limitations that will surface as we push the
> product toward real, messy creator conversations. Written from first principles
> (what does a human partnerships manager actually do that we don't?) and grounded
> in the current code, not aspiration. Intended as a discussion starter for
> Tuesday's product-direction session.
>
> **Scope note.** This is deliberately honest about gaps. The system is well-built
> for what it *claims* to do (a bounded, auditable, single-axis fee negotiation
> with a human safety net). Most of the items below are things it was never asked
> to do yet — they're the frontier, not a report card.
>
> **How to read this.** Each section states the limitation, *why it's a limitation*
> (what breaks or degrades), where it lives in the code, and a rough sense of
> effort/impact. The five themes the product owner raised are called out inline.

---

## 0. TL;DR — the ten that matter most

| # | Limitation | Theme | Impact |
|---|---|---|---|
| 1 | Single reply, single intent — no multi-question / multi-request decomposition | *Multiple questions in one email* | **High** |
| 2 | No "answered vs. still-pending" ledger across the thread | *Answered vs. pending* | **High** |
| 3 | Negotiation memory is a lossy summary (round/action/rate/snippet), not the conversation | *Context across the thread* | **High** |
| 4 | Only the **fee** is a negotiable axis; everything else is "fixed or escalate" | *Objections / hidden intent* | **High** |
| 5 | Next action is a fixed workflow, not a policy over conversation state | *Next best action* | **High** |
| 6 | Human-approval boundary is coarse (band + rounds), not risk/uncertainty-aware | *When to ask a human* | **Med-High** |
| 7 | Objections, stalls, and hidden intent are invisible to the decision layer | *Objections / hidden intent* | **High** |
| 8 | Rate extraction is regex/one-number; no structured terms, no ambiguity handling | *Context / hidden intent* | **Med-High** |
| 9 | Two negotiation "brains" (rules vs. llm) can disagree; copy can contradict the action | correctness | **Med** |
| 10 | No accuracy/quality measurement on the negotiation path (evals, drift, cost) | can't-improve-what-you-can't-measure | **High** |

The rest of the document expands each, plus a long tail of structural gaps
(conversation model, safety, product, ops).

---

## 1. Intent & comprehension — understanding what the creator actually said

This is the cluster the product owner flagged, and it is where the current design
is thinnest. The whole comprehension layer is built around one assumption:

> **A creator reply has exactly one intent and (at most) one number.**

That assumption is baked in at three levels — the classifier
(`agent/app/routes/classify.py`), the rate extractor
(`extractRequestedRate` in `negotiation.ts`, `_coerce_rate` in `negotiate.py`),
and the response contract (`NegotiateResponse` = one `action` + one
`proposedTerms.rate`). Real creator emails routinely violate it.

### 1.1 No multi-question / multi-request decomposition  *(Theme: multiple questions)*

**Limitation.** The classifier collapses an entire email into **one** label from
a five-value enum (`POSITIVE / NEGATIVE / QUESTION / OPT_OUT / UNKNOWN`). A
message like:

> "Love the brand! What's the commission split, do I keep the product, and can
> we do $600 instead of what you mentioned? Also when does this go live?"

…is a fee proposal **and** three distinct questions **and** a positive-sentiment
signal — but it becomes a single `POSITIVE`/`QUESTION` token. There is no
representation anywhere in the system of "this message contains N discrete asks."

**Why it's a limitation.** The *only* thing forcing completeness today is a
**prompt instruction** to the drafting model ("address EACH point"; see
`_LLM_NEGOTIATE_PROMPT` and `_OFFER_PROMPT` in `negotiate.py`). There is:
- no extraction of the individual questions,
- no check that the outbound reply actually answered them,
- no retry-if-incomplete loop tied to the *questions*, only to JSON validity.

So completeness rides entirely on a 7B/8B local model remembering to be thorough
in one pass. The memory note `counter-email-completeness-fix` documents this
exact failure recurring twice on live emails — it's a known-fragile seam, patched
with prompt wording rather than structure.

**Where.** `agent/app/routes/classify.py` (single-label output);
`_OFFER_PROMPT` / `_LLM_NEGOTIATE_PROMPT` in `negotiate.py` (prompt-only
completeness).

**What "good" looks like.** A structured comprehension step that returns a *list*
of atoms — `[{type: question, topic: commission}, {type: proposal, field: fee,
value: 600}, {type: question, topic: timeline}, …]` — that the rest of the system
can iterate over and check off. This is the single highest-leverage change for the
themes raised.

### 1.2 No "answered vs. still-pending" tracking  *(Theme: answered vs. pending)*

**Limitation.** Nothing tracks what has been asked and answered over the life of a
thread. Each turn is processed against **only the latest inbound message**
(`latestCreatorInbound` → `extractReplyText` in `negotiation.ts`). If a creator
asked about exclusivity in message 1 and we didn't address it, and they ask about
the timeline in message 3, the system has no notion that exclusivity is still an
open question. There is no open-questions ledger.

**Why it's a limitation.** Humans track "you asked X, I owe you an answer." Its
absence produces two visible failures: (a) we drop questions we couldn't answer
in the moment and never circle back; (b) we can re-answer or re-litigate a point
already settled, because "settled" isn't recorded. The negotiation history we *do*
persist (§3) is about **money moves**, not **information exchange** — it has no
slot for "topics raised / topics resolved."

**Where.** `negotiation.ts` (only latest inbound is read);
`negotiationHistory.ts` (`buildPriorContextFromEvents` records
`{round, action, rate, message}` — no question/answer state).

### 1.3 Objections, stalls, and hidden intent are invisible  *(Theme: objections / hidden intent)*

**Limitation.** The decision layer sees **intent label + a number**. It cannot
represent:
- an **objection** that isn't about price ("I don't do exclusivity deals," "my
  audience won't like a hard-sell brief"),
- a **stall / soft-no** ("let me think about it," "circle back next quarter"),
- **hidden intent** (fishing for a higher anchor, testing if we'll budge,
  comparing against a competing offer they mention),
- **conditional acceptance** ("yes, *if* you drop the exclusivity clause").

In the rules path these all collapse to `NEGOTIATION`/`OBJECTION` → a flat
`COUNTER` at the same number (see the fallthrough in `_decide_action`,
`negotiate.py`). In the llm path the model *might* respond sensibly in prose, but
the **action** is still one of five money-moves, so a non-price objection has no
action that fits — it either gets a fee counter it didn't ask for, or an escalate.

**Why it's a limitation.** Most real negotiation friction is *not* "your number
is too low." It's terms, trust, fit, and timing. A system whose only lever is the
fee will mishandle the majority of genuine objections — either by ignoring them
(prose-only, no state change) or by escalating everything non-fee to a human,
which defeats the automation.

**Where.** `_decide_action` and `_apply_decision_guards` in `negotiate.py`
(action space is 5 money-moves); `NegotiationAction` literal.

### 1.4 Rate extraction is brittle and single-valued

**Limitation.** The creator's ask is pulled out by regex
(`extractRequestedRate`, `negotiation.ts`) or a loose coercion
(`_coerce_rate`, `negotiate.py`). Both assume **one** number that **is** the
rate. They mishandle:
- **ranges** ("$500–700"), **per-unit** pricing ("$300 per reel, 3 reels"),
- **package** framing ("$1,500 for the bundle, or $600 each"),
- **conditional** numbers ("$500 now, $800 if it performs"),
- **non-fee numbers** in the same sentence ("$500 fee, 3 posts, 15% off code").
  There's a `MIN_BARE_RATE = 50` heuristic and a "must be near a rate-word" guard,
  which helps but is still a single-scalar guess.

**Why it's a limitation.** A wrong-number extraction feeds the money decision
directly. The guards (band clamp, escalate-on-unreadable) keep it *safe*, but
"safe" here means "escalate to a human a lot" — every ambiguous or multi-number
ask that the regex can't resolve becomes manual work. Precision here directly
trades against how much the system can actually close on its own.

**Where.** `extractRequestedRate` (`negotiation.ts` ~L93-127);
`_coerce_rate` (`negotiate.py`).

---

## 2. Deciding the next action — policy vs. fixed workflow  *(Theme: next best action)*

**Limitation.** The "next best action" is almost entirely **positional**, not
**deliberative**. The workflow is a linear, ordered node graph
(`nodeGraph` sorted by `order`; routing is `find(n => n.order === node.order+1)`
in the executors). Within negotiation, the action is chosen by:
- the **rules** path: a deterministic `if`-ladder over `(intent, rate, prior
  offer, round)` — genuinely just a decision table, and
- the **llm** path: the model picks, then guards clamp it.

Neither path reasons about the *goal state* of the conversation. There is no
concept of "what's the expected value of countering vs. accepting vs. holding
here, given how this creator has behaved so far." The step size is a **fixed
midpoint** (`_step_offer` = `avg(our_offer, their_ask)`), regardless of how many
rounds remain, how the creator has moved, or how close we are to walk-away.

**Why it's a limitation.** A good negotiator's next move depends on trajectory
(are they converging or dug in?), leverage (how much do we want *this* creator?),
and budget-vs-rounds-remaining. The current system has none of that context in its
decision function. It will:
- concede on the same midpoint schedule whether the creator moved $5 or $200,
- treat round 1 of 5 and round 4 of 5 with the same step logic (except the
  hard "final round = accept" rule),
- never proactively *offer a non-price sweetener* (longer term, more content, a
  bonus) to close a gap, because those aren't in the action space.

**Where.** `_decide_action` / `_step_offer` (`negotiate.py`); linear routing in
every executor; `_apply_decision_guards` (llm path clamp).

**Tension to flag for Tuesday.** This limitation is partly *by design* — memory
`negotiation-false-acceptance-fix` and the `negotiation.md` doc show the money
decision was deliberately pulled **out** of the model for reproducibility and
auditability. So "make it more deliberative" is in direct tension with "keep it
deterministic and safe." The real product question is *where* on that spectrum we
want to sit, and whether different campaigns want different points on it.

---

## 3. Conversation memory & context across the thread  *(Theme: context across the thread)*

**Limitation.** The agent is stateless per call (an intentional architecture
choice — see `open-questions.md` Q5). The server rebuilds "memory" each turn from
persisted `NEGOTIATION_TURN` events via `buildPriorContextFromEvents`
(`negotiationHistory.ts`). But what it rebuilds is a **lossy summary**, not the
conversation:

Each history entry carries only `{round, action, rate, message-snippet}`. It does
**not** carry:
- the creator's **full prior messages** (only the *latest* inbound reaches the
  agent — confirmed in `negotiation.ts` and the adapter mapping),
- the creator's **asks from earlier turns** (extracted fresh each turn, never
  accumulated),
- **why** we moved from $350→$400 (no rationale persisted, just the new number),
- **sentiment/relationship trajectory** (warming, cooling, frustrated),
- **topics discussed** besides the fee (§1.2).

The memory note `llm-driven-negotiation` explicitly flags this: *"Raw full email
bodies NOT threaded … flagged as a follow-up."*

**Why it's a limitation.** The agent literally cannot reason about the *shape* of
the negotiation — it sees the current position and a list of past moves, like a
chess engine handed the board but not told whether the opponent has been
aggressive or cautious. So it can't:
- reference something the creator said two messages ago,
- notice a contradiction ("earlier you said 3 posts, now you're saying 5"),
- adapt tone to a creator who's clearly getting annoyed.

**Where.** `buildPriorContextFromEvents` (`negotiationHistory.ts`);
`latestCreatorInbound` (only latest inbound; `negotiation.ts`);
`NegotiationHistoryEntry` contract (`adapters/negotiation/types.ts`).

**Trade-off to flag.** Threading full bodies every call costs tokens/latency on a
local model and was consciously deferred. The mitigation might be a *running
structured summary* (topics, asks, sentiment, open questions) rather than raw
bodies — cheaper than full history, richer than the current snippet.

---

## 4. When to ask a human vs. continue autonomously  *(Theme: human-in-the-loop boundary)*

**Limitation.** The escalation boundary is **coarse and mechanical**. A run goes
to a human (MANUAL_REVIEW / AWAITING_BRAND_DECISION) on exactly these triggers:
- ask **above the ceiling** (or below floor after clamp),
- **rate unreadable** by the extractor,
- **max rounds** reached (B9),
- **output guard** hit (leaked bound / wrong commission %),
- **low classification confidence** (< 0.50) on the *first* reply (A1/A2),
- agent/transport **failure** (degrade-to-human).

**Why it's a limitation.** These are all about *price bounds, plumbing, and
first-reply confidence*. The boundary is blind to the things a human would
actually want to weigh in on:
- a **novel objection** or a term request outside the fixed set (§1.3) — the
  system either ignores it in prose or force-escalates, no middle ground,
- **legal/compliance-sensitive** asks (contracts, IP, usage rights, minors,
  regulated verticals) — no detection,
- a creator who is **clearly high-value** and worth a human touch even inside the
  band,
- **repeated confusion** (the creator keeps misunderstanding the offer) — no
  loop-detection,
- **emotional/reputational risk** (an angry or influential creator) — no signal.

Conversely, once a run is *in active negotiation* (`negotiationRound >= 1`), the
first-reply confidence gate is **skipped entirely** (the active-negotiation
short-circuit in `replyDetection.ts`), so a genuinely ambiguous mid-negotiation
message doesn't get the same "when in doubt, a human looks" treatment the first
reply gets. The safety net has a hole in exactly the phase with the most money at
stake.

**Where.** `replyDetection.ts` (confidence gate + short-circuit);
`negotiation.ts` (band/rounds/guard escalation paths);
`brandDecision.ts` (resolution). No per-turn uncertainty/risk score exists on the
negotiation path.

---

## 5. The negotiation "brain" — model, strategy, and correctness

### 5.1 Two decision engines that can disagree

**Limitation.** There are two strategies (`NEGOTIATION_STRATEGY = rules | llm`)
with genuinely different behavior, and the memory note documents them **diverging
on live input** (rules would COUNTER $475; the llm path ACCEPTed $500). The `llm`
path also falls back to `rules` on any error, so a single campaign can silently
mix both behaviors turn-to-turn depending on model availability.

**Why it's a limitation.** Two brains = two sets of edge cases, two things to
eval, and a reproducibility story that depends on which path ran. Fine for a
prototype exploring both; a real product needs to commit (or make the choice an
explicit, tested, per-campaign setting with known behavior).

**Where.** `_negotiation_strategy()` dispatch in `negotiate.py`.

### 5.2 The response text can contradict the action taken

**Limitation.** On the **rules** path the model produces `response` text under
`_NEGOTIATE_PROMPT` (which still contains full accept/counter *strategy*
guidance), but `_decide_action` **overrides** the actual action. So the model can
write "we're delighted to accept!" while the code sends a COUNTER. The audit note
`ai-layer-fresh-audit-2026-07` flags this exact prompt-vs-code contradiction. It's
mostly masked because offer copy comes from the separate `/draft` call — but on
reject/escalate paths the contradicting `responseDraft` can still ship as fallback
text.

**Where.** `_NEGOTIATE_PROMPT` (strategy guidance) vs. `_decide_action`
(authority) in `negotiate.py`.

### 5.3 Small local model = weak strategic negotiator

**Limitation.** The default model is a local Qwen (7B/8B/30B via Ollama). The
memory note is blunt: *"qwen3:8b over-concedes and people-pleases — folded
straight to the ceiling … still a weak strategic negotiator (writes good emails,
poor budget discipline)."* The prompt was hardened to curb the worst, but the
underlying capability is the ceiling.

**Why it's a limitation.** Prompt discipline can't fully substitute for reasoning.
The current safety architecture (deterministic guards) exists *precisely because*
the model can't be trusted with the money — which is the right call, but it also
means the llm path's upside is capped by the model. A stronger model (qwen3:30b,
or a frontier model like Claude for the hard turns) is the real quality lever, at
a cost/latency trade.

**Where.** `llm.py` (provider/model selection); `_LLM_NEGOTIATE_PROMPT` discipline
section.

### 5.4 Determinism is overclaimed

**Limitation.** Comments claim "identical inputs yield identical decisions," but
no `seed` is pinned and Ollama's `format="json"` structured mode is unused;
temp=0 ≠ reproducible on a GPU. The *money* decision is safe (deterministic
ladder), but the *intent classification and rate extraction feeding it* are **not**
reproducible. (From `ai-layer-fresh-audit-2026-07`.)

**Where.** `get_llm(temperature=0)` in `classify.py` / `negotiate.py`.

---

## 6. Measurement, observability & quality  *(cross-cutting)*

**Limitation.** We cannot currently answer "is the negotiation any good?"

- **No negotiation/draft evals.** The only eval set is **34 synthetic
  classification** cases, honestly documented as a *regression tripwire*, not an
  accuracy measure, and gated opt-in (`RUN_LLM_EVAL=1`) so CI never measures live
  model accuracy. There are **zero** evals for negotiation decisions or draft
  quality. (`ai-layer-fresh-audit-2026-07`, `CLASSIFICATION.md §8`.)
- **No token / latency / cost observability.** `server/src/observability/`
  tracks state transitions but has **no per-LLM-call metrics**. We can't detect
  quality drift, cost spikes, or a slow provider in prod.
- **Dead `confidence` field.** The negotiate model produces a `confidence` that is
  parsed and never read — tokens spent, nothing consumed. It's the obvious hook
  for an uncertainty-based escalation (§4) but currently wasted.
- **No outcome tracking.** Nothing records *did the deal close, at what rate,
  after how many rounds, and was the human-review escalation actually necessary?*
  Without this feedback loop we can't tune step size, band position, or the
  escalation thresholds against reality.

**Why it's a limitation.** Every other improvement in this doc is un-prioritizable
and un-verifiable without measurement. This is the meta-gap: we can't improve what
we don't measure, and right now we measure almost nothing about negotiation
quality.

**Where.** `agent/eval/` (classification only); `server/src/observability/`
(transitions only); `_NegotiateLLMOutput.confidence` (parsed, unused).

---

## 7. Conversation & channel model  *(structural)*

**Limitation.** The model of a "conversation" is thin:

- **Only the latest inbound is considered** each turn (§3). A creator who sends
  two emails in quick succession, or edits/retracts ("ignore my last, I meant
  $400"), isn't modeled — whichever arrived last wins.
- **Reply extraction is heuristic.** `extractReplyText` strips quoted threads and
  signatures with regex/heuristics and falls back to the raw body if it strips too
  much. Forwarded threads, inline/interleaved replies (creator answering
  point-by-point *inside* our quoted text), and unusual client formatting can
  defeat it — and then quoted history can leak back into the agent's reasoning.
- **Email-only.** No SMS/DM/WhatsApp/portal, no attachments comprehension (a
  creator sending a rate card PDF or media kit is opaque), no image handling.
- **Thread correlation is thread-id-only** (per `project-context`), with a known
  deferred gap around replies that don't correlate cleanly.
- **No language handling** — non-English replies aren't detected or routed.

**Why it's a limitation.** Real creator comms are multi-message, multi-channel,
attachment-heavy, and formatted every which way. The current pipe handles the
clean, single-latest-plaintext-email case well and degrades on the rest.

**Where.** `replyText.ts`; `latestCreatorInbound` (`negotiation.ts`); webhook
correlation (`routes/webhooks.ts`).

---

## 8. Deal structure & the "only fee is negotiable" constraint  *(structural)*

**Limitation.** The entire negotiation is **single-axis**: only the fixed fee
moves. Commission %, product/reward, deliverables, and timeline are hard-coded as
FIXED, enforced by both prompt and a hard output guard
(`commissionPercentsMentioned` blocks any non-configured commission %).

**Why it's a limitation.** This is a reasonable *starting* constraint, but real
deals trade across axes: "I'll take a lower fee for a longer term / more
commission / exclusivity / creative freedom / a bonus on performance." A
single-axis negotiator leaves value on the table and can't resolve the most common
real objection ("the fee's low, but I'd do it if…"). Every multi-axis ask today
either gets refused (prompt) or escalated. Expanding the negotiable surface (even
to a small set of pre-approved trades) is a product decision with real upside — and
real risk, which is why it's fixed today.

**Where.** `_LLM_NEGOTIATE_PROMPT` / `_OFFER_PROMPT` "what is FIXED" sections;
`outputGuard.ts` commission guard; `guardConstraintsFromConfig`.

**Also:** several terms creators commonly ask about — **cookie/attribution
window, usage rights, whitelisting, exclusivity** — are **not captured anywhere
in the campaign model** (per `counter-email-completeness-fix`), so the agent can
only honestly defer on them. That's correct behavior, but it means these
conversations can't be automated end-to-end until the data model carries them.

---

## 9. Safety, compliance & abuse  *(cross-cutting)*

The safety story on the *classification* path is genuinely strong (deterministic
opt-out gate, injection gate, sanitize-before-prompt, fail-safe-to-human). The
gaps are at the edges:

- **Injection defense is heuristic + prompt-delimiting.** `looks_like_injection`
  is a regex heuristic; a novel jailbreak that slips it reaches the model. The
  money guards make a *successful* intent-flip financially harmless (can't agree
  over ceiling), but copy generation is less hard-guarded — a clever payload
  aimed at the *draft* model is a softer target than the decision model.
- **Opt-out is enforced only on the classification path.** Once in active
  negotiation, the classifier is short-circuited (§4) — worth confirming an
  opt-out mid-negotiation ("actually, stop emailing me") is still honored, since
  that path skips the deterministic opt-out gate.
- **No PII handling policy.** Creator replies (and payout info) flow to the LLM
  and logs; there's sanitization for *length/control-chars* but no PII
  redaction/retention policy.
- **No compliance detection** for regulated verticals, minors, contractual/IP
  language, or platform-ToS-sensitive asks (§4).
- **Prompt-injection via the creator's own data into downstream emails** — the
  creator's name/reply is threaded into draft prompts; the guard catches
  bound/commission leaks but not arbitrary injected content in the outbound copy.

**Where.** `injection.py`; `replyDetection.ts` short-circuit; draft prompts in
`negotiate.py`; `outputGuard.ts` (bound/commission only).

---

## 10. Product, config & operability  *(structural)*

- **No per-campaign strategy/persona.** Tone, aggressiveness, concession
  schedule, and band position are largely global/prompt-baked
  (`recommendedOfferPosition` is the one knob). A luxury brand and a scrappy DTC
  brand negotiate identically.
- **Band-position default nuance.** Code defaults `recommendedOfferPosition` to
  **0.0 (open at floor)**, while `providers.ts` / templates use **0.5
  (midpoint)** — a real, documented split (`negotiate.py` vs. `providers.ts`).
  Worth confirming which the product actually wants; anchoring strategy is a core
  negotiation lever hiding in a default.
- **No A/B or experimentation harness** for prompts/strategies/step-sizes.
- **Config is code-shaped.** `maxRounds`, band, commission live in node config;
  there's no brand-facing "how hard should we negotiate" control.
- **Escalation resolution is still maturing.** Per `manual-escalation-resolution-spec`,
  the final-offer sub-state for a real B9 brand COUNTER is still pending; a
  brand's "counter" on an over-ceiling case can only HANDOFF, not re-open
  negotiation with the creator.
- **`.env` / code default mismatches** noted in `negotiation.md`
  (`AGENT_SERVICE_URL` port 8000 vs 8001; `AGENT_URL` vs `AGENT_SERVICE_URL`) —
  operational foot-guns.

---

## 11. What the system does *well* (so we don't over-correct)

To keep this balanced — these are real strengths worth preserving as we fill gaps:

- **The money decision is deterministic, bounded, and auditable.** An `if`-ladder,
  not model sampling. Reproducible, unit-testable, and impossible to push over the
  ceiling or below the floor.
- **Fail-safe-to-human is pervasive.** Ambiguity, low confidence, unreadable
  rates, agent outages, and guard hits all funnel to a human — never a silent
  guess on money.
- **Defense-in-depth on output.** Even a model that tries to leak the band is
  caught by `scanOutboundDraft` before send.
- **Clean architecture seams.** Stateless agent, worker-owns-state, queue-as-seam,
  immutable version snapshots, provider adapters. The gaps above are mostly
  *additive* — they don't require unwinding the architecture.
- **Idempotency and durability** are taken seriously (reserve-before-send, OCC,
  deterministic job ids).

The takeaway for Tuesday: the **foundation is sound**; the frontier is
**comprehension and conversation modeling** (§1–§4), and **measurement** (§6) to
know whether changes there actually help.

---

## 12. Suggested priorities for discussion

Ordered by leverage-per-effort, for debate — not a commitment:

1. **Structured comprehension** (§1.1–1.2): extract a *list* of atoms (questions,
   proposals, objections) per message + an open-questions ledger. Unlocks
   completeness-by-construction instead of completeness-by-prompt, and directly
   answers three of the five themes.
2. **Richer negotiation memory** (§3): a running structured summary (topics,
   asks, sentiment, open questions) threaded each turn — cheaper than full bodies.
3. **Measurement first** (§6): negotiation/draft evals + per-call token/latency
   metrics + outcome tracking. Nothing else is prioritizable without this.
4. **Uncertainty/risk-aware escalation** (§4): use the (currently dead)
   `confidence`, plus objection/compliance detection, to decide human-vs-auto —
   and close the mid-negotiation confidence-gate hole.
5. **Objection typing** (§1.3): even a small taxonomy (price / terms / trust /
   timing / stall) with distinct handling beats "one label → fee counter."
6. **Model tier for hard turns** (§5.3): route genuinely strategic turns to a
   stronger model while keeping the deterministic guards.
7. **(Bigger bet) Multi-axis negotiation** (§8): expand the negotiable surface —
   product decision with real upside and real risk.

---

*Generated from a first-principles review of the negotiation/agent layer.
Grounded in: `agent/app/routes/negotiate.py`, `classify.py`, `injection.py`;
`server/src/engine/executors/negotiation.ts`, `replyDetection.ts`,
`negotiationHistory.ts`, `replyText.ts`; `server/src/engine/guards/outputGuard.ts`;
`server/src/engine/{providers,band,dealDescription,campaignContext}.ts`;
`stateMachine.ts`; and the existing `negotiation.md` / `CLASSIFICATION.md` docs.*
