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

## 3. ★ Deciding spike: message-label vs. native thread-label (§5.4 / §15.2)

Two candidate mechanisms, both surfaced by the SDK:

| Mechanism | SDK field | Semantics (from the SDK model docs) |
|---|---|---|
| **(a) label the sent message** | `messages.update({ folders })` | "The IDs of the folders the message should appear in." Gmail's data model labels the **thread**, so a label on any message surfaces on the whole conversation. |
| **(b) native thread label** | `threads.update({ folders })` | ⚠ "The IDs of the folders to apply, **overwriting all previous folders for all messages in the thread**." |

**Decision: (a) — label the just-sent message via `messages.update`.**

**Why, with evidence:**

1. **(b) is destructive.** The SDK doc for `UpdateThreadRequest.folders` is explicit
   that it **overwrites all previous folders for all messages in the thread**.
   Passing `[labelId]` there would strip `INBOX` / `SENT` / `IMPORTANT` etc. from
   every message in the conversation — a data-loss bug, not a label add. `threads.update`
   has no add-only mode. So (b) is rejected outright.

2. **(a) propagates to the whole conversation.** Gmail's own model attaches labels
   at the thread level; a label on one message shows on the entire thread in the
   Gmail UI, and a later reply on that thread inherits the thread's labels. This is
   the exact behavior §5.4 requires, and it is Gmail-native (not a Nylas quirk), so
   it holds for future replies too.

3. **`folders` is still set-semantics on the message.** `UpdateMessageRequest.folders`
   replaces *that one message's* folder set (Gmail messages can be in multiple
   folders/labels at once). To **add** our label without dropping the message's
   existing folders (SENT, etc.), the implementation MUST **read-then-union**:
   - `messages.find(messageId)` → read `data.folders` (current set),
   - if `labelId` already present → no-op (idempotent, self-healing),
   - else `messages.update({ folders: [...current, labelId] })`.
   This keeps the operation additive and idempotent: re-applying an already-present
   label is a no-op, matching the spec's self-healing contract (§6.4).

> **Note (refinement over PLAN.md):** the spec's §6.5 step 3 said "apply the
> resolved label id to the thread" without specifying that the underlying Nylas
> `folders` field is overwrite-not-add. The read-then-union above is the concrete,
> non-destructive realization of "apply the label" — it does not change the
> architecture (still one message-scoped update, best-effort, post-send) but it is
> the detail that makes the apply *safe*. Recorded here per §5.4's mandate to
> "record the decision + evidence in the ADR."

**We label the just-sent message** (whose id `sendOnce` already has as
`messageId`) rather than an arbitrary thread message, because it is guaranteed to
exist and belong to the thread, and Gmail propagates the label to the whole
conversation from there.

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

Applying a label requires the Gmail grant to have **mail-modify** scope. `messages.update`
fails on a read/send-only grant. This is an environment prerequisite gated behind
`GMAIL_LABELS_ENABLED` and documented in `readme_docs/ops/SECRETS.md`. A missing
scope surfaces as a caught, logged `messages.update` error — the send is unaffected.

## 9. Net effect on the design

The spike **passes** the PLAN §5 gate: the installed SDK exposes folders + message
update, the modify-scope requirement is an ops flag (not a code blocker), and the
thread-propagation question resolves to mechanism (a) with a read-then-union to keep
it non-destructive. No architectural change to PLAN.md — only these concretizations,
all recorded above.
