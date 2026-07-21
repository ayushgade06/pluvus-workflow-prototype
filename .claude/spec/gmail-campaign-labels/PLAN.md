# Spec — Gmail Campaign Labels

**Status:** DRAFT (planning) — rev. 2 (post-review refinements)
**Branch (proposed):** `feature/gmail-campaign-labels`
**Author:** (spec drafted 2026-07-21)
**Depends on:** `feature/email-threading` (Nylas threaded sends; the send chokepoint this feature hooks into)

> **Rev-2 note:** Refined per review. The headline change: the campaign name is
> **already loaded** on the send path (`ctx.campaign`, see §4/§6.3), so labeling
> adds **zero new DB round-trips** for the workflow-driven sends — we pass the name
> *into* `sendOnce`, we do not re-fetch it. Labeling is also now specified as fully
> **post-send, asynchronous, best-effort, and provider-isolated**, with structured
> debug logging. Architecture is otherwise unchanged: one `Pluvus/<Campaign name>`
> label per conversation thread.

---

## 1. Goal (in one sentence)

When Pluvus sends an outbound email for a campaign, apply a real **Gmail label named after that campaign** (`Pluvus/<Campaign name>`) to the thread via Nylas, so the operator can open Gmail and navigate/find every conversation for a campaign through Gmail's native label sidebar.

## 2. Problem / motivation

The operator runs many campaigns at once. Every negotiation with a creator is a separate email thread in one shared Gmail inbox. Today those threads are visually indistinguishable in Gmail — nothing on the thread tells the operator which campaign it belongs to, so finding "all conversations for *Summer Skincare*" means eyeballing subjects and creator names.

Gmail already has a first-class, familiar mechanism for exactly this: **labels**. If every thread for a campaign carries the label `Pluvus/Summer Skincare`, the operator clicks that label in Gmail's sidebar and sees the whole campaign's conversations — with Gmail's own filtering, unread counts, and search (`label:Pluvus/Summer-Skincare`) for free.

**Chosen surface (decided with the user):** real Gmail labels on the threads — *not* Pluvus-UI-only badges. Navigation happens **inside Gmail** using Gmail's native label click-to-filter. We are not building a filter UI in Pluvus for this feature; Gmail's sidebar *is* the filter UI.

```
Inside Gmail:
  ▾ Labels
     Pluvus/Summer Skincare  (12)
     Pluvus/Q3 Fitness Push  (7)
     Pluvus/Holiday Gift Guide (3)

  Thread: Re: Collab with jane_doe
     🏷 Pluvus/Summer Skincare
```

## 3. Non-goals

- **No Pluvus-side conversation-list filter UI.** Gmail is the navigation surface. (A Pluvus-side campaign badge/filter is a reasonable *future* follow-up but is explicitly out of scope here — see §11.)
- **No relabeling of historical threads** on first deploy beyond an optional one-shot backfill (§8, opt-in, phase 4).
- **No per-message labels.** Labels apply at the **thread** level (a Gmail thread = one conversation = one `ExecutionInstance`).
- **No user-editable / custom label names.** The label is always derived from the campaign name via a deterministic rule (§6.2). Renaming campaigns and its effect on existing labels is addressed in §9.
- **No label color/nesting config UI.** All labels live under one `Pluvus/` parent for a tidy sidebar; that prefix is configurable by env only.
- **Not provider-portable in this iteration.** Implementation targets Nylas→Gmail. The seam is designed so a future Graph/SES provider *could* implement it, but only the Nylas path is built now.

## 4. Where "campaign name" lives (grounding)

Relationship chain (verified against `server/src/db/schema.ts`):

```
Campaign (Campaign.name, line 256)              -- the label text source
  └─ Workflow.campaignId          (schema.ts:280)
       └─ WorkflowVersion.workflowId
            └─ ExecutionInstance.workflowVersionId  (schema.ts:333)  -- the "conversation"
                 └─ Message.instanceId / Message.threadId (schema.ts:372/379) -- the Gmail thread
```

- `Campaign.name` — `text("name").notNull()` — always present, this is the label source. (`server/src/db/schema.ts:256`)
- The Gmail/Nylas thread id is persisted on `Message.threadId` (`schema.ts:379`, indexed `Message_threadId_idx`).
- One `ExecutionInstance` ⇒ one thread ⇒ one campaign (an instance belongs to exactly one workflow version ⇒ one workflow ⇒ one campaign). So the mapping conversation→campaign is unambiguous.

