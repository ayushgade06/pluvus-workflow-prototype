---
name: reclone-campaign
description: Reclone the latest campaign in the local Pluvus dev DB — create a fresh copy of its campaign fields, delete the original, then attach a hybrid workflow. Use when the user says "reclone the campaign", "reclone latest campaign", "reset the current campaign", or wants a clean restart of the most recently created campaign.
---

# Reclone latest campaign

Recreates the **most recently created** campaign as a clean copy, deletes the
original, and attaches a fresh **hybrid** workflow. This is a reset: only the
campaign's own fields are cloned — no workflows, execution instances, messages,
or negotiation state carry over. The original (and all its dependent rows) is
cascade-deleted.

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
5. `GET /campaigns` again → verifies exactly the clone remains.

The cloned campaign fields are: `name`, `brand`, `objective`, `notes`,
`notifyEmail`, `brandDescription`, `deliverables`, `timeline`,
`rewardDescription`, `shipsPhysicalProduct`. The new workflow is named
`"{campaign name} Outreach"` and left in `DRAFT` (not published).

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

3. Run the helper from the repo root:
   ```
   node .claude/skills/reclone-campaign/scripts/reclone.mjs
   ```
   Pass a custom port with `PORT=3005 node ...` if the server isn't on 3001.

4. Report the result: old id → new campaign id, the new workflow id, and that
   it's in `DRAFT`. Offer to publish the workflow if the user wants it runnable.

## Notes / variations

- **Different template**: pass a template key as the first arg, e.g.
  `node .claude/skills/reclone-campaign/scripts/reclone.mjs affiliate`
  (valid keys: `affiliate`, `hybrid`, `fixed_fee`; default `hybrid`).
- **Keep the original**: pass `--keep` to skip the delete step
  (`node ... hybrid --keep`).
- **No workflow**: pass `--no-workflow` to clone + delete only.
- The helper uses only Node's built-in `fetch`/`http` — no dependencies, no DB
  access; everything goes through the server's REST API so the same
  cascade-delete and validation logic applies.
