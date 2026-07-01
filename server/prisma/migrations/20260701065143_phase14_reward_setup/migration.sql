-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'REWARD_SETUP_SENT';
ALTER TYPE "EventType" ADD VALUE 'REWARD_CONFIRMED';
ALTER TYPE "EventType" ADD VALUE 'REWARD_REPLY_UNCONFIRMED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InstanceState" ADD VALUE 'REWARD_PENDING';
ALTER TYPE "InstanceState" ADD VALUE 'REWARD_CONFIRMED';

-- AlterEnum
ALTER TYPE "NodeType" ADD VALUE 'REWARD_SETUP';
