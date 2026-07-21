# ADR — Gmail Campaign Labels via Nylas (Phase 0 spike)

**Status:** ACCEPTED (spike complete)
**Date:** 2026-07-21
**Feature spec:** `./PLAN.md`
**Scope:** records the Nylas SDK surface, the chosen thread-label mechanism (with
evidence from the installed SDK types), the inner-`/` replacement char, and the
Gmail label length bound — the open questions the spec §15 defers to Phase 0.

---

## 1. Installed SDK

- Package: `nylas` — installed version **8.4.0** (`package.json` declares `^8.3.0`;
  hoisted to the repo-root `node_modules/nylas`). Nylas **API v3** SDK.
- v3 consolidates Gmail *labels* and Microsoft *folders* under **one Folders API**
  (`node_modules/nylas/lib/types/resources/folders.d.ts` header comment):
  > "In Nylas API v3, these endpoints are consolidated under Folders … Nylas uses
  > the same folders commands to manage both folders and labels."
  So for a **Gmail grant, a Nylas "folder" *is* a Gmail label.** `Pluvus/<name>`
  created as a folder shows up as a Gmail label; the `/` nests it under a `Pluvus`
  parent in Gmail's sidebar (Gmail's native nesting separator).

## 2. Exact SDK method shapes (open question §15.1)

Recorded from the installed `.d.ts` files so the `NylasClientLike` extension is
typed to the real SDK.

### 2.1 List folders — `nylas.folders.list`
```ts
list({ identifier, queryParams }: {
  identifier: string;                 // the grant id
  queryParams?: ListFolderQueryParams;
}): AsyncListResponse<NylasListResponse<Folder>>;
// resolves to { data: Folder[], ... }
```
`Folder = { id: string; name: string; object: string; grantId: string;
attributes?: string[]; ... }`. We match a label by **exact `name`** (the full
`Pluvus/<name>` string — Gmail returns nested labels by their full path).

### 2.2 Create folder — `nylas.folders.create`
```ts
create({ identifier, requestBody }: {
  identifier: string;
  requestBody: CreateFolderRequest;   // { name: string; ... }
}): Promise<NylasResponse<Folder>>;   // { data: Folder }
```
`CreateFolderRequest.name` constraint (from the model doc): **1–1024 chars.**

### 2.3 Apply a label to the conversation — `nylas.messages.update`
```ts
update({ identifier, messageId, requestBody }: {
  identifier: string;
  messageId: string;
  requestBody: UpdateMessageRequest;  // { folders?: string[]; ... }
}): Promise<NylasResponse<Message>>;
```
`Message.folders: string[]` is readable on `messages.find`, and
`UpdateMessageRequest.folders` sets the folder-id set the message appears in.

## 3. ★ Deciding spike: how to apply the label to the whole conversation (§5.4 / §15.2)

The engine seam is `IThreadLabeler.applyThreadLabel(threadId, label)` — it carries
the **threadId** (which `sendOnce` has from the `SentResult`), NOT a messageId.
Whatever mechanism we pick must key off the threadId and label the **entire
conversation**. Three candidates the SDK surfaces:

| Mechanism | SDK call | Semantics (from the SDK model docs) |
|---|---|---|
| (a) label the sent message | `messages.update({ folders })` | needs a messageId (not on the seam); message-level, propagates to the thread |
| (b) naive thread label | `threads.update({ folders: [labelId] })` | ⚠ "The IDs of the folders to apply, **overwriting all previous folders for all messages in the thread**" — DESTRUCTIVE |
| **(c) read-then-union thread label** | `threads.find` → `threads.update({ folders: [...existing, labelId] })` | additive: read the thread's current folder set, add our label id, write back |

**Decision: (c) — read-then-union at the THREAD level.**

**Why, with evidence:**

1. **It matches the seam exactly.** `applyThreadLabel` receives `threadId`, and
   `threads.find({ threadId })` → `Thread.folders: string[]` reads the thread's
   current folder/label set, so no messageId plumbing is needed. (Mechanism (a)
   would require adding a messageId to the seam — an unnecessary signature change.)

2. **Naive (b) is destructive.** `UpdateThreadRequest.folders` is documented to
   **overwrite all previous folders for all messages in the thread**. Passing
   `[labelId]` alone would strip `INBOX` / `SENT` / `IMPORTANT` from the whole
   conversation — data loss, not a label add. So we NEVER pass the label alone.

3. **Read-then-union makes (b)'s overwrite safe and additive.** We first
   `threads.find` to read `data.folders`, then:
   - if `labelId` already present → **no-op** (skip the update entirely →
     idempotent, self-healing, and it means a follow-up/counter re-apply is free),
   - else `threads.update({ folders: [...existing, labelId] })` — the write-back
     is the FULL prior set plus our label, so nothing is stripped.
   Because Gmail models labels at the thread level, the label then shows on the
   whole conversation and a later reply inherits it — the exact §5.4 requirement,
   Gmail-native (not a Nylas quirk).

