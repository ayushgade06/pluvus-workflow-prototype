import { asc, desc, eq, inArray } from 'drizzle-orm';
import { db, pool } from './dist/db/drizzle.js';
import { creators, executionInstances, messages } from './dist/db/schema.js';

// NOTE: .mjs runs against the compiled output (npm run build first). For a
// build-free run use `npx tsx prisma/check-instance.ts` instead.
const instances = await db
  .select({ instance: executionInstances, creator: creators })
  .from(executionInstances)
  .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
  .orderBy(desc(executionInstances.enrolledAt))
  .limit(10);

const ids = instances.map((r) => r.instance.id);
const msgRows = ids.length
  ? await db
      .select()
      .from(messages)
      .where(inArray(messages.instanceId, ids))
      .orderBy(asc(messages.sentAt))
  : [];
const msgsByInstance = new Map();
for (const m of msgRows) {
  const list = msgsByInstance.get(m.instanceId) ?? [];
  list.push(m);
  msgsByInstance.set(m.instanceId, list);
}

for (const { instance: inst, creator } of instances) {
  const instMsgs = msgsByInstance.get(inst.id) ?? [];
  console.log('\n' + '='.repeat(60));
  console.log('INSTANCE :', inst.id);
  console.log('Creator  :', creator.name, '|', creator.email);
  console.log('State    :', inst.currentState, '| Round:', inst.negotiationRound);
  console.log('Messages :', instMsgs.length);
  for (const m of instMsgs) {
    console.log('  [' + m.direction + '] ' + (m.subject || '(no subject)'));
    console.log('  threadId:', m.threadId);
    console.log('  externalId:', m.externalMessageId);
    if (m.replyIntent) console.log('  intent:', m.replyIntent, 'conf:', m.classifyConfidence);
  }
}

await pool.end();
