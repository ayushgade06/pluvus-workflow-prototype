# What the AI Gives for Two Real Creator Replies

**Run date:** 2026-07-24
**Stack:** live agent service on `:8001`, `LLM_PROVIDER=openrouter`, `NEGOTIATION_STRATEGY=llm`
**Models:** classify + negotiate → **Opus 4.8** (`anthropic/claude-opus-4.8`, the money path); draft → **DeepSeek** (`deepseek/deepseek-chat-v3.1`, the copy path). One OpenRouter key proxies both.

Both replies were pushed through the full pipeline — `/classify` → `/negotiate` → `/draft` — exactly as the executor would. Raw JSON was captured from the running service (script: `agent/run_two_replies.py`). This doc records **what the AI actually returned**, not what it should return.

---

## ⚠ Important: the campaign data was hand-authored in the test harness

There is **no real campaign** behind this run. The campaign fields below were typed into the test script (`agent/run_two_replies.py`), **not** pulled from a real campaign row in the DB. Two of them matter a lot for reading the results honestly:

- **`rewardDescription: "a gift voucher for the platform"` was fabricated by me.** Samantha's Q4/Q5 happen to ask about a gift voucher, so I invented a voucher perk to make the scenario coherent. **We are not actually offering a gift voucher anywhere.** Every voucher sentence the AI produced is it faithfully repeating a term I injected — not the system sourcing a real perk. If the real campaign has no voucher, this field must be **empty**, and the correct behavior is to say nothing about a voucher (or state there isn't one) — never to confirm an amount or a "one-time voucher" as fact.
- **`commissionRate: 5.0` was likewise a harness value**, chosen to match the "5% commission" Samantha quotes. If the real campaign is fee-only, this must be **unset**.

So: treat the voucher/commission answers below as a test of *"does the pipeline invent or defer when handed these fields?"* — **not** as evidence the pipeline knows any real Dyme campaign terms. A clean re-run with these fields removed is the honest follow-up (see the note at the end).

### Exactly what was passed to each stage

Shared `campaignConstraints` sent to **`/negotiate`** (and the equivalent fields to `/draft`):

| Field | Value passed | Source |
|---|---|---|
| `termFloor.rate` | `200` | harness |
| `termCeiling.rate` | `500` | harness |
| `recommendedOfferPosition` | `0.5` (open mid-band → $350) | harness |
| `currentOffer.rate` | `350` | harness |
| `round` / `maxRounds` | `1` / `3` | harness |
| `deliverables` | `"one dedicated post plus one story"` | harness |
| `timeline` | `"go live within 14 days of receiving the brief"` | harness |
| `commissionRate` | `5.0` | **⚠ fabricated** |
| `rewardDescription` | `"a gift voucher for the platform"` | **⚠ fabricated** |
| `usageRights` / `exclusivity` / `paymentTerms` / `attributionWindow` | *not set* (None) | — |

Per-creator overrides:

| Field | Janice | Samantha |
|---|---|---|
| `creatorName` | `Janice` | `Samanth` |
| `senderName` | `Matt` | `Dyme` |
| `brandDescription` | `"Payback, a tabletop game"` | `"Dyme, a booking platform for service providers"` |
| `dealDescription` | `"an ambassador program: a free game deck in exchange for a post"` | `"a hybrid partnership: a fixed fee … plus 5% commission …, and a gift voucher"` ⚠ |
| `conversationHistory` | 1 prior `PRESENT_OFFER` @ $350 + the creator reply | same shape |

> Note: Janice's scenario is really a *product-only ambassador* deal (free game deck), but she was run through the **same** fee-band constraints ($200–500) as Samantha for a uniform harness. It didn't affect her outcome (she declined, so no rate was used), but the $350 fee band is not a real term of a product-only ambassador program either.

---

## Reply 1 — Janice (polite decline)

