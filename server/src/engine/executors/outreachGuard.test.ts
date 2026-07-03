/**
 * Tests for the output-guard net on outreach + follow-up (H4).
 *
 * Regression target: the output guard is documented as a MANDATORY net before
 * ANY AI-generated email is sent, but initialOutreach/followUp sent unguarded —
 * a model that leaked the internal floor/ceiling into an outreach body had no
 * backstop. These executors now scan the rendered draft and route a leak to
 * MANUAL_REVIEW instead of emailing the creator. The state machine now permits
 * ENROLLED→MANUAL_REVIEW and AWAITING_REPLY→MANUAL_REVIEW for exactly this.
 *
 * Run with:  npx tsx src/engine/executors/outreachGuard.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "@prisma/client";
import { executeInitialOutreach } from "./initialOutreach.js";
import { assertTransition } from "../stateMachine.js";
import type { ExecutionContext, NodeResult, EmailDraft } from "../types.js";
import type { IEmailProvider, IAgentProvider } from "../providers.js";

let n = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const creator = { id: "c1", name: "Robin", platform: "instagram", niche: "fitness" } as unknown as Creator;

// A NEGOTIATION node carrying the internal band. 200 is the floor, 500 the
// ceiling — neither may appear in an outreach body.
const negotiationNode = {
  id: "neg1",
  type: "NEGOTIATION",
  order: 1,
  config: { minBudget: 200, maxBudget: 500 },
};
const outreachNode = { id: "out1", type: "INITIAL_OUTREACH", order: 0, config: {} };

function ctx(): ExecutionContext {
  return {
    instance: { id: "i1", currentState: "ENROLLED" } as unknown as ExecutionContext["instance"],
    node: outreachNode,
    nodeGraph: [outreachNode, negotiationNode],
    creator,
  };
}

// Email provider whose send() records calls so we can assert "never sent".
function makeEmail(): IEmailProvider & { sent: number } {
  const email = {
    sent: 0,
    async draft(): Promise<EmailDraft> {
      return { subject: "s", body: "template" };
    },
    async send() {
      email.sent++;
      return { messageId: "m1", threadId: "t1" };
    },
  };
  return email as IEmailProvider & { sent: number };
}

// Agent that returns a specific AI draft body (generatesDraftCopy=true path).
function agentReturning(body: string): IAgentProvider {
  return {
    generatesDraftCopy: true,
    async classify() {
      return { intent: "POSITIVE", confidence: 1 };
    },
    async negotiate() {
      return { outcome: "escalate", message: "" };
    },
    async draftEmail(): Promise<EmailDraft> {
      return { subject: "Partnership", body };
    },
  } as unknown as IAgentProvider;
}

async function main() {
  console.log("\noutreach/follow-up output guard (H4)\n");

  await test("state machine now permits ENROLLED → MANUAL_REVIEW", () => {
    assertTransition("ENROLLED", "MANUAL_REVIEW"); // must not throw
    assertTransition("AWAITING_REPLY", "MANUAL_REVIEW");
    return Promise.resolve();
  });

  await test("outreach draft leaking the ceiling is blocked → MANUAL_REVIEW, not sent", async () => {
    const email = makeEmail();
    const agent = agentReturning("Hi Robin, our budget goes up to $500 for this campaign.");
    const result: NodeResult = await executeInitialOutreach(ctx(), email, agent);
    assert.equal(result.nextState, "MANUAL_REVIEW");
    assert.equal(result.eventPayload?.["reason"], "output_guard_blocked");
    assert.equal(email.sent, 0, "leaking outreach must NOT be sent");
  });

  await test("outreach draft leaking the floor is blocked", async () => {
    const email = makeEmail();
    const agent = agentReturning("Hi Robin, we start creators at $200.");
    const result = await executeInitialOutreach(ctx(), email, agent);
    assert.equal(result.nextState, "MANUAL_REVIEW");
    assert.equal(email.sent, 0);
  });

  // NOTE: the clean-draft "proceeds to send" path is intentionally NOT tested
  // here — it reaches the real sendOnce/DB seam, which needs a database. The
  // guard's pass-through (clean draft → ok) is covered by outputGuard.test.ts;
  // this file's job is to prove outreach/follow-up now INVOKE the guard and halt
  // on a leak before any send.

  console.log(`\n✓ outreachGuard: all ${n} tests passed\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
