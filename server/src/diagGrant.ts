/** One-off READ-ONLY diagnostic: inspect NYLAS_GRANT_ID bytes + the latest
 *  instance's outbound message row. No email is sent. Delete after use.
 *  Run: npx tsx src/diagGrant.ts */
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

import { prisma } from "./db/client.js";

async function main(): Promise<void> {
  const raw = process.env["NYLAS_GRANT_ID"] ?? "";
  console.log("\n=== NYLAS_GRANT_ID diagnostics ===");
  console.log(`  length:           ${raw.length}`);
  console.log(`  JSON (as read):   ${JSON.stringify(raw)}`);
  console.log(`  JSON (trimmed):   ${JSON.stringify(raw.trim())}`);
  console.log(`  differs when trimmed? ${raw !== raw.trim()}`);
  console.log(
    `  leading char codes: [${[...raw.slice(0, 4)].map((c) => c.charCodeAt(0)).join(", ")}]  ` +
      `(9=TAB, 32=SPACE, 10=LF, 13=CR)`,
  );
  console.log(`  API key present:  ${Boolean(process.env["NYLAS_API_KEY"])}`);
  console.log(`  EMAIL_PROVIDER:   ${process.env["EMAIL_PROVIDER"]}`);

  const inst = await prisma.executionInstance.findFirst({
    orderBy: { updatedAt: "desc" },
    include: { creator: true },
  });
  if (inst) {
    console.log(`\n=== Latest instance ===`);
    console.log(`  ${inst.id}  ${inst.currentState}  ${inst.creator.name} <${inst.creator.email}>`);
    const msg = await prisma.message.findFirst({
      where: { instanceId: inst.id, direction: "OUTBOUND" },
      orderBy: { createdAt: "desc" },
    });
    console.log(`\n=== Latest outbound message row ===`);
    if (msg) {
      console.log(`  subject:            ${JSON.stringify(msg.subject)}`);
      console.log(`  externalMessageId:  ${msg.externalMessageId ?? "NULL  <-- never finalized = send failed"}`);
      console.log(`  threadId:           ${msg.threadId ?? "NULL"}`);
      console.log(`  createdAt:          ${msg.createdAt.toISOString()}`);
    } else {
      console.log("  (no outbound row)");
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("diagGrant failed:", err);
  process.exit(1);
});
