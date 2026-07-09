# RUN PLAN — 50 fixes in 5 sequential batches of 10

Read [`PRINCIPLES.md`](./PRINCIPLES.md) and [`README.md`](./README.md) first.

**How this is ordered:** independent, foundational work is earlier; dependent work is later. A batch may
be started only after the batch before it is merged, because later batches edit files or rely on behavior
the earlier batches create. **Within a batch**, items are grouped into parallel lanes; items sharing a file
are marked to run sequentially (one owner per file — see the collision notes).

**Count:** 50 active fixes (CRITICAL-5 removed as parent-system scope). Tags keep their original IDs for
stable cross-reference even though they're regrouped here by dependency, not by severity.

Legend: ‖ = run in parallel · → = must follow · ⚠ = watch-out.

---

## BATCH 1 — Foundation & independent safety nets (do first)
*The decision-seam foundation everything negotiation-related depends on, plus fully-independent items that
touch no shared files. Nothing here depends on anything else.*

| # | ID | Fix | File(s) | Notes |
|---|----|-----|---------|-------|
| 1 | **HARD-N1** | Decision seam: LLM decides, code guards, ALWAYS re-draft after guards | `agent/app/routes/negotiate.py` | **The foundation.** Load-bearing for 2, 3, and Batch 2's prompt work. Read PRINCIPLES.md. |
| 2 | **MED-L1** | Make `llm` the default; widen fallback catch to any model failure | `agent/app/routes/negotiate.py`, `agent/app/llm.py` | → after/with HARD-N1 (same seam, same file). Do in the **negotiate.py owner** pass. |
| 3 | **HARD-T2** | Prompt versioning (`PROMPT_VERSION` stamp) | `agent/app/routes/negotiate.py` | Prereq for HARD-P2 & HARD-T1. Same-file → negotiate.py owner pass. |
| 4 | **HARD-A1** | Split process topology (API / workers / scheduler) | bootstrap, docker-compose | Prereq for HARD-S1. Independent of the agent service. ‖ |
| 5 | **HARD-A2** | Collapse dual funnel + de-dup helpers/ladders | `runtime.ts`, workers, executors | Big/mechanical, independent. ‖ |
| 6 | **MED-A2** | Generate mock classifier from a shared spec | `MockClassificationProvider.ts` | Independent. ‖ |
| 7 | **MED-S3** | `%PDF-` magic-byte validation on /uploads | `routes/uploads.ts` | Independent. ‖ |
| 8 | **EASY-S3** | Delete `diagGrant` | `diagGrant.ts` | Independent (deletion). ‖ |
| 9 | **MED-L2** | Fix timeout model + thread-pool saturation; raise `num_predict` | `agent/app/structured.py`, `agent/app/llm.py` | ‖, but ⚠ shares `structured.py`/`llm.py` with EASY-S1 (Batch 4) & item 2 → sequence within the agent-infra owner. |
| 10 | **MED-L3** | Real determinism (seed/JSON mode/top_p) or drop the claim | `agent/app/llm.py` | ‖, shares `llm.py` → agent-infra owner pass. |

⚠ **negotiate.py owner (items 1, 2, 3):** one person/agent owns `negotiate.py` for this batch — do HARD-N1,
then MED-L1, then HARD-T2 in one pass. Don't run them as 3 concurrent agents.

---

## BATCH 2 — Prompt rearchitecture & negotiation behavior (needs the seam)
*Depends on Batch 1's HARD-N1 (draft-after-guards) and HARD-T2 (prompt versioning). Most of these live in
`negotiate.py` prompts, so they run as one owned sequence; the non-negotiate.py items parallelize.*