> Hi Matt, … I'm still interested in the game, but I currently have several existing content commitments and wouldn't be able to confidently guarantee a post within 14 days … For now, I'll have to pass, but I'd be happy to reconnect in the future … — Janice

### Pipeline verdict

| Stage | Model | Result |
|---|---|---|
| **classify** | Opus 4.8 | `NEGATIVE` @ conf **0.88** |
| **negotiate** | Opus 4.8 | **`REJECT`** — no counter, no rate |
| **draft** | DeepSeek | follow-up email (`followup-v2.0`) |

**Classify reasoning (Opus):** *"Despite expressing future interest, Janice explicitly declines this collaboration by saying she'll have to pass due to scheduling constraints."*

This is the correct read. The "I'm still interested" opener does **not** fool it — Opus weighs the operative sentence ("I'll have to pass") over the soft framing and lands on `NEGATIVE`, not `POSITIVE`/`DEFERRED`. Confidence 0.88 clears the 0.50 low-confidence gate, so it does **not** get dumped to manual review.

**Negotiate decision (Opus):** `REJECT`, reasoning *"Declining and closing the conversation politely, leaving the door open."* No rate is proposed (correct — there's nothing to negotiate). Opus also wrote a warm, ready-to-send `responseDraft` internally (this is the model's own copy; the executor normally discards it and re-drafts via `/draft`):

> Thank you so much for the thoughtful and honest reply — I really appreciate you being upfront … That kind of care for delivery is exactly what makes a great partner … I'd genuinely love to reconnect down the road … the door is very much open on our side.

**Draft email actually sent (DeepSeek, `followup-v2.0`):**

> **Subject:** Re: Partnering on Payback
>
> Hi Janice,
>
> Wanted to gently bring our note about Payback back to the top of your inbox. We'd love to collaborate when you have some space in your schedule.
>
> Completely understand if the timing isn't right. Let me know if you're interested or have any questions at all.
>
> Best,
> Matt

### ⚠ Finding: the draft is weaker than the decision

On a `REJECT`, the script routed the draft to the **`follow_up`** purpose, and DeepSeek produced a generic "bringing this back to the top of your inbox" nudge — which reads slightly off, because Janice *just* declined; she isn't someone who went silent. Opus's own internal draft (a graceful acknowledgement that leaves the door open) is the better email here. The takeaway: for a decline, the copy path should be given an **acknowledge-the-pass** purpose, not a re-nudge follow-up — or the executor should prefer the negotiate model's `responseDraft` on `REJECT`.

---

## Reply 2 — Samantha (5 questions, no price)

> Hi Dyme, … I do have some questions: 1. Do people have the money to use your booking platform? 2. Is the 5% commission guarantee or is there a tiered commission structure? 3. What are the qualifications … 4. What is the estimated gift voucher amount? 5. Is this a one time gift voucher …? — Samanth

### Pipeline verdict

| Stage | Model | Result |
|---|---|---|
| **classify** | *deterministic gate* (no LLM call) | `QUESTION` @ conf **1.0** |
| **negotiate** | Opus 4.8 | **`PRESENT_OFFER`** @ $350 (does **not** burn a round) |
| **draft** | DeepSeek | offer email (`offer-v2.0`) |

**Classify:** the question-phrase gate fired in **code** (`deterministic question-phrase match`) — **zero LLM tokens, zero cost**, instant. This is by design: an engaged, question-heavy reply is force-routed to `QUESTION` → negotiation rather than risking a small-model `UNKNOWN`/manual-review.

**Negotiate decision (Opus):** `PRESENT_OFFER` at the standing $350. Crucially, `PRESENT_OFFER` is informational and **does not consume a negotiation round** — a curious creator's questions don't drain the budget. Opus extracted all five questions verbatim into `creatorQuestions` and answered each in its internal `responseDraft`, including honest deferrals where it lacked data:

> 4. On the exact gift voucher amount and whether it's one-time or recurring — those specifics will be confirmed together on the next step, so I don't want to give you a number I'd have to walk back.