**Key finding (rev-2) — the campaign is already loaded, no new read needed.**
Every workflow-driven outbound funnels through `sendOnce()`
(`server/src/engine/executors/idempotentSend.ts`), and the executors that call it
already hold the full `Campaign` row:

- `WorkflowRuntime.loadContext()` loads the parent campaign **once per dispatch**
  (`server/src/engine/runtime.ts:159-167` — `version → workflow → campaign` via
  `findWorkflowById` + `findCampaignById`) and returns it on the execution context
  as `ctx.campaign`.
- Every send-issuing executor already reads `ctx.campaign` — e.g.
  `initialOutreach.ts:46`, `followUp.ts:50`, `negotiation.ts:345` (via
  `mergeCampaignFallback`), and `contentBrief.ts:96` / `rewardSetup.ts:89` /
  `paymentInfo.ts:130` (via `resolveBrandName(config, ctx.campaign)`).

So `ctx.campaign.name` is **in hand at the exact `sendOnce()` call site** for the
workflow path. We pass it **into** `sendOnce` as an optional argument rather than
re-resolving it inside the send. **This removes the extra DB lookup entirely for
the hot path** (see §6.3 for the resolution rules and the route-caller fallback).

> Note the existing code uses `campaign.brand` for the sender identity; the *label*
> uses `campaign.name` (the campaign's own title, `schema.ts:256`) — both live on
> the same already-loaded row, so reading `.name` is free.

## 5. Nylas / Gmail label facts to confirm before building (SPIKE — phase 0)

The current Nylas surface (`server/src/providers/nylas/client.ts`, `NylasClientLike`) only exposes `messages.send` and `messages.find`. Labels are a **new Nylas capability** we have not touched. Before committing to the design, a short spike must confirm:

1. **Grant provider is Gmail.** Nylas "folders" API models Gmail labels as folders. Confirm the connected grant (`NYLAS_GRANT_ID`) is a Google grant (Gmail), because IMAP/other providers model folders differently and don't support arbitrary nested labels the same way.
2. **Required scopes.** Applying a label requires write scope on the grant. Confirm the grant was created with mail *modify* scope (not read-only). If not, the grant must be re-consented — this is an **ops prerequisite**, callable out in §10.
3. **API shape.** Confirm the exact SDK calls in the installed `nylas` package version for:
   - list folders/labels (to find-or-create `Pluvus/<name>`),
   - create a folder/label,
   - apply a folder/label to a **thread** (or to a message, which Gmail propagates to the thread).
   Nylas v3 exposes `nylas.folders.list/create` and updates thread/message `folders` via `threads.update` / `messages.update`. Record the precise method names + request/response shapes as an ADR in this folder before writing code.
4. **★ Thread-level behavior — the deciding spike question (Refinement #7).**
   Explicitly verify which of these produces correct, consistent Gmail behavior and
   make **that** the implementation:
   - **(a) Label the message** we just sent (via `messages.update` folders) and
     confirm **Gmail propagates the label to the ENTIRE conversation** (the whole
     thread shows the label, incl. the creator's prior/future replies in that
     thread), **OR**
   - **(b) Native thread labeling** — Nylas `threads.update` applies the label to
     the thread directly.
   Test both against the real Gmail grant: send/label, then open Gmail and confirm
   the label sits on the **whole conversation**, not just one message, and that a
   subsequent reply stays under the label. Whichever is consistent becomes the
   implementation; record the decision + evidence in the ADR. (Gmail's own model
   labels the *thread*, so (a) usually propagates — but this must be **verified**,
   not assumed, because it's the single behavior the whole feature depends on.)
5. **Nesting semantics.** Confirm `Pluvus/Summer Skincare` with a `/` renders as a nested label under a `Pluvus` parent in Gmail (Gmail uses `/` as the nesting separator). Confirm whether the parent `Pluvus` folder must be created explicitly first.
6. **Idempotency of create.** Confirm behavior when creating a label that already exists (does Nylas 409, or return the existing?), so the find-or-create + re-read-on-conflict path (§6.5) is race-safe.

> **Gate:** if the spike shows the grant lacks modify scope OR the installed SDK
> lacks a thread/message label-update method, STOP and escalate the ops/SDK
> upgrade before phases 1+. The rest of the plan assumes the spike passes.

## 6. Design

### 6.1 New provider capability (optional interface method)

Extend the transport-neutral provider seam, mirroring how `EmailSendOptions` was
added for threading (optional + last, so every existing caller compiles unchanged
— ADR-2 style from the threading spec).

In `server/src/engine/providers.ts`:

```ts
// Optional label capability. Providers that can label a thread implement it;
// callers feature-detect with a type guard, so MockEmailProvider and any
// provider without label support are unaffected.
export interface IThreadLabeler {
  /**
   * Ensure `label` exists (find-or-create) and apply it to the thread the given
   * provider threadId belongs to. Best-effort by contract: implementations MUST
   * NOT throw into the caller — a labeling failure never blocks or fails a send.
   */
  applyThreadLabel(threadId: string, label: string): Promise<void>;
}

export function isThreadLabeler(p: IEmailProvider): p is IEmailProvider & IThreadLabeler {
  return typeof (p as Partial<IThreadLabeler>).applyThreadLabel === "function";
}
```

`NylasEmailProvider` implements `IThreadLabeler`. `MockEmailProvider` does **not**
(so the whole feature is a no-op under `EMAIL_PROVIDER=mock` and in unit tests
that use the mock — labeling only ever fires against a real Gmail grant).

### 6.2 Label-name derivation (pure function, unit-tested)

`server/src/providers/nylas/campaignLabel.ts` — a pure transform, no I/O, mirroring
the `buildReplySubject` "presentation policy" pattern:

```ts
export function campaignLabelName(campaignName: string, prefix = "Pluvus"): string
```

> **The label is exactly `Pluvus/<Campaign name>` — no id, no hash, ever
> (Refinement #2).** Human readability inside Gmail is the priority. Two campaigns
> that intentionally share a name share the label; that is accepted for v1. The
> only transformations below are those Gmail *requires* to accept the string as a
> label — none of them add uniqueness.

Rules (each an explicit test case):
- Prefix with `<prefix>/` (default `Pluvus`, override via env `GMAIL_LABEL_PREFIX`).
- Trim; collapse internal whitespace runs to a single space.
- Strip characters Gmail rejects in label names; **critically, replace `/` in the
  campaign name itself** so a campaign literally named "A/B Test" doesn't create a
  spurious nesting level (`Pluvus/A/B Test`). Replace inner `/` with a safe
  separator (e.g. `-` or `∕` U+2215) — decide in the ADR and test it.
- Enforce Gmail's label length limit (truncate with care; document the limit found
  in the spike).
- Empty/whitespace campaign name ⇒ fall back to `Pluvus/Untitled` (defensive; the
  column is `notNull` so this should be unreachable, but never emit a bare
  `Pluvus/`).

### 6.3 Getting the campaign name to the send path — pass-through, NOT a lookup (Refinement #1)

The campaign name is **already loaded** at the `sendOnce` call site (§4), so we do
**not** add any DB read. Instead we thread it through as an optional parameter.

Add one optional field to the send-time options `sendOnce` already accepts, so the
campaign name rides along with the send it belongs to. Concretely, extend
`sendOnce`'s signature with an optional label hint (kept last / optional so every
existing caller compiles unchanged, ADR-2 style):

```ts
// idempotentSend.ts — one new optional field on an options bag (or a trailing
// optional arg). No engine-side Gmail concepts; just a plain campaign name string.
export interface SendOnceLabelHint {
  /** Human campaign name for the Gmail thread label. Undefined ⇒ no label applied.
   *  Passed by workflow executors from the already-loaded ctx.campaign.name — the
   *  send path performs NO campaign lookup of its own. */
  campaignName?: string;
}
```

Wiring:
- **Workflow executors (the hot path):** each `sendOnce(...)` call passes
  `ctx.campaign?.name` — a free field read on a row already in memory. Call sites:
  `initialOutreach.ts`, `followUp.ts`, `negotiation.ts` (ACCEPT/COUNTER),
  `contentBrief.ts`, `rewardSetup.ts`, `paymentInfo.ts`. **Zero new queries.**
- **Route-driven callers** (`routes/payouts.ts`, `routes/payoutConfirm.ts` — the
  brand-outbound payout emails) do **not** have `ctx.campaign` loaded. For v1 they
  simply **omit** `campaignName` ⇒ those threads go unlabeled (acceptable: they are
  low-volume brand-facing emails on an already-established thread, and a later
  workflow-driven send on the same thread self-heals the label). We explicitly do
  **not** add a lookup there to satisfy "avoid making the send path progressively
  heavier." If labeling those turns out to matter, a *single* isolated
  `getCampaignNameByInstanceId(instanceId)` helper can be added **only at those two
  call sites** later — never on the shared hot path.

`ThreadContext` / `DefaultThreadContextResolver` are **left untouched** — the
rev-1 idea of resolving `campaignName` inside the resolver is dropped precisely
because it would add a per-send round-trip.

### 6.4 Applying the label — post-send, asynchronous, best-effort (Refinements #3, #4, #6)

The email is **fully sent and finalized before any label work begins.** Labeling is
a post-send enhancement, never part of the delivery contract.

In `sendOnce()` (`idempotentSend.ts`), after step 3 (finalize) has produced the
`SentResult`, fire the label **without awaiting it** and return immediately:

```ts
// Steps 1–3 already completed: the email is SENT and the row finalized.
// Labeling happens AFTER, off the delivery path, and can never change the result.
maybeLabelThreadAsync(email, threadId, campaignName); // fire-and-forget, returns void
return { messageId, threadId, alreadySent: false };   // <- delivery contract, unchanged
```

```ts
// idempotentSend.ts — engine-side helper. Contains NO Gmail concepts: it only
// knows about the optional IThreadLabeler capability (Refinement #4). It never
// throws, never awaits into the caller, never touches workflow state.
function maybeLabelThreadAsync(
  email: IEmailProvider,
  threadId: string,
  campaignName: string | undefined,
): void {
  if (!campaignName || !threadId || !isThreadLabeler(email)) return;
  const label = campaignLabelName(campaignName);
  // Detached promise: the send has already returned. Any rejection is swallowed
  // and logged inside applyThreadLabel; the .catch here is belt-and-suspenders so
  // an unexpected synchronous-in-async throw can never surface as an unhandled
  // rejection that trips process-level handlers.
  void Promise.resolve()
    .then(() => email.applyThreadLabel(threadId, label))
    .catch((err) => {
      console.warn(
        `[labels] apply failed (non-fatal) threadId=${threadId} label=${label}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
}
```

The hard guarantees (Refinement #3 — **all** of these are acceptance criteria):

| A label failure must NEVER… | How this design guarantees it |
|---|---|
| fail email delivery | send + finalize complete and `SentResult` is returned *before* labeling starts |
| affect idempotency | labeling touches no `Message` row, no `idempotencyKey`, no reservation |
| delay the send | fire-and-forget; `sendOnce` does not `await` the label promise |
| retry the email send | labeling has its own (bounded, §6.5) recovery; it **never** re-invokes `email.send` |
| modify workflow state | helper returns `void`; it writes no DB, emits no event, changes no state |

Everything beyond "log a warning" is out of scope on failure — **logging a warning
is sufficient** (Refinement #3).

Provider isolation (Refinement #4): the engine helper above references **only**
`IThreadLabeler` + `campaignLabelName` (a pure string transform). All Gmail/Nylas
concepts — folders, folder ids, the label-vs-thread API, scopes — live **entirely
inside `NylasEmailProvider.applyThreadLabel`** (§6.6). The engine never imports a
Nylas type.

Applied on **every** outbound (not just the first): re-applying an existing label
to an already-labeled Gmail thread is a no-op, so follow-ups/counters are harmless
and **self-healing** — if the first apply failed, a later send fixes it. On the
`alreadySent` idempotent-replay branch we also fire the label (cheap, idempotent,
adds resilience). Brand-outbound recipient sends that *do* carry a campaign name
get labeled too (same instance thread; correct).

### 6.5 Label find-or-create cache + concurrency safety (Refinement #5)

Inside `NylasEmailProvider`, a process-lifetime `Map<labelName, string>`
(labelName → Gmail folder/label id) so we hit Nylas `folders.list`/`create` only
the first time a campaign's label is seen, then reuse the id (lazy-singleton
spirit of the Nylas client).

**Find-or-create, race-safe under concurrent sends** — two sends for the same brand-new
campaign can land in `applyThreadLabel` at the same moment. The resolution MUST be
idempotent under that concurrency:

1. **Cache hit** → use the stored id. Done.
2. **Cache miss** → resolve the id via a per-label single-flight:
   - Keep a second `Map<labelName, Promise<string>>` of **in-flight** resolutions.
     If a resolution for this label is already in flight, `await` that same promise
     instead of starting a second one — so concurrent sends in one process collapse
     to a single list/create.
   - The resolution promise: `folders.list` → find by exact name → if present, use
     its id; if absent, `folders.create`.
   - **On create-conflict** (the label was created concurrently — by another
     process, or a race Nylas didn't collapse; spike item §5.6 confirms whether this is a 409
     or a silent return): **do not fail. Re-read** via `folders.list`, find the now-
     existing label by name, and use its id (Refinement #5: "recover by re-reading
     the label and continue applying it"). Only if the re-read *still* can't find it
     do we give up — log a warning and skip the label for this send (delivery already
     succeeded; a later send retries).
   - Store the resolved id in the cache; clear the in-flight entry.
3. **Apply** the resolved label id to the thread (mechanism decided in the Phase 0
   spike — §7). Applying an already-present label is a Gmail no-op.

Cache is per-process and self-warming; a restart just re-lists once per campaign.
No persistence needed. (Cross-process create races are handled by the re-read in
step 2, not by the cache.)

### 6.6 Nylas provider implementation + structured logging (Refinements #4, #8)

All Gmail/Nylas specifics live **only** here (`NylasEmailProvider.applyThreadLabel`
+ its private helpers), behind the engine's `IThreadLabeler` seam. The method:

- is a no-op / early-returns unless `GMAIL_LABELS_ENABLED` is true (read once at
  construction, §8);
- never throws — every path is wrapped so the detached caller (§6.4) can rely on it;
- runs the find-or-create-with-cache from §6.5, then applies the label to the thread;
- emits **structured debug logs** at each meaningful step so Gmail-integration
  issues are diagnosable without behavior changes (Refinement #8). Use a single
  structured line per event (object payload, not string concatenation) under a
  `[labels]` tag, e.g.:

  ```ts
  logger.debug({
    evt: "label.apply",          // one of the events below
    campaignName,                // human campaign name (input)
    label,                       // resolved "Pluvus/<name>"
    threadId,
    labelId,                     // resolved folder/label id (when known)
    outcome,                     // see event list
  }, "[labels] …");
  ```

  Events to emit (each its own `evt`):
  - `label.resolve.cache_hit` — reused a cached label id
  - `label.resolve.listed` — listed folders on a cache miss
  - `label.created` — a new Gmail label was created (`outcome: "created"`)
  - `label.reused_existing` — found an already-existing label (`outcome: "existing"`)
  - `label.create_conflict.recovered` — hit a create race, re-read, recovered
  - `label.applied` — label successfully applied to the thread (`outcome: "applied"`)
  - `label.apply_failed` — any failure (logged at `warn`, with the error message)
  - `label.skipped` — skipped because flag off / missing threadId / missing name

  The failure log carries `campaignName`, `label`, `threadId`, and the error
  message (never the whole error object at `warn` in prod). Debug-level events are
  gated by the app's existing log level, so they're free in production unless
  explicitly enabled.

## 7. Files touched (summary)

| File | Change |
|---|---|
| `server/src/engine/providers.ts` | Add `IThreadLabeler` + `isThreadLabeler` guard (engine seam only — no Gmail concepts) |
| `server/src/providers/nylas/client.ts` | Extend `NylasClientLike` with the folders/label surface confirmed in the spike (`folders.list/create`, thread/message update) |
| `server/src/providers/nylas/campaignLabel.ts` | **NEW** pure `campaignLabelName()` derivation |
| `server/src/providers/nylas/nylasEmailProvider.ts` | Implement `applyThreadLabel` (find-or-create + single-flight cache + re-read-on-conflict + structured logging + error-swallowing) |
| `server/src/engine/executors/idempotentSend.ts` | Add optional `campaignName` hint to `sendOnce`; fire `maybeLabelThreadAsync` **after** finalize (fire-and-forget) |
| `server/src/engine/executors/{initialOutreach,followUp,negotiation,contentBrief,rewardSetup,paymentInfo}.ts` | Pass `ctx.campaign?.name` into their existing `sendOnce(...)` calls (free read; no new query) |
| `server/src/providers/nylas/mockNylasClient.ts` | Extend fake with the folders surface for tests |
| env / `.env.example` / `SECRETS.md` | `GMAIL_LABELS_ENABLED`, `GMAIL_LABEL_PREFIX` |

> **Not touched (rev-2):** `threadContext.ts` and no new `getCampaignNameByInstanceId`
> join query — deliberately, to avoid adding a per-send DB round-trip (Refinement #1).

## 8. Config / feature flag

- `GMAIL_LABELS_ENABLED` (default `false`) — master switch. Even with a labeler
  provider present, no label is applied unless this is `true`. Lets us ship dark and
  turn on after the grant scope is confirmed in the target environment.
- `GMAIL_LABEL_PREFIX` (default `Pluvus`) — parent label namespace.
- Both read once at provider construction, consistent with existing Nylas env
  handling.

## 9. Edge cases & decisions

- **Campaign renamed after threads were labeled.** The old label stays on old
  threads; new sends create/apply the new label. Result: a renamed campaign can have
  two labels historically. **Decision for v1:** accept this (document it). A
  "rename → merge labels" reconciliation is out of scope (would require tracking
  campaignId→labelId and a Gmail label rename/merge, which Gmail supports but adds
  complexity). Revisit only if it bites in practice.
- **Two campaigns with identical names.** They share the label. **Explicitly
  accepted for v1** (Refinement #2) — we do **not** disambiguate with a campaign-id
  suffix or hash; human readability wins.
- **Thread not yet created / threadId missing.** No label (guarded by `threadId`
  truthiness). Self-heals on the next send once a threadId exists.
- **Non-Gmail grant / missing scope.** `applyThreadLabel` catches the API error,
  logs once, and the send is unaffected. Feature effectively no-ops.
- **Nylas rate limits on folders.list.** Mitigated by the per-process cache (§6.5):
  at most one list + one create per campaign per process lifetime.
- **Mock provider / tests.** `MockEmailProvider` isn't a labeler ⇒ zero behavior
  change in the existing 267-server-test suite; the guard makes every current test a
  no-op for labeling.

## 10. Ops prerequisites (call out before enabling)

1. **Nylas grant must have Gmail mail-modify scope.** If the current grant is
   read/send only, re-consent with modify scope (one-time; document the scope list
   in `SECRETS.md`).
2. **Confirm grant is a Google/Gmail grant** (folders == Gmail labels). Non-Gmail
   providers are out of scope.
3. Flip `GMAIL_LABELS_ENABLED=true` only after 1–2 are verified in that environment.

## 11. Optional backfill (phase 4, opt-in)

A one-shot admin script that walks existing `ExecutionInstance`s with a `threadId`,
resolves each campaign name **offline** (a per-instance join lookup is fine here —
this is a batch job, **not** the hot send path), and applies the label — so
*existing* conversations show up under their Gmail label immediately, not only after
their next send.
- Batched, rate-limit-aware (reuses the §6.5 cache), idempotent (re-runnable).
- Guarded behind an explicit CLI flag; not run automatically on deploy.
- Logs a summary (threads labeled / skipped / errored).

## 12. Testing

**Unit (no live Nylas):**
- `campaignLabelName()` — table of cases: prefixing, whitespace collapse, inner `/`
  replacement ("A/B Test" → single label, NOT nested), length truncation,
  empty→`Pluvus/Untitled`, custom prefix, and **no id/hash ever appended**
  (Refinement #2 — assert output equals `Pluvus/<name>` exactly).
- `applyThreadLabel` with `mockNylasClient` extended for folders:
  - find-or-create hits the cache on the second call (only one `folders.list`);
  - **concurrency (Refinement #5):** two overlapping calls for the same brand-new
    label collapse to a single create (single-flight) — assert `folders.create`
    fires **once**;
  - **create-conflict recovery:** a create that reports "already exists" triggers a
    re-read and the existing id is used — the call still **succeeds** and never
    throws;
  - any thrown API error is swallowed → the returned promise **never rejects**.
- `isThreadLabeler` guard: true for Nylas provider, false for mock.
- **`sendOnce` best-effort contract (Refinement #3):** with a stub labeler whose
  `applyThreadLabel` throws/rejects/hangs, assert `sendOnce` still returns the
  correct `SentResult`, does not throw, does not re-call `email.send`, and writes no
  extra `Message` row. With a mock (non-labeler) provider, existing sendOnce tests
  stay byte-identical (labeling is a no-op).
- **Pass-through, no lookup (Refinement #1):** assert `sendOnce` performs **no**
  campaign query — it uses the `campaignName` argument as given; `undefined` ⇒ no
  label attempted.
- **Async / non-blocking (Refinement #6):** with a labeler whose `applyThreadLabel`
  returns a never-resolving promise, `sendOnce` still resolves promptly (the send
  does not await the label).
- **Logging (Refinement #8):** with an injected logger, assert the structured
  events fire with the right fields (`label.created`, `label.reused_existing`,
  `label.applied`, `label.apply_failed`).

**Integration / manual (live Gmail grant, `GMAIL_LABELS_ENABLED=true`):**
- **★ Thread-level propagation (Refinement #7):** run a real outreach send; open
  Gmail and confirm the label sits on the **whole conversation**; then have the
  creator reply and confirm the reply stays under the same label. This validates the
  §5.4 spike decision end-to-end.
- Confirm the label appears in the Gmail sidebar with the right nesting under
  `Pluvus/`.
- Send a follow-up on the same thread; confirm no duplicate label, no error.
- Two campaigns → two distinct labels; both navigable via Gmail sidebar click.
- Revoke modify scope (or point at a read-only grant) → send still delivers, warning
  logged, no crash.

**Regression:** full `server` suite (currently 267/267) must stay green with the
flag default-off.

## 13. Phasing

- **Phase 0 — SPIKE (§5).** Confirm grant/scope/SDK surface + nesting + create
  idempotency, and **★ verify thread-level propagation** (§5.4, Refinement #7) —
  message-label-propagates-to-thread vs. native thread labeling. Write an ADR
  (`ADR-labels-nylas.md`) recording the SDK shapes, the chosen thread-label
  mechanism (with evidence), and the inner-`/` char. **Gate.**
- **Phase 1 — Pure + seam.** `campaignLabelName()` (+ tests), `IThreadLabeler` +
  `isThreadLabeler` guard, and the optional `campaignName` pass-through param on
  `sendOnce` (+ tests). **No** `ThreadContext` change and **no** new join query
  (Refinement #1). No wire calls to Nylas yet.
- **Phase 2 — Nylas labeler.** `client.ts` folders surface, `mockNylasClient`
  extension, `NylasEmailProvider.applyThreadLabel` with single-flight cache +
  re-read-on-conflict + structured logging + error swallowing (+ tests).
- **Phase 3 — Wire it in.** Executors pass `ctx.campaign?.name` into `sendOnce`;
  `sendOnce` fires `maybeLabelThreadAsync` after finalize, behind
  `GMAIL_LABELS_ENABLED`. Ship dark (flag off). (+ async/best-effort sendOnce tests.)
- **Phase 4 — (optional) Backfill** script + manual live verification (incl. the
  §12 thread-propagation check), then enable the flag in the target environment.

## 14. Acceptance criteria

- With the flag on and a Gmail modify-scope grant, every outbound for a campaign
  results in the **whole conversation thread** carrying `Pluvus/<Campaign name>` in
  Gmail, navigable via Gmail's label sidebar (Gmail provides the click-to-filter).
- The label is exactly `Pluvus/<Campaign name>` — **no id, no hash** (Refinement #2).
- The send path performs **no campaign DB lookup** for labeling — the name is passed
  through from already-loaded context (Refinement #1).
- A labeling failure never: fails delivery, affects idempotency, delays the send,
  retries the email send, or modifies workflow state — it only logs a warning
  (Refinement #3). Labeling runs **after** the send is complete and is not awaited
  (Refinement #6).
- Label creation is idempotent and race-safe under concurrent sends (Refinement #5).
- No Gmail/Nylas concept leaks into the engine layer (Refinement #4).
- Structured debug logs cover resolve/create/reuse/apply/fail (Refinement #8).
- With the flag off, or under the mock provider, behavior and all existing tests are
  unchanged.
- Label names are deterministic, collision-safe on `/`, and length-bounded.

## 15. Open questions (resolve in Phase 0)

1. Exact installed-`nylas`-SDK method names/shapes for list/create folder + apply to
   thread (record in the ADR).
2. **★ Decided by the §5.4 spike (Refinement #7):** label the **thread** natively
   vs. label the just-sent **message** and rely on Gmail propagating to the whole
   conversation — pick whichever is verified to consistently label the entire
   conversation; record the evidence in the ADR.
3. Inner-`/` replacement char (`-` vs `∕`) — pick in the ADR with a test.
4. Confirm Gmail label max length to set the truncation bound.
5. Whether the optional Phase-4 backfill warrants the one isolated
   `getCampaignNameByInstanceId` helper (it walks instances offline, so a lookup
   there is fine — it is **not** on the hot send path); decide when/if Phase 4 is
   built.
