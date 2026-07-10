# Manual Escalation — Cases & Example Brand Replies

A field guide to **every** way a workflow run can escalate, whether the brand
manager can resolve it **by email / one‑click link**, and — for the ones they
can — the **exact reply** to send.

> This mirrors the implemented behavior in `server/src/engine/executors/brandDecision.ts`,
> `brandDecisionParse.ts`, and `notifications/brandDecisionEmail.ts`. It is the
> companion to the design spec `MANUAL_ESCALATION_RESOLUTION.md`.

---

## 0. TL;DR — the four reply cues

For any escalation email that is **resolvable by reply**, the brand answers with
one of these (case‑insensitive; a matched cue wins instantly, no AI needed):

| Cue | What it does | Accepted synonyms (any of these work) |
|---|---|---|
| **`APPROVE`** | Accept the creator's number / say yes | `APPROVE`, `APPROVED`, `ACCEPT`, `AGREE`, `YES`, `OK`, `GO AHEAD`, `SOUNDS GOOD` |
| **`REJECT`** | Pass / decline the deal | `REJECT`, `DECLINE`, `PASS`, `NO DEAL`, `WALK AWAY` |
| **`COUNTER <amount>`** | Name one **final** number (e.g. `COUNTER 350`) | must include a number, e.g. `COUNTER 350`, `counter at $1,200` |
| **`HANDOFF`** | Send it to a human on your team | `HANDOFF`, `HUMAN`, `CALL ME`, `DASHBOARD`, `TAKE OVER` |

Every resolvable email **also** carries one‑click links, so the manager can just
click **Approve / Reject / Counter / Hand off** instead of typing.

**If we can't understand the reply**, we ask **once** more. If the second reply
is still unclear, the run moves to the dashboard **Manual Queue** for a person.
If nobody replies at all, after **72 hours** it moves to the Manual Queue
automatically and the operator is pinged.

---

## 1. Quick reference — all 10 buckets

| # | Case | Reason code | Brand can resolve by email? | Reply with |
|---|---|---|---|---|
| A1/A2 | Creator's reply couldn't be classified | `low_confidence_reply` | ✅ Yes | `APPROVE` / `REJECT` / `COUNTER <n>` / `HANDOFF` |
| B9/B11 | Negotiation hit the max rounds | `max_rounds_reached` | ✅ Yes | `APPROVE` / `COUNTER <n>` (final) / `REJECT` / `HANDOFF` |
| B10 | Creator's rate is above our ceiling | `escalated` | ✅ Yes | `APPROVE` / `REJECT` / `HANDOFF` (no counter) |
| B10* | Creator's rate was unreadable | `escalated` | ✅ Yes | `COUNTER <n>` (tell us their number) / `HANDOFF` |
| D23/24/25 | Missing brand name for emails | `missing_brand_name` | 🟡 Config fix | Reply with **the brand name** (free text) / `HANDOFF` |
| B12 | Negotiation draft leaked a budget bound | `output_guard_blocked` | ❌ No (safety) | — dashboard only — |
| B13 | AI couldn't write the draft after retries | `draft_generation_failed` | ❌ No | — dashboard only — |
| C21 | Outreach draft leaked a budget bound | `output_guard_blocked` | ❌ No (safety) | — dashboard only — |
| C22 | Follow‑up draft leaked a budget bound | `output_guard_blocked` | ❌ No (safety) | — dashboard only — |
| E26 | Reward‑confirmation draft leaked a bound | `output_guard_blocked` | ❌ No (safety) | — dashboard only — |

**8 of 10 buckets are self‑serve.** The 2 draft‑leak buckets stay dashboard‑only
because a one‑word "approve" must never wave through an email that leaks internal
budget numbers.

---

## 2. Resolvable cases — full examples

Each block shows: **what happened → the email the brand receives → every valid
reply and what it triggers.**

---

### CASE A1 / A2 — "We couldn't read the creator's reply"

**Reason code:** `low_confidence_reply`
**Why:** the classifier wasn't confident what the creator meant (odd phrasing,
a mixed message, or the AI was degraded). This is a judgment call a human makes
instantly.

**Email the brand receives:**

> **Subject:** Decision needed: Jordan Lee — Summer Running Campaign
>
> Hi Acme Athletics team,
>
> We need a quick decision on Jordan Lee (@jordanruns) before the workflow can continue.
> Campaign: Summer Running Campaign
>
> We couldn't tell how Jordan Lee meant this reply. How should we read it?
>
> What they wrote:
> > yeah maybe, depends what you had in mind tbh — hit me back
>
> ── How to respond ─────────────────────────────────────────
> Option 1 — just reply to this email with one of:
>   • Reply "APPROVE"  →  Approve
>   • Reply "REJECT"  →  Reject / pass
>   • Reply "COUNTER <amount>   (e.g. COUNTER 350)"  →  Make a counter‑offer
>   • Reply "HANDOFF"  →  Hand off to a human
>
> Option 2 — click a one‑click action link: [Approve] [Reject] [Counter] [Hand off]