| # | ID | Fix | File(s) | Notes |
|---|----|-----|---------|-------|
| 11 | **HARD-P1** | Rearchitect `_NEGOTIATE_PROMPT` into a pure extraction module | `negotiate.py` prompts/schemas | → after HARD-N1 (relies on always-draft-after-guards). ⚠ **makes EASY-P2 obsolete.** |
| 12 | **HARD-P2** | "Defer honestly on unknowns" clause + few-shots | `negotiate.py` prompts | → after HARD-T2. negotiate.py owner. |
| 13 | **CRITICAL-4** | Final-round false acceptance → escalate over-ceiling; re-draft | `negotiate.py` (`_apply_decision_guards`) | → after HARD-N1 (passes creator-ask into guard). negotiate.py owner. |
| 14 | **HARD-N3** | Fix $0 opening-offer anchoring | `negotiate.py`, `templates/index.ts`, `negotiation.md` | ‖ (templates side independent of prompt bodies). |
| 15 | **EASY-P1** | Fix `ceiling=inf` "$no fixed cap" | `negotiate.py:864` | negotiate.py owner batch. |
| 16 | **EASY-P3** | Fix incoherent missing-rate fallback strings | `negotiate.py:1530,1591` | negotiate.py owner batch. |
| 17 | **EASY-P4** | Fix `_build_offer_prompt` numbered-point gaps / fabricated premise | `negotiate.py:1629-1738` | negotiate.py owner batch. |
| 18 | **EASY-P5** | Parameterize currency in `_format_rate` | `negotiate.py:1258` | negotiate.py owner batch. |
| 19 | **EASY-P6** | Narrow `_scrub_brand` placeholder regex | `negotiate.py:1938-1963` | negotiate.py owner batch. |
| 20 | **EASY-D1** | Update stale docs (anchor default, Phase-2 comment) | `negotiate.py:144-146`, `negotiation.md` | negotiate.py owner batch. |

⚠ **negotiate.py owner (11,12,13,15,16,17,18,19,20):** these all touch `negotiate.py` in different
functions — one owner, one sequential pass. **Skip EASY-P2 entirely** (HARD-P1 removes the `confidence`
field it targets). HARD-N3's `templates/index.ts` edit can be a separate parallel lane.

---

## BATCH 3 — Critical correctness: identity, routing, money trail, lost replies
*The remaining Criticals. Kept after the seam so re-drafting exists (CRITICAL-3's fee flows through the
guarded decision). These touch server-side executors/workers, mostly disjoint from Batch 2's agent files.*

