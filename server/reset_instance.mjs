import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Delete all instances for Robin Singh so they can be re-enrolled
const instances = await prisma.executionInstance.findMany({
  where: {
    creator: { email: 'notbaka2303@gmail.com' },
    currentState: 'MANUAL_REVIEW',
  },
  select: { id: true },
});

console.log(`Found ${instances.length} MANUAL_REVIEW instances to delete`);

for (const inst of instances) {
  await prisma.event.deleteMany({ where: { instanceId: inst.id } });
  await prisma.message.deleteMany({ where: { instanceId: inst.id } });
  await prisma.executionInstance.delete({ where: { id: inst.id } });
  console.log(`Deleted instance ${inst.id}`);
}

await prisma.$disconnect();
console.log('Done');