**Valid brand replies:**

| Reply | Result |
|---|---|
| `APPROVE` | Treat the creator as interested → **resume negotiation**. |
| `They seem interested, let's talk` | Same — the AI fallback reads this as APPROVE. |
| `REJECT` | Creator isn't interested → **deal closed (rejected)**. |
| `COUNTER 400` | Treat the creator as having proposed **$400** and negotiate from there. |
| `HANDOFF` | Send to a human in the dashboard. |

**Example — approve:**
> `APPROVE — they're clearly keen, keep going.`

**Example — reject:**
> `PASS on this one, not a fit.`

---

### CASE B9 / B11 — "Negotiation ran out of rounds"

**Reason code:** `max_rounds_reached`
**Why:** the back‑and‑forth hit the maximum number of rounds without agreement.
The brand gets **one** final move.

> ⚠️ **A counter here is FINAL.** Whatever number you name is take‑it‑or‑leave‑it
> for the creator — we won't negotiate any further.

**Email the brand receives:**

> **Subject:** Decision needed: Priya Nair — Q3 Skincare Push
>
> Hi Nimbus Beauty team,
>
> We need a quick decision on Priya Nair (@priyaglow) before the workflow can continue.
>
> Negotiation with Priya Nair reached the max of 5 rounds without agreement. Their
> latest ask is 900 (your ceiling was 800, floor 500). Do you want to accept their
> number, or name one final counter? Any number you give is final — we won't
> negotiate further; the creator can only take it or leave it.
>
> What they wrote:
> > I can do the 3 reels but 900 is my floor, sorry.
>
> ── How to respond ─────────────────────────────────────────
>   • Reply "APPROVE" → accept their $900
>   • Reply "COUNTER <amount>" → one final offer (e.g. COUNTER 800)
>   • Reply "REJECT" → pass
>   • Reply "HANDOFF" → hand to a human

**Valid brand replies:**

| Reply | Result |
|---|---|
| `APPROVE` | Accept the creator's **$900** → moves to the agreement/reward step. |
| `COUNTER 800` | Send the creator a **final** $800 offer (they may only accept or reject). |
| `REJECT` | Pass → deal closed. |
| `HANDOFF` | Send to a human. |

**Example — approve their number:**
> `APPROVE`

**Example — one final counter:**
> `COUNTER 800 — that's the most we can do, final.`

> **Note (current build):** a brand `COUNTER` on this case is recorded and routed
> to the Manual Queue for a human to send as the final offer — the automated
> "final‑offer to creator" step is a planned follow‑up. `APPROVE` / `REJECT` /
> `HANDOFF` resolve fully automatically.

---

### CASE B10 — "The creator wants more than our ceiling"

**Reason code:** `escalated`
**Why:** the creator's rate is above the internal ceiling. Before paging the
brand, the workflow **already tried once** to close at the recommended
mid‑band price and the creator held firm. Now it's purely the brand's call to
overspend or walk — **approve or reject only, no counter.**

**Email the brand receives:**

> **Subject:** Decision needed: Marcus Webb — Holiday Gadget Launch
>
> Hi Volt Electronics team,
>
> Marcus Webb won't go below **1,200**, which is above both our ceiling (1,000)
> and the recommended price (750) we already offered. This is now approve‑or‑reject
> only — we won't negotiate further. Approve at 1,200, or pass?
>
> ── How to respond ─────────────────────────────────────────
>   • Reply "APPROVE" → pay the $1,200
>   • Reply "REJECT" → pass
>   • Reply "HANDOFF" → hand to a human

**Valid brand replies:**

| Reply | Result |
|---|---|
| `APPROVE` | Accept at the creator's **$1,200** (recorded as an over‑ceiling approval for audit). |
| `REJECT` | Pass → deal closed. |
| `HANDOFF` | Send to a human. |
| `COUNTER 1000` | ⚠️ Not offered here. We re‑ask once ("approve or reject only"), then send to the Manual Queue. |

**Example — approve the overspend:**
> `APPROVE — Marcus is worth it for this launch.`

**Example — walk away:**
> `REJECT, over budget.`

---

### CASE B10* — "We couldn't read a number from the creator"

**Reason code:** `escalated` (unreadable rate sub‑case)
**Why:** the creator replied but we couldn't parse a clear rate, so we can't tell
whether it's over the ceiling. We ask the brand what number the creator is
proposing.

**Email the brand receives:**

> **Subject:** Decision needed: Aisha Khan — Fitness Apparel Drop
>
> Aisha Khan replied but we couldn't read a clear rate from:
> > "depends on usage rights and whether it's exclusive, ballpark low‑to‑mid four figures"
>
> What number are they proposing?
>
> ── How to respond ─────────────────────────────────────────
>   • Reply "COUNTER <amount>" with their number (e.g. COUNTER 3000)
>   • Reply "HANDOFF" → hand to a human

