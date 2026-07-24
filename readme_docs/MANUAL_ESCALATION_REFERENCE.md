# Manual Escalation & Operator Handoff — When the AI Hands a Reply to a Human

**What this documents:** every reason a creator's reply stops the automated
conversation and lands in the **Manual Queue** for a person — and, just as
importantly, where the AI is *allowed* to keep going on its own.

**The mode we run:** **operator handoff.** The proto negotiates, and the moment a
deal is agreed it hands the creator to a human in main Pluvus. We do **not**
collect payment info, run a payout form, or gather content links in the proto.
That whole back half of the old flow is out of scope here — see §5.

**Why this doc exists:** the goal is to *shrink* the Manual Queue. Every item in
it is a conversation the AI couldn't finish on its own. We want the AI to safely
handle the **majority** of replies and route only the genuinely human calls to a
person. This doc is the map of what escalates today so we can decide what the AI
should be trusted to handle instead.

---

## The two things in the queue

The Manual Queue holds two kinds of item — they look similar but mean opposite
things:

| Kind | State | Meaning |
|---|---|---|
| **Escalation** | `MANUAL_REVIEW` | The AI **couldn't safely proceed** and handed off. This is what we want to reduce. |
| **Handoff** | `NEEDS_DEAL_FINALIZATION` | The AI **succeeded** — a deal closed — and a human onboards the creator. This is the *goal*, not a failure. |

> A `MANUAL_REVIEW` item is "the AI got stuck." A `NEEDS_DEAL_FINALIZATION` item
> is "the AI closed a deal, now a human takes it from here." Only the first kind
> is a problem to solve.

Everything in §1–§4 is the escalation kind. §5 is the success handoff.

---

## How a reply flows (and where it can escalate)

A creator reply passes through a short pipeline. **The AI drafts a response at the
negotiate step, but that draft still has to clear a set of deterministic guardrails
before it's sent.** If it clears them, the reply is refined and sent. If it trips
one, the reply is diverted to the Manual Queue instead.

```
Creator reply
   │
   ├─ 1. Can we read it?          → if not confident: MANUAL_REVIEW
   │
   ├─ 2. Is it a "human-only"     → if yes (a demand on a blocked topic): MANUAL_REVIEW
   │       topic?                    (a plain question on some of these is answered, not escalated)
   │
   ├─ 3. /negotiate: AI decides   → accept / counter / reject  (the AI *does* respond here)
   │       the move + drafts copy
   │
   └─ 4. Guardrails before /draft → refined & sent, OR diverted to MANUAL_REVIEW
           (money bounds + output guard)
```

The key thing to internalise: **the AI always forms a response at step 3.**
Steps 2 and 4 are the deterministic rails that either let that response through
(refined) or pull it into the queue. Loosening escalation is mostly about
widening those rails — letting the AI's response through in more cases.

---

## 1. "The AI couldn't read the reply confidently"

This is the **single biggest** source of queue items — and often the easiest to
improve, because many of these are replies the AI *could* have handled with a
clearer read.

- **Trigger:** the classifier can't confidently tell what the creator meant — it
  returns `UNKNOWN`, or its confidence is below the threshold, or (fail-safe) its
  output was malformed, or the AI service was briefly unreachable.
- **Result:** the reply is parked as `low_confidence_reply` rather than guessed at.
- **Operator read:** the creator didn't do anything wrong — the AI just wasn't
  sure. These are prime candidates for "should the AI have handled this?"

> **Improvement lens:** every `low_confidence_reply` is worth reviewing. If the
> reply was actually clear to a human, the classifier was too cautious and we can
> tune it to let more through.

---

## 2. The deterministic "hard escalation" rules

These are the **always-escalate rules**. They are plain, deterministic code —
**not** the AI's judgment — and they run *before* the AI's confidence even
matters. A reply that trips one of these categories goes to a human no matter how
sure the model is, because these are commitments the AI has no authority to make.

This is the list we most want your input on: **which should stay human-only, and
which can the AI safely answer?**

| # | Category | Escalates on (examples) | Can the AI handle a plain *question*? |
|---|---|---|---|
| 1 | **Legal / contract** | "amend the contract", "our lawyer", "add an NDA", indemnification, jurisdiction | No — always human today |
| 2 | **Dispute / hostile** | "never got paid", "breach", "refund", "scam", lawsuit threats, hostility | No — always human today |
| 3 | **Pricing exceptions** | performance/tiered/CPA deals, guarantees, bonuses, equity/rev-share, **demand to change the commission %** | **Partly** — a plain "what's the commission?" is answered; a *change* escalates |
| 4 | **Usage rights / licensing** | usage/content rights, exclusivity, licensing, perpetual use, whitelisting, "who owns the content" | **Partly** — a plain "is there exclusivity?" is answered from campaign config; a *demand* escalates |
| 5 | **Undefined campaign terms** | "what exactly are the full contract terms", rights/exclusivity we never specified | No — always human today |

