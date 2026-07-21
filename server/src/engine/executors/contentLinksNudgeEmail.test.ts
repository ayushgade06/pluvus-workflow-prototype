/**
 * Unit tests for the content-links nudge email renderer. Pure — no DB. Run:
 *   npx tsx src/engine/executors/contentLinksNudgeEmail.test.ts
 */

import assert from "node:assert/strict";
import { renderContentLinksNudgeEmail } from "./contentLinksNudgeEmail.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\ncontentLinksNudgeEmail\n");

const draft = () => renderContentLinksNudgeEmail({ creatorName: "Ada", senderName: "Pluvus" });

test("greets the creator and asks for the content link(s)", () => {
  const { body } = draft();
  assert.match(body, /^Hi Ada,/);
  assert.match(body, /reply to this email with the link\(s\)/i);
});

test("subject threads onto the campaign brief", () => {
  assert.equal(draft().subject, "Re: Your Campaign Brief");
});

test("signs off as the sender", () => {
  assert.match(draft().body, /Best,\nPluvus$/);
});

console.log(`\n${n} passed\n`);
