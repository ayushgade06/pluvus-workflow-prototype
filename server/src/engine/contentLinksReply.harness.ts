/**
 * Content-links reply harness — drives the CONTENT_LINKS_PENDING waiting state
 * (the merged Content Brief node parked after the payout form, awaiting the
 * creator's content-links reply) using mock providers and the real runtime (no
 * Redis/queues). Proves the spec's acceptance behavior:
 *
 *   - Link submission escalates: a reply with URLs → MANUAL_REVIEW, appends a
 *     CONTENT_LINKS_SUBMITTED event whose payload carries EXACTLY the submitted
 *     URLs, and records an escalation with the "content_links_submitted" reason.
 *   - No-link reply holds and nudges: a reply with no URLs stays in
 *     CONTENT_LINKS_PENDING and sends ONE nudge; a redelivered copy of the same
 *     reply does not double-send.
 *   - Opt-out precedence: an unsubscribe-style reply → OPTED_OUT, no nudge, even
 *     when URLs are present.
 *   - Idempotent escalation on repeat replies: after the first qualifying
 *     submission, a further reply produces no new transition or CONTENT_LINKS_
 *     SUBMITTED event (the instance is terminal MANUAL_REVIEW).
 *   - No decision side effects: content submission triggers no payout/ledger row.
 *
 * Creates its own throwaway workflow/version/creator/instance and deletes them on
 * exit, so it does not depend on or mutate seed data. Run:
 *   npx tsx src/engine/contentLinksReply.harness.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import assert from "node:assert/strict";
import type { InstanceState, InputJsonValue } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle.js";
import {
  brandNotifications,
  creators,
  events,
  executionInstances,
  messages,
  partnerships,
  paymentInfo,
  workflows,
  workflowVersions,
} from "../db/schema.js";
import { findInstanceById, listEventsByInstance, listMessagesByInstance } from "../db/index.js";
import { WorkflowRuntime } from "./runtime.js";
import { MockEmailProvider, MockAgentProvider } from "./providers.js";
import type { NodeSnapshot } from "./types.js";

function contentBriefGraph(): NodeSnapshot[] {
  return [
    { id: "node-import", type: "IMPORT_CREATOR_LIST", order: 0, config: {} },
    {
      id: "node-content-brief",
      type: "CONTENT_BRIEF",
      order: 1,
      config: { brandName: "Acme", senderName: "Acme" },
    },
  ];
}

async function state(instanceId: string): Promise<InstanceState> {
  const inst = await findInstanceById(instanceId);
  if (!inst) throw new Error(`instance ${instanceId} not found`);
  return inst.currentState;
}

async function countSubmittedEvents(instanceId: string): Promise<number> {
  const evs = await listEventsByInstance(instanceId, { type: "CONTENT_LINKS_SUBMITTED" });
  return evs.length;
}

let passed = 0;
function ok(label: string): void {
  passed++;
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  console.log("\nContent-links reply harness\n");
  const stamp = process.env["HARNESS_STAMP"] ?? "clr-harness";

  const runtime = new WorkflowRuntime(new MockEmailProvider(), new MockAgentProvider({}));

  const workflow = (await db.insert(workflows).values({
    name: `Content Links Harness ${stamp}`,
    status: "PUBLISHED",
  }).returning())[0]!;
  const version = (await db.insert(workflowVersions).values({
    workflowId: workflow.id,
    version: 1,
    nodeGraph: contentBriefGraph() as unknown as InputJsonValue,
  }).returning())[0]!;

  const created: string[] = [];
  async function freshInstance(email: string): Promise<string> {
    const creator = (await db.insert(creators).values({
      name: "Casey Creator",
      email,
      platform: "Instagram",
      niche: "fitness",
    }).returning())[0]!;
    const instance = (await db.insert(executionInstances).values({
      workflowVersionId: version.id,
      creatorId: creator.id,
      // Park directly in CONTENT_LINKS_PENDING on the Content Brief node — exactly
      // what executeContentBriefSubmission leaves behind after the payout form.
      currentState: "CONTENT_LINKS_PENDING",
      currentNodeId: "node-content-brief",
    }).returning())[0]!;
    created.push(instance.id);
    created.push(`creator:${creator.id}`);
    return instance.id;
  }

  try {
    // ── CASE 1: reply with URLs → escalate + CONTENT_LINKS_SUBMITTED(exact urls) ──
    {
      const id = await freshInstance(`casey-links-${stamp}@example.com`);
      const urls = ["https://instagram.com/reel/abc", "https://tiktok.com/@casey/video/9"];
      await runtime.handleContentLinksReply(id, {
        subject: "Re: Your Campaign Brief",
        body: `It's live! ${urls[0]} and also ${urls[1]}. Thanks!`,
        externalMessageId: `msg-links-${stamp}-1`,
      });

      assert.equal(await state(id), "MANUAL_REVIEW", "a reply with URLs must escalate to MANUAL_REVIEW");
      const submitted = await listEventsByInstance(id, { type: "CONTENT_LINKS_SUBMITTED" });
      const withUrls = submitted.find(
        (e) => Array.isArray((e.payload as Record<string, unknown> | null)?.["urls"]) &&
          ((e.payload as Record<string, unknown>)["urls"] as unknown[]).length > 0,
      );
      assert.ok(withUrls, "a CONTENT_LINKS_SUBMITTED event must be appended");
      assert.deepEqual(
        (withUrls!.payload as Record<string, unknown>)["urls"],
        urls,
        "the event payload must carry EXACTLY the submitted URLs, in order",
      );
      const flagged = await listEventsByInstance(id, { type: "MANUAL_REVIEW_FLAGGED" });
      const reason = flagged
        .map((e) => (e.payload as Record<string, unknown> | null)?.["reason"])
        .find((r) => r === "content_links_submitted");
      assert.equal(reason, "content_links_submitted", 'escalation reason must be "content_links_submitted"');
      // No payout/ledger side effects. Content submission must mint no Partnership
      // (and therefore no fee Obligation, which hangs off a partnership) and must
      // create no PaymentInfo row.
      const parts = await db.select().from(partnerships).where(eq(partnerships.instanceId, id));
      assert.equal(parts.length, 0, "content submission must NOT mint a Partnership");
      const pay = await db.select().from(paymentInfo).where(eq(paymentInfo.instanceId, id));
      assert.equal(pay.length, 0, "content submission must NOT create a PaymentInfo row");
      ok("reply with URLs → MANUAL_REVIEW + CONTENT_LINKS_SUBMITTED(exact urls) + reason, no ledger side effects");
    }

    // ── CASE 2: reply with no URLs → nudge + stay; redelivery does not double-send ──
    {
      const id = await freshInstance(`casey-nudge-${stamp}@example.com`);
      const extId = `msg-nudge-${stamp}-1`;
      await runtime.handleContentLinksReply(id, {
        subject: "Re: Your Campaign Brief",
        body: "Working on it, will send soon!",
        externalMessageId: extId,
      });
      assert.equal(await state(id), "CONTENT_LINKS_PENDING", "a no-URL reply must stay in CONTENT_LINKS_PENDING");
      const sentAfterFirst = (await listMessagesByInstance(id)).filter((m) => m.direction === "OUTBOUND").length;
      assert.equal(sentAfterFirst, 1, "exactly ONE nudge must be sent");

      // Redeliver the SAME inbound message (same externalMessageId): the persist is
      // idempotent and the nudge send is keyed on the message id, so no double-send.
      await runtime.handleContentLinksReply(id, {
        subject: "Re: Your Campaign Brief",
        body: "Working on it, will send soon!",
        externalMessageId: extId,
      });
      const sentAfterRedeliver = (await listMessagesByInstance(id)).filter((m) => m.direction === "OUTBOUND").length;
      assert.equal(sentAfterRedeliver, 1, "a redelivered copy of the same reply must NOT double-send the nudge");
      assert.equal(await state(id), "CONTENT_LINKS_PENDING", "still waiting after the redelivery");
      ok("no-URL reply → single nudge + stay CONTENT_LINKS_PENDING; redelivery does not double-send");
    }

    // ── CASE 3: opt-out precedence → OPTED_OUT, no nudge, even with URLs present ──
    {
      const id = await freshInstance(`casey-optout-${stamp}@example.com`);
      await runtime.handleContentLinksReply(id, {
        subject: "Re: Your Campaign Brief",
        body: "Please unsubscribe me. (here's a link anyway https://instagram.com/reel/zzz)",
        externalMessageId: `msg-optout-${stamp}-1`,
      });
      assert.equal(await state(id), "OPTED_OUT", "an unsubscribe reply must route to OPTED_OUT even with a URL present");
      const sent = (await listMessagesByInstance(id)).filter((m) => m.direction === "OUTBOUND").length;
      assert.equal(sent, 0, "an opt-out must NOT receive a nudge / auto-reply");
      assert.equal(await countSubmittedEvents(id), 0, "an opt-out must NOT append a CONTENT_LINKS_SUBMITTED event");
      ok("opt-out precedence → OPTED_OUT, no nudge, no submission event (even with a URL present)");
    }

    // ── CASE 4: idempotent escalation — a reply after MANUAL_REVIEW is a no-op ──
    {
      const id = await freshInstance(`casey-once-${stamp}@example.com`);
      await runtime.handleContentLinksReply(id, {
        subject: "Re: Your Campaign Brief",
        body: "live: https://youtube.com/watch?v=abc",
        externalMessageId: `msg-once-${stamp}-1`,
      });
      assert.equal(await state(id), "MANUAL_REVIEW", "first qualifying reply escalates");
      const submittedBefore = await countSubmittedEvents(id);

      // A second reply on the (now terminal) instance must be rejected by the
      // handler's state guard — the inbound worker would drop it via isTerminal, so
      // no new transition or CONTENT_LINKS_SUBMITTED event is produced.
      let threw = false;
      try {
        await runtime.handleContentLinksReply(id, {
          subject: "Re: Your Campaign Brief",
          body: "one more: https://instagram.com/reel/def",
          externalMessageId: `msg-once-${stamp}-2`,
        });
      } catch {
        threw = true;
      }
      assert.ok(threw, "handleContentLinksReply must reject a reply once the instance is terminal MANUAL_REVIEW");
      assert.equal(await state(id), "MANUAL_REVIEW", "state unchanged — escalated exactly once");
      assert.equal(
        await countSubmittedEvents(id),
        submittedBefore,
        "no additional CONTENT_LINKS_SUBMITTED event after the first escalation",
      );
      ok("idempotent escalation: a reply after MANUAL_REVIEW produces no new transition/event");
    }

    console.log(`\n${passed} checks passed\n`);
  } finally {
    // Tear down every row this harness created.
    const instanceIds = created.filter((c) => !c.startsWith("creator:"));
    const creatorIds = created.filter((c) => c.startsWith("creator:")).map((c) => c.slice("creator:".length));
    for (const id of instanceIds) {
      await db.delete(events).where(eq(events.instanceId, id));
      await db.delete(messages).where(eq(messages.instanceId, id));
      await db.delete(brandNotifications).where(eq(brandNotifications.instanceId, id));
      await db.delete(paymentInfo).where(eq(paymentInfo.instanceId, id));
      await db.delete(partnerships).where(eq(partnerships.instanceId, id));
      await db.delete(executionInstances).where(eq(executionInstances.id, id));
    }
    for (const id of creatorIds) {
      await db.delete(creators).where(eq(creators.id, id));
    }
    await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, workflow.id));
    await db.delete(workflows).where(eq(workflows.id, workflow.id));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
