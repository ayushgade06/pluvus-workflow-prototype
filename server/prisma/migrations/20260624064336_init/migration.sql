-- CreateEnum
CREATE TYPE "InstanceState" AS ENUM ('ENROLLED', 'OUTREACH_SENT', 'AWAITING_REPLY', 'FOLLOWED_UP', 'REPLY_RECEIVED', 'NEGOTIATING', 'ACCEPTED', 'REJECTED', 'OPTED_OUT', 'NO_RESPONSE');

-- CreateEnum
CREATE TYPE "NodeType" AS ENUM ('IMPORT_CREATOR_LIST', 'INITIAL_OUTREACH', 'FOLLOW_UP', 'REPLY_DETECTION', 'NEGOTIATION', 'END');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "ReplyIntent" AS ENUM ('POSITIVE', 'NEGATIVE', 'QUESTION', 'OPT_OUT');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_CANCELLED', 'FOLLOW_UP_DUE', 'INBOUND_REPLY_RECEIVED', 'STATE_TRANSITION', 'NODE_ENTERED', 'NODE_COMPLETED', 'OUTREACH_DRAFTED', 'REPLY_CLASSIFIED', 'NEGOTIATION_TURN');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "nodeGraph" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Creator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "handle" TEXT,
    "niche" TEXT,
    "platform" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Creator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionInstance" (
    "id" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "currentState" "InstanceState" NOT NULL DEFAULT 'ENROLLED',
    "currentNodeId" TEXT,
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "negotiationRound" INTEGER NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "threadId" TEXT,
    "externalMessageId" TEXT,
    "replyIntent" "ReplyIntent",
    "classifyConfidence" DOUBLE PRECISION,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "nodeId" TEXT,
    "payload" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Creator_email_key" ON "Creator"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionInstance_workflowVersionId_creatorId_key" ON "ExecutionInstance"("workflowVersionId", "creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalMessageId_key" ON "Message"("externalMessageId");

-- CreateIndex
CREATE INDEX "Message_threadId_idx" ON "Message"("threadId");

-- CreateIndex
CREATE INDEX "Message_instanceId_idx" ON "Message"("instanceId");

-- CreateIndex
CREATE INDEX "Event_instanceId_occurredAt_idx" ON "Event"("instanceId", "occurredAt");

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionInstance" ADD CONSTRAINT "ExecutionInstance_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionInstance" ADD CONSTRAINT "ExecutionInstance_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
