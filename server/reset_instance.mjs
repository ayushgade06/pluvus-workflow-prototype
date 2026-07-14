import { and, eq } from 'drizzle-orm';
import { db, pool } from './dist/db/drizzle.js';
import { creators, events, executionInstances, messages } from './dist/db/schema.js';

// NOTE: .mjs runs against the compiled output (npm run build first). For a
// build-free reset use `npx tsx prisma/reset-to-enrolled.ts <instanceId>`.
// Delete all instances for Robin Singh so they can be re-enrolled
const instances = await db
  .select({ id: executionInstances.id })
  .from(executionInstances)
  .innerJoin(creators, eq(executionInstances.creatorId, creators.id))
  .where(
    and(
      eq(creators.email, 'notbaka2303@gmail.com'),
      eq(executionInstances.currentState, 'MANUAL_REVIEW'),
    ),
  );

console.log(`Found ${instances.length} MANUAL_REVIEW instances to delete`);

for (const inst of instances) {
  await db.delete(events).where(eq(events.instanceId, inst.id));
  await db.delete(messages).where(eq(messages.instanceId, inst.id));
  await db.delete(executionInstances).where(eq(executionInstances.id, inst.id));
  console.log(`Deleted instance ${inst.id}`);
}

await pool.end();
console.log('Done');