> **Refinement over PLAN.md:** the spec's §6.5 step 3 said "apply the resolved
> label id to the thread" without noting that Nylas's `threads.update.folders` is
> overwrite-not-add. The read-then-union above is the concrete, non-destructive
> realization of "apply the label" — same architecture (one thread-scoped update,
> best-effort, post-send, keyed on the seam's threadId), plus the detail that makes
> the apply *safe*. `messages.update` + `Message.folders` are still added to the
> `NylasClientLike` surface as a documented fallback should a deployment ever need
> message-level labeling, but the built path is (c). Recorded here per §5.4's
> mandate to "record the decision + evidence in the ADR."

## 4. Nesting & the parent `Pluvus` folder (§5.5)

Gmail uses `/` as its label-nesting separator, so `Pluvus/Summer Skincare` renders
as `Summer Skincare` under a `Pluvus` parent. In Nylas v3 you create the nested
label by its **full path name** (`folders.create({ name: "Pluvus/Summer Skincare" })`);
Gmail auto-materializes the `Pluvus` parent. We therefore do **not** pre-create the
parent explicitly — one create per full label path is sufficient. (If a deployment's
Gmail requires the parent first, the find-or-create still succeeds: the parent shows
up as its own label and our nested create still returns the leaf id.)

## 5. Idempotency of create / conflict recovery (§5.6)

Nylas `folders.create` for a name that already exists is **not guaranteed** to
return the existing folder; it can surface a provider conflict. The design
(PLAN §6.5) is conflict-tolerant regardless of which way this goes:
- single-flight per label name collapses concurrent same-process creates to one,
- **on any create error, re-read via `folders.list`** and, if the label now exists,
  use its id (create-race recovered); only if the re-read still can't find it do we
  give up for this send (delivery already succeeded; a later send retries).

This makes the path race-safe across processes without relying on create's exact
conflict semantics.

## 6. Inner-`/` replacement char (§15.3)

A campaign literally named `A/B Test` must NOT create a spurious nesting level
(`Pluvus/A/B Test` → a `B Test` sub-label under an `A` sub-label under `Pluvus`).

**Decision: replace inner `/` (and `\`) with a hyphen `-`.**
- Chosen over U+2215 `∕` (division slash) for **operator readability and
  searchability**: `-` is plain ASCII, types cleanly into Gmail's `label:` search,
  and reads naturally in the sidebar. `A/B Test` → `Pluvus/A-B Test`.
- The single intended nesting `/` is the one **we** prepend (`<prefix>/`); every `/`
  originating from the campaign name is flattened to `-`.

## 7. Gmail label length bound (§15.4)

- Nylas `CreateFolderRequest.name` documents **1–1024 chars**.
- Gmail's own per-label-*component* limit is 225 chars, and the total path limit is
  well under 1024 in practice.
- **Decision:** bound the full derived label to **225 chars** (safe for both Gmail
  and Nylas), truncating the campaign-name portion (never the `<prefix>/`) with an
  ellipsis when needed. Two very-long campaign names that differ only past 225 chars
  collide — accepted for v1 (same policy as identical names, PLAN §9).

## 8. Ops prerequisite reconfirmed (PLAN §10)

Applying a label requires the Gmail grant to have **mail-modify** scope.
`threads.update` (and `folders.create`) fail on a read/send-only grant. This is an
environment prerequisite gated behind `GMAIL_LABELS_ENABLED` and documented in
`readme_docs/ops/SECRETS.md`. A missing scope surfaces as a caught, logged
`[labels]` warning — the send is unaffected.

## 9. Phase 4 backfill — join lookup decision (§15.5)

Open question §15.5 asks whether the optional Phase-4 backfill warrants the one
isolated `getCampaignNameByInstanceId` helper. **Decision: no dedicated helper —
the backfill (`scripts/backfill-gmail-labels.ts`) resolves the campaign name with
an inline `selectDistinct` join** (`messages → executionInstances →
workflowVersions → workflows → campaigns`, filtered on `messages.threadId IS NOT
NULL`). This is explicitly sanctioned by PLAN §11 ("a per-instance join lookup is
fine here — this is a batch job, not the hot send path"). A one-off script is not
worth a new shared DB helper; the join lives where it's used. The backfill reuses
the provider's per-process §6.5 cache (one `NylasEmailProvider` for the whole run),
is dry-run by default (`--apply` to write), and is gated on `EMAIL_PROVIDER=nylas`
+ `GMAIL_LABELS_ENABLED=true` + a labeler-capable provider.

## 10. Net effect on the design

The spike **passes** the PLAN §5 gate: the installed SDK exposes folders + threads
update, the modify-scope requirement is an ops flag (not a code blocker), and the
thread-propagation question resolves to the thread-level read-then-union (decision
(c)), which is non-destructive and matches the `applyThreadLabel(threadId, label)`
seam exactly. No architectural change to PLAN.md — only these concretizations, all
recorded above.