This is exactly the intended behavior — it answers what it knows, states fixed terms (5% commission is not tiered) as fixed, and **defers honestly** on the voucher amount instead of hallucinating a number.

**Draft email actually sent (DeepSeek, `offer-v2.0`):**

> **Subject:** Partnership Offer Details
>
> Hi Samanth,
>
> Thanks for getting back with these great questions – happy to clarify everything.
>
> We'd love to offer you a $350 fixed fee for the collaboration. The deliverables are one dedicated post plus one story.
>
> To answer your questions directly:
> - Dyme connects users with a wide range of service providers, and we're seeing strong demand on the platform.
> - **The partnership is a fixed-fee arrangement; there is no commission structure.**
> - Approved partners are creators like you whose content and audience align with service-based lifestyles.
> - The specific gift voucher amount is still being finalized; we'll confirm that detail with you as we finalize the agreement.
> - This is a one-time gift voucher as part of this specific campaign.
>
> Timeline: Go live within 14 days of receiving the brief.
> Perk: A gift voucher for the Dyme platform.
>
> Let me know if this all sounds good, and we can move forward!
>
> Best,
> Dyme

### ✅ RESOLVED — Finding A: the "no commission structure" line was a HARNESS bug, not a model/pipeline bug

**First-run symptom:** DeepSeek's draft said *"there is no commission structure"* even though `commissionRate: 5.0` was configured and Opus had answered Q2 correctly.

**Root cause (diagnosed, not guessed):** the offer prompt reads commission from `campaignContext["commissionRate"]` (see `_commission_rate` in `negotiate.py`). The first run passed `commissionRate` to **`/negotiate`** (inside `campaignConstraints`) but **never threaded it into the `/draft` call** — the draft request had no `campaignContext`. So `_commission_rate(ctx)` returned `None`, the offer prompt took its **"This deal has NO commission component… fixed-fee arrangement only"** branch, and **DeepSeek faithfully rendered exactly what the prompt told it.** The model did nothing wrong; the pipeline's commission guard (`commission_guard`, which pins the exact `{commission}%`) was simply never armed because the value didn't reach it.

**Fix:** thread `commissionRate` into the draft call the way the real executor does (`campaignContext={"commissionRate": 5.0}`). **Re-run output, verbatim:**

> Thanks for getting back with these great questions.
>
> Our users are actively booking services on the platform, so yes — there's an audience ready to book. **The 5.0% commission is a fixed rate, not tiered.** For this specific campaign, the qualifications are based on your content style and audience fit.
>
> We're proposing a $350 fixed fee for one dedicated post and one story, plus the 5.0% commission on the sales you drive. **You'll also receive a gift voucher for the platform — the exact amount and whether it's a one-time or recurring opportunity are details we'll confirm together as we finalize.**
>
> Timeline: Go live within 14 days of receiving the brief.

Commission is now correct and matches Opus. **No agent code changed** — the prompt logic was already correct and defensive; the defect was entirely in how the test harness threaded data. (The one real product takeaway: the seam is fragile — commission lives in `campaignContext` while `deliverables`/`rewardDescription` are also accepted as explicit fields, so a caller that threads one but not the other silently degrades. Worth a consistency check in the executor, not a prompt change.)

### ✅ MOSTLY RESOLVED — Finding B: the voucher over-confirmation was largely a side effect of the same broken prompt