**Valid brand replies:**

| Reply | Result |
|---|---|
| `COUNTER 3000` | We treat $3,000 as the creator's ask and run it through the normal over/under‑ceiling logic. |
| `HANDOFF` | Send to a human. |

**Example:**
> `COUNTER 3000 — that's what "low‑to‑mid four figures" means for us.`

---

### CASE D23 / D24 / D25 — "What brand name should we sign as?"

**Reason code:** `missing_brand_name`
**Why:** we're about to email the creator (reward confirmation / payout request /
content brief) but there's no brand name on file — so we paused rather than send
something addressed from *"your brand."* This is a **config fix**, not an
approve/reject: the reply **is the brand name**.

**Email the brand receives:**

> **Subject:** Quick question: your brand name — Autumn Denim Campaign
>
> Hi your brand team,
>
> We're about to email Sofia Ramos (@sofiastyle) on your behalf, but we don't
> have a brand name to sign as — so the workflow has paused rather than send
> something addressed from "your brand".
>
> What brand name should we use in emails to Sofia Ramos (and other creators in
> this campaign)?
>
> ── How to respond ─────────────────────────────────────────
> Just reply to this email with the brand name to use (e.g. "Acme Co.").
> We'll save it and continue automatically — no dashboard needed.
>
> If you'd rather a human handle this, reply "HANDOFF" or click: [Hand off]

**Valid brand replies:**

| Reply | Result |
|---|---|
| `Acme Athletics` | Saved as the campaign's brand name; the paused node **re‑runs automatically** and the email goes out. |
| `It's Nimbus Beauty. Thanks!` | Cleaned to **"Nimbus Beauty"** (leading "it's" and trailing sign‑off stripped) and saved. |
| `The brand name is Peak Gear` | Cleaned to **"Peak Gear"** and saved. |
| `HANDOFF` | Send to a human instead. |
| *(a blank / nonsense reply)* | We ask once more; if still unusable, it goes to the Manual Queue. |

**Example:**
> `It's Meridian Coffee Co.`

> The name is written back to the campaign, so it's fixed for **every** creator
> in that campaign, not just this one.

---

## 3. NON‑resolvable cases — dashboard only

These **never** accept an email reply. Replying `APPROVE` does nothing useful —
the run must be handled by a person in the **Manual Queue** tab of the dashboard.

---

### CASE B12 / C21 / C22 / E26 — "A draft leaked an internal budget bound"

**Reason code:** `output_guard_blocked`
**Why:** an AI‑written email (negotiation counter, outreach, follow‑up, or reward
confirmation) contained an internal floor/ceiling or a secret term. The safety
guard blocked it **before** sending. We must not let a one‑word "approve" wave a
leaking email through — that defeats the guard entirely.

**What the brand sees:** the standard *"open the Manual Queue"* notice (not an
actionable decision email).

**What to do:** open the dashboard, review the blocked draft, edit out the leak,
and send the corrected version. **No reply resolves this.**

| # | Where it happened |
|---|---|
| B12 | A negotiation counter draft |
| C21 | An initial outreach draft |
| C22 | A follow‑up draft |
| E26 | A reward‑confirmation draft |

---

### CASE B13 — "The AI couldn't write the email"

**Reason code:** `draft_generation_failed`
**Why:** the copy generator failed after retries, so there's simply **no email to
send** — there's no *decision* for the brand to make. Email resolution doesn't
apply.

**What to do:** in the dashboard, regenerate the draft or write the copy manually.

---

## 4. Fallbacks — what happens if the brand doesn't answer cleanly

| Situation | What the system does |
|---|---|
| Reply matches a cue (`APPROVE`, etc.) | Resolves immediately, no AI. |
| Reply is free text but clear ("yes, go ahead") | AI fallback maps it to a decision. |
| Reply is unclear (first time) | We send **one** clarification email and wait. |
| Reply is unclear (second time) | Moves to the **Manual Queue** for a human. |
| Reply looks like a prompt‑injection | Never auto‑approved — forces a re‑ask + warning. |
| No reply at all for **72 hours** | Auto‑moves to the **Manual Queue** + operator is pinged. |
| Brand replies `HANDOFF` on any case | Moves to the **Manual Queue** for a human. |

---

## 5. Cheat sheet for brand managers

- **See a decision email?** Reply with **one word/line**: `APPROVE`, `REJECT`,
  `COUNTER 350`, or `HANDOFF` — or click a button. That's it.
- **Asked for your brand name?** Just reply with the name (e.g. `Acme Co.`).
- **A counter on a "max rounds" deal is final** — pick your number carefully.
- **An over‑ceiling deal is approve‑or‑reject only** — no counter.
- **Don't ignore it** — after 72 hours it lands in the dashboard queue anyway,
  but a quick reply keeps the creator moving.
- **Draft‑leak / can't‑generate cases** won't email you a decision — those live
  in the dashboard Manual Queue by design.
