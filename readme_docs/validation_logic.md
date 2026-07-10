# Workflow Validation — End‑to‑End Architecture

This document traces the **complete lifecycle** of validation for workflow nodes in this
repo — every entry point, the data flow from keystroke to badge, the true source of truth,
a Follow‑Up deep dive, all rules per node type, how the `"Needs configuration"` string is
produced, a Summary‑vs‑Validator comparison, a bug review, and an architecture diagram.

It is written against the actual code, not the intent. File/line references are given so
each claim is checkable.

> **TL;DR of the headline finding.** There are **two independent config‑validity engines on
> the frontend** that read the *same* object but apply *different rules*:
> - the **graph validator** (`web/src/workflow/graphValidation.ts` → `validateNodeConfig`), and
> - the **node heuristic** (`web/src/components/builder/nodeMeta.ts` → `nodeWarning` + `configSummary`).
>
> The `"Needs configuration"` badge on a node is driven by **`nodeWarning`**, *not* by the
> graph validator. And `configSummary` (the one‑line card text) uses **different fields** than
> `nodeWarning`. That mismatch is exactly why a node can show a healthy summary line while
> still displaying **"Needs configuration"** — see [§11](#11-why-a-node-shows-a-valid-summary-but-needs-configuration).

---

## 1. Validation Entry Points

Every place validation is triggered, in the order a user hits them.

| # | Trigger | File · Function | Caller | Purpose |
|---|---------|-----------------|--------|---------|
| 1 | **Live, on every edit** (per render of the builder) | `web/src/components/builder/WorkflowBuilder.tsx` · `validation = useMemo(() => validateGraph(def), [def])` (line ~95) | Re‑runs whenever `def` (the `WorkflowDefinition`) changes | Produces the structured `ValidationResult` that feeds the validity pill + node red‑rings |
| 2 | **Per‑node badge/summary** (per node render) | `web/src/components/builder/BuilderNode.tsx` (lines 36‑39) via `nodeMeta.ts` · `nodeWarning(node)`, `configSummary(node)`, `configChips(node)` | React Flow renders each node through `BuilderNodeComponent` | Drives the card body text, chips, and the `"Needs configuration"` footer — **independent of the graph validator** |
| 3 | **Per‑field inline, while typing/blurring** | `web/src/components/builder/NodeConfigPanel.tsx` (e.g. `invalid={!body.trim()}`, line 480; `budgetInvalid`) | The config form inputs | Red field outlines. **Cosmetic only** — never blocks save/publish |
| 4 | **After a config update** (config panel) | `WorkflowBuilder.tsx` · `handleNodeUpdate` (line 166) → `setLocalDef` → recompute `def` → entry #1 re‑runs | `NodeConfigPanel`'s `onUpdate` callback | New config flows into the graph, re‑triggering live validation |
| 5 | **After any canvas edit** (drag / connect / delete / add) | `GraphCanvas.tsx` `onChange` → `WorkflowBuilder.handleGraphChange` (line 156) → `setLocalDef` → entry #1 | React Flow change handlers | Structural edits re‑trigger live validation |
| 6 | **On (debounced) save** | `WorkflowBuilder.tsx` · `doSave` (line ~123) → `saveDraft` → `PUT /workflows/:id/draft` | `scheduleSave` (1s debounce) | Server validates the saved graph **softly** (advisory; the draft saves regardless) |
| 7 | **Before publish (client pre‑gate)** | `WorkflowBuilder.tsx` · `handlePublish` (line ~222) calls `validateGraph(def)` | The **Publish** button | Fast client‑side fail before the round‑trip |
| 8 | **Before publish (server authoritative gate)** | `server/src/routes/workflows.ts` · `POST /:id/publish` → `validateWorkflowNodes(wf.draftNodes)` (full mode) | `handlePublish` → `validateWorkflow()` (`POST /:id/validate`) then `publishWorkflow()` | **Hard gate** — `422`, no `WorkflowVersion` created if invalid |
| 9 | **On‑demand validate (no side effects)** | `server/src/routes/workflows.ts` · `POST /:id/validate` → `validateWorkflowNodes(wf.draftNodes)` | `builderClient.validateWorkflow` | Returns `{ valid, errors, issues }` for the builder to display |
| 10 | **Before launch** | `server/src/routes/workflows.ts` · `POST /:id/launch` → `validateWorkflowNodes(latestVersion.nodeGraph, { structuralOnly: true })` | The **Launch** button (`LaunchTab`) | **Hard gate** — `422`, no jobs enqueued if the published graph is structurally broken. Config checks **skipped** (see [§5.6](#56-two-modes-full-vs-structural-only)) |
| 11 | **On page load / refresh** | `WorkflowBuilder` seeds `localDef` from `wf.draftNodes` via `linearNodesToGraph`; entry #1 runs on first render | `useWorkflow` query resolves | First validation pass for the loaded workflow |

There is **no** validation inside the debounced save that *blocks* the save — the draft is
stored as‑is (`PUT /:id/draft` only rejects a non‑array body).

---

## 2. Data Flow (keystroke → badge)

Concrete path for editing a **Follow‑Up** body:

```
User types in "Follow-Up Body" textarea
  │  NodeConfigPanel.tsx · FollowUpForm · setBody(e.target.value)         [local React state, form-only]
  ▼
onBlur → flush()                                                          [assembles a NEW config object]
  │  onUpdate(nodeId, { intervals, intervalUnit, maxCount, bodyTemplate, stopOnReply })
  ▼
WorkflowBuilder.handleNodeUpdate(nodeId, config)                         [replaces that node's config]
  │  next = { ...def, nodes: def.nodes.map(n => n.id===nodeId ? {...n, config} : n) }
  ▼
setLocalDef(next)   ──►  def = localDef ?? linearNodesToGraph(serverNodes ?? [])   [WorkflowDefinition = source of truth]
  │                          (useMemo, line ~89)
  ├────────────────────────────────────────────────────────────────────┐
  ▼                                                                      ▼
validation = validateGraph(def)          [ENTRY #1]           displayNodes = topologicalOrder(def).map(...)   [DraftNode[] for panel/sidebar]
  │  → ValidationResult { valid, errors:[{code,message,nodeId,edgeId,severity}] }
  ▼
issues passed to <GraphCanvas issues={validation.errors} />
  │  GraphCanvas.buildRfNodes → data.forceInvalid = invalidNodeIds.has(n.id)   [structural/graph errors ring the node]
  ▼
BuilderNode renders:
  • warning = nodeWarning(node)      [ENTRY #2 — SEPARATE heuristic, nodeMeta.ts]
  • summary = configSummary(node)    [ENTRY #2 — SEPARATE heuristic, DIFFERENT fields]
  • invalid = (warning !== null) || forceInvalid
  • if (invalid) render "⚠ Needs configuration"

Meanwhile (1s later): scheduleSave(next) → doSave → graphToLinearNodes(def) → saveDraft
  → PUT /workflows/:id/draft → restampBrand + stampRewardFromNegotiation → store draftNodes (JSON)
  → server returns { valid, validationErrors, validationIssues }  [advisory, currently unused by the client on save]
```

**Every transformation:**

| Stage | Object | Shape | Notes |
|-------|--------|-------|-------|
| Form field | `useState` (`subject`, `body`, `intervals`…) | primitives | seeded from `config` on mount; re‑seeds only on `nodeId` change |
| `flush()` payload | plain object | `{ intervals, intervalUnit, maxCount, bodyTemplate, stopOnReply }` | brand‑new object each flush |
| `handleNodeUpdate` | `WorkflowDefinition` | `{ nodes:[{id,type,position,config}], edges, metadata }` | replaces one node's `config` wholesale |
| `def` | `WorkflowDefinition` | same | **source of truth** (see §3) |
| `validateGraph` input | `WorkflowDefinition` | same | reads `n.config[...]` directly |
| `displayNodes` | `DraftNode[]` | `{ id, type, order, config }` | `order` derived from `topologicalOrder`; config passed through **unchanged** |
| `graphToLinearNodes` (save) | `DraftNode[]` | `{ id, type, order, config:{ ...config, _graph:{position,next} } }` | adds the runtime‑ignored `_graph` sidecar |
| persisted `draftNodes` | JSON | array | after server `restampBrand` + `stampRewardFromNegotiation` |
| reload | `WorkflowDefinition` | via `linearNodesToGraph` → `splitSidecar` strips `_graph` | config panel/summary/validator never see `_graph` |

---

## 3. Source of Truth

**The single source of truth in the editor is `def`: a `WorkflowDefinition`** held as
`localDef` in `WorkflowBuilder` (`WorkflowBuilder.tsx` line ~89):

```ts
const def = useMemo(() => localDef ?? linearNodesToGraph(serverNodes ?? []), [localDef, serverNodes]);
```

- **Local React state (form `useState`)** is *not* the source of truth — it's a transient
  input buffer that flushes into `def` on blur/change.
- **There is no Zustand store.** "Store" in the prompt maps to `localDef` (a `useState`).
- **`DraftNode[]`** is a *derived* view (`displayNodes`) and the *persistence* shape — not the
  editing truth.
- **Persisted draft / backend snapshot** is downstream of `def` (write path) and upstream on
  load (read path via `linearNodesToGraph`), but during an editing session `def` wins
  (`localDef ?? …`).

**What each consumer actually validates:**

| Consumer | Reads | Object |
|----------|-------|--------|
| Live graph validation (`validateGraph`) | `def.nodes[i].config` | `WorkflowDefinition` (in‑memory) |
| Node badge (`nodeWarning`) | `node.config` where `node` = a `displayNodes` `DraftNode` derived from `def` | derived `DraftNode` (same config object) |
| Summary card (`configSummary`) | same `node.config` | derived `DraftNode` |
| Config panel forms | seed from `node.config`; own `useState` thereafter | derived `DraftNode` → local state |
| Server publish/launch | `wf.draftNodes` / `version.nodeGraph` (persisted) | **reconstructed graph** via `buildGraph` |

So the FE validators and the summary **read the same underlying config object** (good — no
stale duplicate here). The divergence is in **which fields/rules** they apply, not which object
(see §8, §11). The backend validates a **reconstructed graph** built from the persisted flat
array (edges from `_graph.next`, or `order`‑implicit for legacy drafts).

---

## 4. Follow‑Up Node Deep Dive

Tracing **only** the Follow‑Up node.

### Where its config is **created**
- **From a template** (workflow creation): `server/src/templates/index.ts` → `hybridNodes` /
  `affiliateNodes` / `fixedFeeNodes`, the `FOLLOW_UP` entry:
  ```ts
  { id:"node-followup", type:"FOLLOW_UP", order:1,
    config:{ intervals:[3,5], intervalUnit:"days", maxCount:2, bodyTemplate:"…", stopOnReply:true } }
  ```
- **From the palette** (new node dropped in the builder): `web/src/workflow/nodeDefaults.ts` →
  `defaultConfigFor("FOLLOW_UP")`:
  ```ts
  { intervals:[3,5], intervalUnit:"days", maxCount:2, bodyTemplate:"Hi {{creatorName}}, …", stopOnReply:true }
  ```
  Both defaults include a **non‑empty `bodyTemplate`**, so a fresh Follow‑Up is valid.

### Where its config is **updated**
- `web/src/components/builder/NodeConfigPanel.tsx` → `FollowUpForm` (lines 338‑487).
  Local state: `intervals`, `unit`, `maxCount`, `body`, `stopOnReply`. `flush()` emits:
  ```ts
  onUpdate(nodeId, { intervals, intervalUnit: unit, maxCount, bodyTemplate: body, stopOnReply, ...over })
  ```
  → `WorkflowBuilder.handleNodeUpdate` replaces the node's config in `def`.

### Where it is **stored**
- In memory: `def.nodes[i].config` (source of truth).
- Persisted: `graphToLinearNodes` → `saveDraft` → `PUT /:id/draft` → server `restampBrand`
  (injects `brandName`/`senderName`/etc. — **does not touch `bodyTemplate`/`intervals`**) →
  `draftNodes` JSON column.

### Where the **summary card** reads from
- `web/src/components/builder/nodeMeta.ts` → `configSummary` (FOLLOW_UP branch, lines 85‑93):
  ```ts
  const count = cfg["maxCount"]; const unit = cfg["intervalUnit"]; const intervals = cfg["intervals"];
  if (count && intervals) return `${count} follow-up… · every ${intervals.join(", ")} ${unit ?? "days"}`;
  return "Not configured";
  ```
  Reads **`maxCount`**, **`intervalUnit`**, **`intervals`**. **Does NOT read `bodyTemplate`.**
- Chips: `configChips` (FOLLOW_UP) reads `maxCount`, `intervalUnit`, `stopOnReply`.

### Where **validation** reads from
- **Node badge heuristic** `nodeMeta.ts` → `nodeWarning` (FOLLOW_UP, lines 212‑216):
  ```ts
  if (!cfg["bodyTemplate"]) return "Missing follow-up body";
  if (!Array.isArray(cfg["intervals"]) || cfg["intervals"].length === 0) return "No intervals set";
  ```
  Reads **`bodyTemplate`** and **`intervals`**.
- **Graph validator** `graphValidation.ts` → `validateNodeConfig` (FOLLOW_UP, lines 356‑361):
  ```ts
  if (!isNonEmptyString(cfg["bodyTemplate"])) → "MISSING_FOLLOWUP_BODY"
  if (!Array.isArray(cfg["intervals"]) || cfg["intervals"].length === 0) → "MISSING_INTERVALS"
  ```
  Reads **`bodyTemplate`** and **`intervals`**.
- **Backend** `server/src/validation/graphValidation.ts` → `validateNodeConfig` (FOLLOW_UP): same
  two fields, same codes.

### Compare both paths

| Concern | Summary (`configSummary`) | Warning/Validator (`nodeWarning` / `validateNodeConfig`) |
|---------|---------------------------|-----------------------------------------------------------|
| Reads `bodyTemplate` | **No** | **Yes** (required) |
| Reads `intervals` | Yes (truthiness) | Yes (`Array` + non‑empty) |
| Reads `maxCount` | Yes (gates the whole line) | No |
| "Empty/invalid" output | `"Not configured"` (only if `maxCount` **or** `intervals` falsy) | `"Missing follow-up body"` / `MISSING_FOLLOWUP_BODY`, or `"No intervals set"` / `MISSING_INTERVALS` |

**Mismatch:** the summary is satisfied by `maxCount` + `intervals` and ignores `bodyTemplate`;
the warning/validator *require* `bodyTemplate`. Same object, different fields → they can disagree.

---

## 5. Validation Rules (per node type)

### 5.1 Config rules — the authoritative source: `validateNodeConfig`

Two mirrored copies:
- FE: `web/src/workflow/graphValidation.ts` → `validateNodeConfig` (lines 346‑382)
- BE: `server/src/validation/graphValidation.ts` → `validateNodeConfig`

| Node type | Required fields | Optional fields | Rule → Error code |
|-----------|-----------------|-----------------|-------------------|
| `INITIAL_OUTREACH` | `subjectTemplate`, `bodyTemplate` (non‑empty strings) | `delaySeconds`, brand fields | empty subject → `MISSING_SUBJECT`; empty body → `MISSING_BODY` |
| `FOLLOW_UP` | `bodyTemplate` (non‑empty), `intervals` (non‑empty array) | `intervalUnit`, `maxCount`, `stopOnReply` | no body → `MISSING_FOLLOWUP_BODY`; empty intervals → `MISSING_INTERVALS` |
| `NEGOTIATION` | `minBudget` (number), `maxBudget` (number) | `maxRounds`, `approvalMode`, `commissionRate` | missing/non‑numeric → `MISSING_BUDGET`; `max < min` → `INVALID_BUDGET_RANGE` |
| `REPLY_DETECTION` | — (none) | `lowConfidenceThreshold`, `manualReviewOnLowConfidence` | none |
| `REWARD_SETUP` | — | `commissionRate`, `deliverables`, `timeline` | none |
| `PAYMENT_INFO` | — | (form‑derived at runtime) | none |
| `CONTENT_BRIEF` | `briefFileRef` (non‑empty — the uploaded PDF) | `briefFileName`, `referralLink`, `creatorNotes` | missing → `MISSING_BRIEF_ATTACHMENT` |
| `END` | — | — | none |
| `IMPORT_CREATOR_LIST` | — | — | none |

### 5.2 Structural rules (graph‑level) — `validateGraph` / `validateWorkflowGraph`

| Rule | Error code |
|------|-----------|
| Non‑empty graph | `EMPTY_GRAPH` |
| Node has an id | `MISSING_NODE_ID` |
| Unique node ids | `DUPLICATE_NODE_ID` |
| Known node type | `UNKNOWN_NODE_TYPE` |
| Edge endpoints exist | `DANGLING_EDGE` |
| No self‑loops | `SELF_LOOP` |
| No duplicate edges | `DUPLICATE_EDGE` |
| No fully isolated nodes | `DISCONNECTED_NODE` |
| Exactly one start | `NO_START_NODE` / `MULTIPLE_START_NODES` |
| Start type ∈ {IMPORT, INITIAL_OUTREACH} | `INVALID_START_TYPE` |
| ≥1 terminal | `NO_TERMINAL_NODE` |
| Terminal type ∈ {REWARD_SETUP, PAYMENT_INFO, CONTENT_BRIEF, END} | `INVALID_TERMINAL_TYPE` |
| ≤1 outgoing / ≤1 incoming per node (linear) | `INVALID_BRANCHING` / `INVALID_MERGE` |
| No cycles | `CYCLE_DETECTED` |
| All nodes reachable from start | `UNREACHABLE_NODE` |
| Phase(target) ≥ phase(source) on every edge | `INVALID_PHASE_ORDER` |

Phase order: `IMPORT(0) < OUTREACH/FOLLOW_UP(1) < REPLY_DETECTION(2) < NEGOTIATION(3) <
REWARD_SETUP/END(4) < PAYMENT_INFO(5) < CONTENT_BRIEF(6)`.

### 5.3 Node‑badge heuristic (`nodeWarning`) — SEPARATE, FE‑only

`web/src/components/builder/nodeMeta.ts` (lines 205‑234). Covers only
`INITIAL_OUTREACH`, `FOLLOW_UP`, `NEGOTIATION`, `CONTENT_BRIEF`. Returns a **string**, not a
code. Rules mostly match `validateNodeConfig` but with subtle differences (e.g. `nodeWarning`
uses `!cfg["subjectTemplate"]` truthiness vs the validator's `isNonEmptyString`; a
whitespace‑only string is "present" to `nodeWarning` but "empty" to the validator).

### 5.4 Legacy validator (`validateNodeGraph`) — BE, still merged in

`server/src/templates/index.ts` → `validateNodeGraph`. Flat‑list rules: array non‑empty,
unique ids, unique `order`, valid types, must include `INITIAL_OUTREACH`, must include a
terminal (`REWARD_SETUP` or `END`), and Content‑Brief PDF if a `CONTENT_BRIEF` node exists.
In **full** mode the route merges its messages with the graph validator's; in
**structural‑only** mode it is skipped.

### 5.5 Field‑level inline (cosmetic) — `NodeConfigPanel`

`invalid={!subject.trim()}`, `invalid={!body.trim()}`, `budgetInvalid = maxBudget < minBudget`.
Red outlines only; **never block** save/publish (the value still flushes).

### 5.6 Two modes: full vs structural‑only

`server/src/routes/workflows.ts` → `validateWorkflowNodes(nodes, { structuralOnly? })`:
- **full** (publish, validate, draft‑save): structural rules **+** `validateNodeConfig` **+**
  legacy `validateNodeGraph`.
- **structural‑only** (launch): structural rules only; config + legacy skipped, so an
  immutable published version (already gated at publish) still launches even if it uses
  alternate config field names.

---

## 6. How a Validation Error is Produced (trace)

Follow‑Up with `intervals` + `maxCount` but **no `bodyTemplate`**:

```
config = { intervals:[3,5], intervalUnit:"days", maxCount:2, stopOnReply:true }   // no bodyTemplate
  │
  ▼  (A) GRAPH VALIDATOR path — drives the pill + red ring
validateGraph(def)
  └─ validateNodeConfig(node)   [graphValidation.ts:356]
       └─ !isNonEmptyString(cfg["bodyTemplate"])  → true
       └─ returns { code:"MISSING_FOLLOWUP_BODY", message:"Follow-Up needs an email body.",
                    nodeId:node.id, severity:"error" }
  │
  ▼
ValidationResult.errors includes that issue → validation.valid = false
  │
  ├─► WorkflowBuilder passes issues to <GraphCanvas issues={validation.errors} />
  │      GraphCanvas.buildRfNodes: invalidNodeIds.has(node.id) → data.forceInvalid = true
  │
  ▼  (B) NODE HEURISTIC path — drives the card text + "Needs configuration"
BuilderNode:
  warning = nodeWarning(node)   [nodeMeta.ts:212] → "Missing follow-up body"
  invalid = (warning !== null) || forceInvalid   → true
  card body text = warning ?? summary  → "Missing follow-up body"
  footer → "⚠ Needs configuration"
```

Two independent computations reach the same conclusion here **only because both check
`bodyTemplate`**. When they check different fields, they diverge (see §8/§11).

---

## 7. UI Mapping — where `"Needs configuration"` comes from

- **String literal:** `web/src/components/builder/BuilderNode.tsx` line 176 —
  `<span aria-hidden>⚠</span> Needs configuration`, rendered **only when `invalid` is true**.
- **`invalid` is:** `warning !== null || !!forceInvalid` (line 39), where
  - `warning = nodeWarning(node)` — the FE heuristic (`nodeMeta.ts`), and
  - `forceInvalid` — set by `GraphCanvas` when the node's id appears among the graph
    validator's `error` issues.
- **What triggers it:**
  - Any non‑null `nodeWarning` (missing subject/body/intervals/budget/brief), **or**
  - Any graph‑validator error tagged with this `nodeId` (config **or** structural — e.g.
    `INVALID_PHASE_ORDER`, `UNREACHABLE_NODE`, `INVALID_TERMINAL_TYPE`).
- **Why specific errors aren't shown on the node:** the badge is a **single generic string**.
  The **specific** message only appears:
  - in the **card body** as `warning ?? summary` — i.e. only the `nodeWarning` string, and only
    for the four types `nodeWarning` covers; a purely *structural* error (e.g.
    `INVALID_PHASE_ORDER`) sets `forceInvalid` → shows `"Needs configuration"` but the body
    still shows the **summary** (no specific reason on the node), or
  - in the **validity pill tooltip** (`WorkflowBuilder` → `ValidityPill`) and the **publish
    error banner**, which list the full `validation.errors` messages.

So a structural error red‑rings the node and prints "Needs configuration" without naming the
cause *on the node* — the cause is only in the pill tooltip / publish banner.

---

## 8. Summary vs Validator — per‑node comparison

`configSummary` (card line) vs `validateNodeConfig`/`nodeWarning` (validity). **Field names in
bold where they differ.**

| Node | Summary reads | Validator/warning reads | Mismatch? |
|------|---------------|--------------------------|-----------|
| `INITIAL_OUTREACH` | `subjectTemplate` (shows it; else "No subject set") | `subjectTemplate` **+ `bodyTemplate`** | **Yes** — summary ignores `bodyTemplate`; a subject‑only node summarizes fine but fails on `MISSING_BODY` |
| `FOLLOW_UP` | `maxCount`, `intervalUnit`, `intervals` | **`bodyTemplate`** + `intervals` | **Yes** — summary ignores `bodyTemplate` and *requires `maxCount`*; validator ignores `maxCount` and requires `bodyTemplate` |
| `REPLY_DETECTION` | `lowConfidenceThreshold` | (no config rule) | Summary can say "Not configured" while validator considers it **valid** |
| `NEGOTIATION` | `minBudget`, `maxBudget`, `maxRounds` | `minBudget`, `maxBudget` (+ `max<min`) | Partial — summary needs `min`&`max` defined to render, and shows `maxRounds`; validator adds the `max<min` rule |
| `REWARD_SETUP` | `commissionRate` | (no rule) | Presentational only |
| `PAYMENT_INFO` | static text | (no rule) | — |
| `CONTENT_BRIEF` | `briefFileRef` (truthiness) | `briefFileRef` (`isNonEmptyString`) | Minor — whitespace‑only ref: summary "uploaded", validator "missing" |
| `END` / `IMPORT_CREATOR_LIST` | static / "entry point" | (no rule) | — |

**The two clearest, user‑visible mismatches** (both the shape the prompt called out):
- **Follow‑Up:** *Summary reads `maxCount`/`intervals`; validator reads `bodyTemplate`/`intervals`.*
- **Initial Outreach:** *Summary reads `subjectTemplate`; validator also requires `bodyTemplate`.*

---

## 9. Bug Review (senior‑engineer pass)

Verified against the code, not assumed.

### 9.1 🟠 Duplicate source of truth for config‑validity (root of the reported symptom)
There are **two config‑validity engines** on the FE that are hand‑kept‑in‑sync:
`nodeMeta.nodeWarning` (badge) and `graphValidation.validateNodeConfig` (pill/gate). They read
the same object but apply their own field lists and their own emptiness test (`truthiness` vs
`isNonEmptyString`). A whitespace‑only `bodyTemplate` is **valid** to `nodeWarning`
(`!cfg["bodyTemplate"]` is `false`) but **invalid** to the validator (`isNonEmptyString`
trims). → Node shows *no* warning while the publish gate fails. **Real inconsistency.**

### 9.2 🟠 Summary vs validity field mismatch (Follow‑Up, Initial Outreach)
As detailed in §4/§8: the card summary and the validity check consult different fields, so a
node can present a healthy summary and still be flagged. **This is the direct cause of “valid
summary but Needs configuration.”** (See §11.)

### 9.3 🟡 Generic badge hides structural causes
A structural error (`INVALID_PHASE_ORDER`, `UNREACHABLE_NODE`, `INVALID_TERMINAL_TYPE`, etc.)
sets `forceInvalid` → node shows `"Needs configuration"` **even though nothing about that node's
*config* is wrong.** The wording is misleading for structural problems, and the specific reason
is only in the pill tooltip / publish banner, not on the node.

### 9.4 🟡 Config‑panel `useEffect` re‑seeds on `nodeId` only
`FollowUpForm`/`InitialOutreachForm` `useEffect` deps are `[nodeId, …]` (Outreach) and
`[nodeId]` (Follow‑Up). If the **same node's** config changes *externally* (e.g. server
`restampBrand`/`stampRewardFromNegotiation` re‑injects fields after save, or an undo), the open
form won't re‑seed because `nodeId` didn't change. Edits are still flushed on blur, but the
form can momentarily show stale field values relative to `def`. **Low‑severity stale‑state
window**, not a data‑loss bug (flush replaces the whole config).

### 9.5 🟡 Values flush even when field‑invalid
`InitialOutreachForm.flush`/`FollowUpForm.flush` always call `onUpdate` regardless of
`invalid={…}`. So an empty subject/body **is persisted**; validity is enforced only at the
pill/publish layer. Intended (draft‑friendly), but worth noting: the inline red outline does
not prevent saving the invalid value.

### 9.6 🟢 No `_graph` leakage into config validation
`splitSidecar` (in `linearNodesToGraph`) strips `_graph` before the config panel / summary /
validator ever see it, and `graphToLinearNodes` re‑adds it only on the persistence path. So the
sidecar never trips a config rule. **Verified safe.**

### 9.7 🟢 FE/BE config‑rule parity
`validateNodeConfig` is duplicated FE↔BE with identical fields/codes. They currently match. But
it's **manual duplication across two files** (plus a third heuristic in `nodeMeta`), so drift is
a standing risk — any rule change must touch all three.

### 9.8 🟢 Legacy vs graph terminal rule (benign redundancy)
Legacy `validateNodeGraph` still requires `INITIAL_OUTREACH` + a terminal and is merged in full
mode. The graph validator already enforces stricter versions; the merge de‑dupes messages. No
contradiction, just belt‑and‑suspenders.

### 9.9 🟢 Save race / empty‑graph wipe — already guarded
`doSave` refuses to persist an empty graph (guard added earlier), and the debounced save
serializes `def` (not stale form state). No re‑introduction of the earlier corruption path.

### Not found / not applicable
- **Validation not re‑running:** `validation` is a `useMemo` on `def`; every edit that changes
  `def` re‑runs it. ✅
- **Serialization dropping config:** `graphToLinearNodes` spreads `...node.config`; no field
  loss. ✅
- **Incorrect defaults:** template + `defaultConfigFor` both seed a non‑empty `bodyTemplate`
  and numeric budgets, so fresh nodes are valid. ✅

---

## 10. Validation Architecture Diagram

```
                         ┌───────────────────────────────────────────────────────────┐
 User edits a node ─────►│ NodeConfigPanel.tsx  (FollowUpForm / InitialOutreachForm …)│
                         │   local useState (subject/body/intervals…) ──flush()──►     │
                         └─────────────────────────────┬─────────────────────────────┘
                                                       │ onUpdate(nodeId, config)
                                                       ▼
                         ┌───────────────────────────────────────────────────────────┐
 Canvas edit ──────────►│ WorkflowBuilder.tsx                                          │
 (drag/connect/delete)  │   handleNodeUpdate / handleGraphChange → setLocalDef         │
                         │   def = localDef ?? linearNodesToGraph(serverNodes)  ◄──────┼── SOURCE OF TRUTH
                         └───────┬───────────────────────────────┬────────────────────┘
                                 │ def                            │ displayNodes (DraftNode[])
                                 ▼                                ▼
      ┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
      │ graphValidation.ts · validateGraph    │    │ nodeMeta.ts (per-node, SEPARATE)      │
      │  • structural rules                   │    │  • configSummary  (card line)         │
      │  • validateNodeConfig (config rules)  │    │  • configChips                        │
      │  → ValidationResult {errors[…]}       │    │  • nodeWarning    (badge string)      │
      └───────────────┬──────────────────────┘    └───────────────┬──────────────────────┘
                      │ issues                                     │ warning / summary
                      ▼                                            ▼
      ┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
      │ GraphCanvas.buildRfNodes              │    │ BuilderNode.tsx                       │
      │   data.forceInvalid = id ∈ errorIds   │───►│   invalid = warning!=null||forceInvalid│
      │ ValidityPill (tooltip = full messages)│    │   body = warning ?? summary           │
      └──────────────────────────────────────┘    │   footer → "⚠ Needs configuration"    │
                                                   └──────────────────────────────────────┘
                      │
                      │ scheduleSave (1s) → doSave → graphToLinearNodes (adds _graph) → saveDraft
                      ▼
      ┌───────────────────────────────────────────────────────────────────────────────┐
      │ server/src/routes/workflows.ts                                                  │
      │   PUT  /:id/draft   → validateWorkflowNodes(full)   [SOFT — saves regardless]   │
      │        restampBrand + stampRewardFromNegotiation → draftNodes (JSON)            │
      │   POST /:id/validate→ validateWorkflowNodes(full)   [read-only result]          │
      │   POST /:id/publish → validateWorkflowNodes(full)   [HARD GATE — 422]           │
      │   POST /:id/launch  → validateWorkflowNodes(structuralOnly) [HARD GATE — 422]   │
      │        validateWorkflowNodes = validateWorkflowGraph(+ legacy validateNodeGraph)│
      │        buildGraph: edges from _graph.next, or order-implicit for legacy drafts  │
      └───────────────────────────────────────────────────────────────────────────────┘
```

**Files involved (complete list):**
- `web/src/components/builder/NodeConfigPanel.tsx` — config editing + inline field validity
- `web/src/components/builder/WorkflowBuilder.tsx` — source of truth (`def`), live validation, publish/launch orchestration
- `web/src/components/builder/GraphCanvas.tsx` — maps validator issues → `forceInvalid` ring
- `web/src/components/builder/BuilderNode.tsx` — renders `"Needs configuration"`
- `web/src/components/builder/nodeMeta.ts` — `configSummary`, `configChips`, `nodeWarning` (the **separate** heuristic)
- `web/src/workflow/graphValidation.ts` — `validateGraph` + `validateNodeConfig` (FE authority)
- `web/src/workflow/graphModel.ts` — `linearNodesToGraph` / `graphToLinearNodes` / `splitSidecar` / `topologicalOrder`
- `web/src/workflow/nodeDefaults.ts` — `defaultConfigFor` (fresh‑node config)
- `web/src/api/builderClient.ts` — `saveDraft`, `validateWorkflow`, `publishWorkflow`, `launchWorkflow`
- `server/src/routes/workflows.ts` — `validateWorkflowNodes` + the four route gates
- `server/src/validation/graphValidation.ts` — `validateWorkflowGraph` + `validateNodeConfig` (BE mirror)
- `server/src/templates/index.ts` — templates + legacy `validateNodeGraph`

---

## 11. Why a node shows a valid summary but still says “Needs configuration”

**This is a real, reproducible mismatch — not a guess. Root cause identified.**

### The exact code path
For a **Follow‑Up** node whose config is `{ maxCount:2, intervals:[3,5], intervalUnit:"days" }`
but with **no (or whitespace‑only) `bodyTemplate`**:

1. **Summary is happy.** `configSummary` (`nodeMeta.ts:85‑93`) checks `if (count && intervals)`
   using `maxCount` + `intervals` — both present — so it renders
   `"2 follow-ups · every 3, 5 days"`. It **never looks at `bodyTemplate`.**

2. **Badge fires.** `nodeWarning` (`nodeMeta.ts:212‑213`) does `if (!cfg["bodyTemplate"]) return
   "Missing follow-up body"`. With no body, it returns a non‑null string.

3. **`BuilderNode`** computes `invalid = warning !== null || forceInvalid` → `true`
   (`BuilderNode.tsx:39`) and renders `"⚠ Needs configuration"` (`BuilderNode.tsx:176`).

So the card shows a **valid‑looking cadence summary** *and* the **"Needs configuration"**
footer simultaneously, because **the summary and the warning read different fields of the same
config object.**

### The precise root cause
> `configSummary` and `nodeWarning` (both in `nodeMeta.ts`) are **two independent readers of
> the same config with non‑overlapping field requirements.** The summary's validity signal is
> gated on `maxCount`/`intervals`; the badge's validity signal is gated on `bodyTemplate`.
> There is **no shared "is this node valid?" function** feeding both — the summary doesn't call
> the validator, and the validator doesn't inform the summary text. Whenever the missing/blank
> field is one the summary doesn't inspect (Follow‑Up `bodyTemplate`, Initial Outreach
> `bodyTemplate`), you get *valid summary + "Needs configuration."*

A second, subtler variant of the same root cause: even when the fields overlap, the **emptiness
test differs** — `nodeWarning` uses truthiness (`!cfg["bodyTemplate"]`) while
`validateNodeConfig` uses `isNonEmptyString` (which trims). A `bodyTemplate` of `"   "` passes
`nodeWarning` (no badge) but fails the graph validator (`forceInvalid` → badge). Same visual
symptom, opposite direction, same underlying design flaw: **duplicated, drifting validity
logic.**

### The fix (not applied — this doc is analysis only)
Have **one** validity function drive everything: make `nodeWarning` (and ideally the summary's
"is this complete?" signal) **derive from `validateNodeConfig`/`validateGraph`** instead of
re‑implementing rules. Concretely: map the per‑node `ValidationIssue`s already computed in
`WorkflowBuilder` down to each `BuilderNode` (they're already passed to `GraphCanvas` as
`issues`) and render the **specific** message + badge from *that* single source, retiring the
independent `nodeWarning` field checks. That removes both the field‑mismatch and the
emptiness‑test‑mismatch classes at once.
```
```
