---
name: reclone-campaign
description: Reclone the latest campaign in the local Pluvus dev DB — create a fresh copy of its campaign fields, delete the original, attach a hybrid workflow, set the negotiation band (200–500, 2 rounds), attach a Desktop brief PDF, publish, and enroll + launch one creator. Use when the user says "reclone the campaign", "reclone latest campaign", "reset the current campaign", or wants a clean restart of the most recently created campaign ready to run.
---

# Reclone latest campaign

Recreates the **most recently created** campaign as a clean copy, deletes the
original, attaches a fresh **hybrid** workflow, and takes it all the way to a
**live run**: it stamps the negotiation band (floor 200 / ceiling 500 /
maxRounds 2), attaches the newest Campaign Brief PDF from the Desktop to the
Content Brief node, publishes the workflow, and enrolls + launches one creator
(`ayushgade23@gmail.com`). This is a reset: only the campaign's own fields are
cloned — no old workflows, execution instances, messages, or negotiation state
carry over. The original (and all its dependent rows) is cascade-deleted.

## When to use

Invoke when the user asks to "reclone the campaign", "reclone the latest
campaign", "reset the current campaign", or otherwise wants a clean restart of
the newest campaign with a fresh hybrid workflow.

## Prerequisites

- The dev server must be running (`npm run dev` in `server/`, default port `3001`).
  Override the port with the `PORT` env var if needed.
- "Latest campaign" = the first item returned by `GET /campaigns`, which the
  server orders by `createdAt` descending. The helper relies on this ordering.

## How it works

The bundled helper `scripts/reclone.mjs` performs the whole flow against the
running server and prints each step:

1. `GET /campaigns` → picks index 0 (the latest campaign).
2. `POST /campaigns` with the original's fields → creates the clone.
3. `DELETE /campaigns/{originalId}` → cascade-deletes the original.
4. `POST /campaigns/{cloneId}/workflows` with `templateKey: "hybrid"` →
   attaches a hybrid workflow (status `DRAFT`).
5. `GET /workflows/{id}` → read `draftNodes`, then patch:
   - the **NEGOTIATION** node config → `minBudget: 200`, `maxBudget: 500`,
     `maxRounds: 2` (override via `MIN_BUDGET` / `MAX_BUDGET` / `MAX_ROUNDS`);
   - the **CONTENT_BRIEF** node config → `briefFileRef` from the uploaded PDF.
6. `POST /uploads` (multipart) → uploads the **newest `*.pdf` on the Desktop**
   (`C:\Users\<you>\Desktop`, override via `DESKTOP_DIR`) and returns its
   reference. Required because publish validation rejects a Content Brief node
   with no PDF (`MISSING_BRIEF_ATTACHMENT`).
7. `PUT /workflows/{id}/draft` with the patched `nodes` → saves the graph.
8. `POST /workflows/{id}/publish` → validates + freezes an immutable version.
9. `POST /creators/import` with one row → upserts the creator (deduped on
   email, so it **reuses** an existing `ayushgade23@gmail.com` or creates it).
10. `POST /workflows/{id}/enroll` with the creator id → creates one ENROLLED
    instance on the published version.
11. `POST /workflows/{id}/launch` → fires outreach for the ENROLLED instance
    (skip with `--no-launch` to leave it ENROLLED).

The cloned campaign fields are: `name`, `brand`, `objective`, `notes`,
`notifyEmail`, `brandDescription`, `deliverables`, `timeline`,
`rewardDescription`, `shipsPhysicalProduct`. The new workflow is named
`"{campaign name} Outreach"` and ends **PUBLISHED**, with one creator enrolled
and (unless `--no-launch`) launched.

**`notifyEmail` is forced to the escalation inbox** `gadeayush23@gmail.com`
(override with the `ESCALATION_EMAIL` env var), regardless of the source
campaign's value. This is the address that receives manual-escalation /
brand-decision emails when a run parks in `AWAITING_BRAND_DECISION`. It is kept
deliberately distinct from the creator inbox and from the Nylas sender mailbox
(`notbaka2303@gmail.com`) — a brand email sent from that mailbox *to itself*
skips the Gmail Inbox, which is why a separate escalation inbox is required.

## Steps

1. Confirm the dev server is reachable:
   `Invoke-RestMethod http://localhost:3001/health` (PowerShell) — expect `status: ok`.
   If it's down, tell the user to start it with `npm run dev` in `server/` and stop.

2. **This is destructive** — it deletes the original campaign. Briefly confirm
   with the user which campaign will be affected (name it from step 1's list) if
   there's any ambiguity or if they haven't just asked for it explicitly.

3. **A Campaign Brief PDF must be on the Desktop.** The helper uploads the
   newest `*.pdf` from `C:\Users\<you>\Desktop` (override with `DESKTOP_DIR`).
   If none is present it stops with a clear message — publish requires it. Tell
   the user to drop a PDF there if the run fails on this step.

4. Run the helper from the repo root:
   ```
   node .claude/skills/reclone-campaign/scripts/reclone.mjs
   ```
   Pass a custom port with `PORT=3005 node ...` if the server isn't on 3001.

5. Report the result: old id → new campaign id, the new workflow id + published
   version, the negotiation band, the brief PDF reference, and the enrolled +
   launched creator. Once launched, outreach fires within ~seconds — offer to
   watch the run (poll `/observability/instances`).

## Notes / variations

- **Different template**: pass a template key as the first arg, e.g.
  `node .claude/skills/reclone-campaign/scripts/reclone.mjs affiliate`
  (valid keys: `affiliate`, `hybrid`, `fixed_fee`; default `hybrid`).
- **Keep the original**: pass `--keep` to skip the delete step
  (`node ... hybrid --keep`).
- **No workflow**: pass `--no-workflow` to clone + delete only (skips patch /
  publish / enroll / launch).
- **Don't launch**: pass `--no-launch` to patch + publish + enroll but leave the
  instance ENROLLED (you launch manually later).
- **Override the setup** via env vars: `MIN_BUDGET` / `MAX_BUDGET` / `MAX_ROUNDS`
  (negotiation band, default `200` / `500` / `2`), `CREATOR_EMAIL` /
  `CREATOR_NAME` / `CREATOR_PLATFORM` (the enrolled creator, default
  `ayushgade23@gmail.com` / `Ayush Gade` / `Instagram`), `DESKTOP_DIR` (where the
  brief PDF is found), `ESCALATION_EMAIL` (brand-decision inbox).
- The creator is **upserted** (deduped on email), so re-running reuses the same
  `ayushgade23@gmail.com` record rather than creating duplicates.
- The helper uses only Node's built-ins (`fetch`, `FormData`, `Blob`, `fs`) — no
  dependencies, no DB access; everything goes through the server's REST API so
  the same cascade-delete and validation logic applies.