| # | ID | Fix | File(s) | Notes |
|---|----|-----|---------|-------|
| 21 | **CRITICAL-2** | Persist brand-decision emails as Message rows (so brand replies route) | `brandDecision.ts`, `escalation.ts`, `IEmailProvider`, Message schema | **Do before CRITICAL-1** — routing must exist to verify identity. |
| 22 | **CRITICAL-1** | Sender-identity check on brand decisions (creator can't self-approve) | `webhooks.ts`, `inboundEmailWorker.ts`, `brandDecision.ts` | → after 21. ⚠ shares `brandDecision.ts` with 21 & 23 → **brandDecision.ts owner sequence.** |
| 23 | **CRITICAL-3** | Emit `outcome/rate` on APPROVE; `resolveAgreedFee` hard-fails not ceiling | `brandDecision.ts`, `negotiationHistory.ts`, `agreedFee.ts` | brandDecision.ts owner sequence (after 22). |
| 24 | **CRITICAL-6** | Inbound replies silently lost (lock-busy throw, persisted≠processed, buffer) | `inboundEmailWorker.ts`, `runtime.ts`, `stateMachine.ts` | ⚠ interacts with HARD-R2 (item 25) — pair them. |
| 25 | **HARD-R2** | Make the Redis lock sound (fencing token, TTL, owned release) | `scheduler/lock.ts` + call sites | ‖ with 24 conceptually; pair, same owner as 24. |
| 26 | **HARD-R1** | Reconciliation sweep (all non-terminal states) + transactional outbox | `poller.ts`, `db/instances.ts`, new outbox table | Independent; makes EASY-W2/W3 safe. ‖ |
| 27 | **MED-W4** | Remove B9 "final counter" option until sub-state exists | `negotiation.ts:154-165`, `brandDecision.ts:408-431` | ⚠ shares `brandDecision.ts` → brandDecision.ts owner sequence. |
| 28 | **MED-N1** | Narrow `APPROVE_RE`; map brand QUESTION→AMBIGUOUS | `brandDecisionParse.ts`, `providerFactory.ts` | Completes CRITICAL-1's keyword-looseness note. ‖ (different files). |
| 29 | **EASY-W2** | `expireBrandDecision` partial-failure re-sweep | `runtime.ts:706-719` | → after HARD-R1 (sweep semantics). |
| 30 | **EASY-W3** | PaymentInfo/instance divergence bricks payout form | `routes/payment.ts:120-124` | ‖, ⚠ shares `payment.ts` with MED-S5 (Batch 4) → sequence. |

⚠ **brandDecision.ts owner (21,22,23,27):** one owner runs these in order. **inbound/lock owner (24,25):**
one owner. HARD-R1 (26) and MED-N1 (28) are separate parallel lanes.

---

## BATCH 4 — Negotiation-behavior & security hardening (independent lanes)
*Mostly independent bug-fixes with no cross-file conflicts, once Batches 1–3 exist. High parallelism.*

| # | ID | Fix | File(s) | Notes |
|---|----|-----|---------|-------|
| 31 | **MED-W1** | Honor mid-flow opt-out on every inbound (CAN-SPAM) | `replyDetection.ts`, `paymentReply.ts` | ‖ |
| 32 | **MED-W2** | Second same-round question swallowed (key on message id) | `negotiation.ts:368-374`, `idempotentSend.ts` | ⚠ **negotiation.ts owner** with 33,34,35. |
| 33 | **MED-W3** | Cap unbounded `present_offer` loop | `negotiation.ts:376-388` | negotiation.ts owner. |
| 34 | **MED-N3** | Use LLM-extracted rate for money path (not regex); validate substring | `negotiation.ts:93-127`, `negotiate.py:270-294` | negotiation.ts owner (+ small negotiate.py touch). |
| 35 | **MED-N2** | No-number pushback: hold w/o consuming round, ask for number | `negotiate.py:453-456` | ‖ (fallback path; small). |
| 36 | **MED-N4** | Move reward-agreement detection to LLM + literal "I Agree" allowlist | `rewardReply.ts:26-101` | ‖ |
| 37 | **MED-S1** | Harden output guard (word-numbers, allowlist-only $ amounts) | `guards/outputGuard.ts` | ‖ |
| 38 | **MED-S2** | Injection detection on /negotiate & /draft; escape delimiter tags | `injection.py`, `classify.py`, `negotiate.py` | ⚠ negotiate.py touch → coordinate w/ any open negotiate.py owner. |
| 39 | **MED-S4** | Brand-decision link expiry + confirm-POST prefetch safety | `routes/brandDecision.ts:55-140` | ‖ (component owns its links). |
| 40 | **MED-S5** | Payment token `expiresAt` | `schema.prisma`, `routes/payment.ts` | ⚠ shares `payment.ts` with EASY-W3 → sequence. |

⚠ **negotiation.ts owner (32,33,34):** one owner, one pass. MED-N3/W2 also need the money-path change to
respect Batch-1/2 guards — keep them consistent with PRINCIPLES.md (regex → LLM decides, code only bounds).

---

## BATCH 5 — Cross-cutting infra, knowledge, and the "not-by-code-alone" items (last)
*Depends on much of the above (T1 needs CRITICAL-4's Case-19; S1 needs A1; K1 needs the seam & re-draft).
The three starred items cannot reach score 8 by code alone — their scaffolding lands here; infra/data
follow-through is tracked as their acceptance criteria.*

| # | ID | Fix | File(s) | Notes |
|---|----|-----|---------|-------|
| 41 | **HARD-K1** | Knowledge fields + parse brief PDF + post-draft answer verification | campaign schema, `DraftRequest`, prompts, PDF parse | → after seam + HARD-N2. |
| 42 | **HARD-N2** | Thread history + creator's own messages into /draft | history assembly, `DraftRequest`, prompts | → after HARD-N1; prereq for K1's verification. Do 42 before 41. |
| 43 | **MED-A1** | Fail-fast on unset `EMAIL_PROVIDER`; require notifyEmail for escalations | `providerFactory.ts:106`, `escalation.ts` | ‖ (config/startup). |
| 44 | **EASY-S1** | Redact raw model output from HTTP error detail | `structured.py`, `classify.py`, `negotiate.py`, `agentServiceClient.ts` | ⚠ shares `structured.py`/`classify.py` with MED-L2 & MED-S2 → sequence after those. |
| 45 | **EASY-S2** | Mask leak values in observability event payloads | `observability/repository.ts` | ‖ |
| 46 | **EASY-W1** | Make `maxRounds` semantics consistent | `negotiate.py:1116,1988-1992`, `negotiation.ts:300` | ‖ (small; do in a negotiate.py owner slot). |
| 47 | **HARD-T2-followthrough** *(already in B1)* | *(reserved — T2 done in Batch 1)* | — | Placeholder removed; see item 3. |
| 48 | **HARD-T1** ★ | Machine-assert ALL eval cases (incl. Case-19 ESCALATE) + flow tests + CI gate | `run_eval.py`, CI, new tests | → after CRITICAL-4. **Scaffolding now; real ≥500-case dataset is the acceptance criterion.** |
| 49 | **HARD-O1** ★ | Observability: token/latency/cost telemetry, `{model,promptVersion}` stamp | `llm.py`, agent + engine instrumentation | ★ Scaffolding now; running metrics/alert backend is the acceptance criterion. |
| 50 | **HARD-S1** ★ | Worker fleet + concurrency + queue-depth/stuck-state metrics | workers, deploy config | → after HARD-A1. ★ Load test to 1,000 concurrent is the acceptance criterion. |

> **Note on item 47:** HARD-T2 (prompt versioning) is scheduled in Batch 1 (item 3) because HARD-P2 and
> HARD-T1 both need it. Item 47's slot is intentionally a no-op reference so the plan stays at 50 numbered
> lines mapping to the 50 fixes — the real 50th distinct fix is HARD-S1 (item 50). If you prefer a clean
> 1:1, treat item 47 as "verify T2 stamp is emitted on every AI call before O1 consumes it."

---

## Quick dependency spine (why the order is what it is)

```
HARD-N1 (seam, B1)
  ├─ MED-L1  (llm default, B1)          same file, same pass
  ├─ HARD-P1 (extraction prompt, B2)    needs always-draft-after-guards
  ├─ CRITICAL-4 (over-ceiling escalate, B2)  needs creator-ask in guard
  ├─ HARD-N2 (history→draft, B5) ─ HARD-K1 (knowledge+verify, B5)
  └─ CRITICAL-3 fee flows through guarded decision (B3)

HARD-T2 (prompt version, B1) ─ HARD-P2 (B2), HARD-T1 (B5)
HARD-A1 (topology, B1) ─ HARD-S1 (fleet, B5)
CRITICAL-2 (routing, B3) ─ CRITICAL-1 (identity, B3) ─ MED-N1 (keyword, B3)
HARD-R1 (sweep, B3) ─ EASY-W2, EASY-W3
CRITICAL-4 (B2) ─ HARD-T1 Case-19 assertion (B5)
```

## Single-file owner rule (the only real serialization constraint)

Assign ONE owner per hot file for the duration of a batch; everything else parallelizes.
- `agent/app/routes/negotiate.py` — Batches 1 & 2 (many items).
- `server/src/engine/executors/negotiation.ts` — Batch 4 (32,33,34).
- `server/src/engine/executors/brandDecision.ts` — Batch 3 (21,22,23,27).
- `agent/app/structured.py` / `agent/app/llm.py` — B1 (9,10) then B4/B5 (EASY-S1).
- `server/src/routes/payment.ts` — MED-S5 then EASY-W3.