### The one nuance that already reduces escalations: question vs. demand

For the two "partly" rows above (**pricing** and **usage rights**), the rule is
already smart about *intent*:

- A **plain question** does **not** escalate. "What are the usage rights?" or
  "Is there exclusivity?" flows into negotiation, where the AI answers it from the
  campaign's configured fields (or honestly says it'll check).
- A **demand or ultimatum** on the same topic **does** escalate. "I *require*
  full usage rights" or "remove the exclusivity clause or no deal" goes to a human.

The other three categories (legal, dispute, undefined terms) escalate **regardless
of phrasing** today — even a polite question routes to a person.

### Multi-part replies don't over-escalate

A reply that mixes an answerable question with a sensitive one no longer sends the
*whole* thing to a human. "Love it! What's the fee, when do I get paid, **and I
need an NDA**?" — the AI answers the fee and timing, and only the NDA part is
surfaced to the human. This is already a big reduction; the improvement question
is whether we can extend the same "answer what you can" logic further.

> **This is the section to review together.** Categories 1, 2, and 5 are currently
> all-or-nothing human routes. The proposal is to give some of them the same
> question-vs-demand treatment that 3 and 4 already have — so a creator *asking*
> about terms gets an answer, and only a creator *demanding* a change gets a human.

---

## 3. Money guardrails (the AI responds, but stays inside the band)

At the negotiate step the AI **does** decide the move and draft the reply — but
it's bounded by the campaign's money settings. It escalates only when it can't
close safely:

- **Creator asks above the ceiling** → the AI can't agree to a rate over budget,
  so it hands off. (Anything at or below the ceiling, it negotiates on its own.)
- **No ceiling configured** → without a maximum, the guard can't protect the
  budget, so we refuse to auto-negotiate unbounded and ask for a ceiling.
- **AI service unreachable mid-negotiation** → a money decision is never guessed;
  it escalates instead.

> **Not an escalation:** if the negotiation simply runs out of rounds with no
> agreement, the conversation **auto-closes politely** (a courteous "we couldn't
> align this time" email) — it does **not** go to the queue.

---

## 4. The output guard (a last check before the email sends)

Even after the AI writes a good reply, one final deterministic check scans the
**rendered email** before it goes out, and blocks it if it would leak something it
shouldn't:

- the internal **floor** or **ceiling** price,
- a **dollar amount** that isn't the rate we're presenting or the creator's own
  stated number,
- a configured **internal term**,
- a **commission %** that doesn't match the brand's configured rate.

If the email is clean, it sends. If it isn't, the turn is pulled into the queue so
a human can send a corrected reply. This is a safety net against the AI
accidentally revealing an internal number — not a judgment call — so it should
fire rarely.

---

## 5. `NEEDS_DEAL_FINALIZATION` — the success handoff (operator mode)

This is **not** an escalation. It's the designed finish line for operator-handoff
mode, and it's what a healthy conversation ends in.

When the AI closes a deal:

1. it snapshots the agreed terms,
2. emails the creator a short "looping in our campaign manager" note (CC'ing the
   operator when the campaign has one),
3. parks in **`NEEDS_DEAL_FINALIZATION`** with the agreed compensation shown and a
   "mark completed" button.

A human then onboards the creator in main Pluvus. **The proto collects no payment
info, runs no payout form, and gathers no content links** — that entire back half
lives on the Pluvus side now, and the state machine explicitly prevents a
handed-off deal from re-entering those old flows.

> So the "good" outcome of every conversation is a `handoff` item, not an
> `escalation` item. Success = the deal reached this state on its own.

---

## Summary — what escalates, and what we want to change

| Category | Trigger | Escalates today? | Can the AI take more? |
|---|---|---|---|
| Couldn't read reply | UNKNOWN / low confidence | Yes | **Yes** — tune the classifier; review these first |
| Legal / contract | any mention | Yes, always | Candidate: answer plain questions, escalate demands |
| Dispute / hostile | any mention | Yes, always | Keep human (recommended) |
| Pricing exception | custom structures / commission-change | Demands only | Already split — plain commission Q answered |
| Usage rights / licensing | rights / exclusivity / licensing | Demands only | Already split — plain Q answered from config |
| Undefined terms | asks about unspecified terms | Yes, always | Candidate: answer from config where we can |
| Over-ceiling ask | creator wants more than budget | Yes | Keep — this is the money guard |
| No ceiling set | campaign has no max | Yes | Fix the config, not the AI |
| Output guard | draft leaks a bound / internal number | Yes | Keep — safety net |
| **Deal agreed (handoff)** | **AI closed the deal** | **No — success** | **This is the goal** |

**The direction we're pushing:** move as many rows as safely possible from "always
human" toward "AI answers the question, human only on a real demand" — starting
with the low-confidence bucket and the always-escalate topic categories (1, 2, 5).
The money guard and output guard stay strict; those protect the budget and internal
numbers, not conversation quality.
