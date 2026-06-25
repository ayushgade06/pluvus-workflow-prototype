import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const instances = await prisma.executionInstance.findMany({
  include: {
    messages: { orderBy: { sentAt: 'asc' } },
    creator: true,
  },
  orderBy: { enrolledAt: 'desc' },
  take: 10,
});

for (const inst of instances) {
  console.log('\n' + '='.repeat(60));
  console.log('INSTANCE :', inst.id);
  console.log('Creator  :', inst.creator.name, '|', inst.creator.email);
  console.log('State    :', inst.currentState, '| Round:', inst.negotiationRound);
  console.log('Messages :', inst.messages.length);
  for (const m of inst.messages) {
    console.log('  [' + m.direction + '] ' + (m.subject || '(no subject)'));
    console.log('  threadId:', m.threadId);
    console.log('  externalId:', m.externalMessageId);
    if (m.replyIntent) console.log('  intent:', m.replyIntent, 'conf:', m.classifyConfidence);
  }
}

await prisma.$disconnect();