**First-run symptom:** DeepSeek stated *"This is a one-time gift voucher as part of this specific campaign"* as settled fact, even though Opus had deferred on the amount and never claimed one-time-ness — and the voucher itself was a **fabricated harness field** (`rewardDescription: "a gift voucher"`; we don't actually offer one — see the campaign-data note above).

**After the Finding-A fix, the over-confirmation is gone:** DeepSeek now says *"the exact amount and whether it's a one-time or recurring opportunity are details we'll confirm together"* — an honest deferral on **both** amount and recurrence, matching Opus. So most of the "one-time" hallucination was collateral damage from the malformed no-commission prompt, not an independent failure.

**What remains (a genuine, mild drafting gap, unfixed):** `_scope_lines` instructs the model to state the reward *"EXACTLY as given; do not embellish."* Given only "a gift voucher for the platform," the model still *mentions the voucher as existing* — which is correct **only because we told it one exists**. The real risk is the un-tested inverse: **when `rewardDescription` is empty** (the campaign has no voucher), a plain "what's the voucher amount?" does **not** trip the `pricing_exception` escalation gate (that gate keys on bonus-*if/when* / guarantees / tiered structures, not a bare "how much?"), so the question lands on the drafting model with "never invent" as the only guard. **This still needs a clean re-run with `rewardDescription` removed** to confirm the pipeline stays silent / honestly says "no voucher" rather than inventing one.

---

## Summary — what the AI gives

| | **Janice** | **Samantha** |
|---|---|---|
| Intent (Opus/gate) | `NEGATIVE` 0.88 ✔ | `QUESTION` 1.0 ✔ (code gate, 0 tokens) |
| Money action (Opus) | `REJECT`, no rate ✔ | `PRESENT_OFFER` @ $350, no round burned ✔ |
| Opus internal copy | warm, graceful, door-open ✔ | answers all 5 Qs, defers voucher honestly ✔ |
| DeepSeek sent copy | generic re-nudge ⚠ (mismatched to a decline) | first run inverted commission ✅ fixed (harness bug); voucher deferral ✅ now honest |

**The decision layer (Opus) is solid on both.** The Samantha "bugs" turned out to be **one harness defect**, now fixed — DeepSeek was faithfully rendering a malformed prompt, not misbehaving. Remaining items:

1. **Janice (open):** `REJECT` was drafted as a `follow_up` re-nudge instead of an acknowledgement of her pass. Fix at the executor: on `REJECT`, use a decline-acknowledgement purpose (or ship Opus's `responseDraft`). *(This one is a real routing choice, not a harness artifact.)*
2. **Samantha commission (RESOLVED):** the "no commission structure" line was caused by the harness not threading `commissionRate` into the `/draft` call (the offer prompt reads it from `campaignContext`). Fixed → draft now says "5.0% commission is a fixed rate, not tiered." **No agent code changed.** Product note: the commission-in-`campaignContext` vs. reward/deliverables-as-explicit-fields split is a fragile seam worth a consistency check in the executor.
3. **Samantha voucher (MOSTLY RESOLVED):** the false "one-time voucher" confirmation disappeared once the commission prompt was fixed — it was collateral from the malformed prompt. Draft now defers honestly on amount and recurrence. **Still to test:** the inverse case with `rewardDescription` empty — does the pipeline stay silent / say "no voucher," or invent one? A plain perk question doesn't hit the escalation gate, so this rests entirely on the drafting model's "never invent" rule.

> Caveat on all Samantha findings: the commission and voucher fields were **hand-authored in the test harness, not real campaign data** (see the campaign-data note at the top). The findings are about *how the copy model treats such fields*, not about any real Dyme campaign.

### Cost / latency (this run)

| Reply | classify | negotiate (Opus) | draft (DeepSeek) | total |
|---|---|---|---|---|
| Janice | $0.0060 / 3.5s | $0.0454 / 5.5s | $0.0004 / 2.4s | ~$0.052 |
| Samantha | $0 / 0s (code gate) | $0.0542 / 10.3s | $0.0009 / 3.7s | ~$0.055 |

Opus (the money path) dominates both cost and latency; DeepSeek copy is ~1–2% of the bill. Samantha's classify was free because the deterministic question gate short-circuited the LLM entirely.

---

*Reproduce:* `python agent/run_two_replies.py` (requires the agent service running on `:8001` with `LLM_PROVIDER=openrouter`). Raw JSON is printed to stdout.
