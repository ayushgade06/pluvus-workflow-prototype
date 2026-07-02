-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "rewardDescription" TEXT,
ADD COLUMN     "shipsPhysicalProduct" BOOLEAN NOT NULL DEFAULT false;
