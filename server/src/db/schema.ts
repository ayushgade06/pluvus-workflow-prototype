// =============================================================================
// Pluvus Workflow Prototype — Drizzle Schema
//
// Derived from `drizzle-kit pull` (introspection) against the live Neon DB on
// 2026-07-14 (raw output kept at server/drizzle/introspected-schema.reference.ts)
// and hand-verified field-by-field against prisma/schema.prisma. The database
// schema is owned by the HISTORICAL Prisma migrations in prisma/migrations —
// every table name, column name, enum type, and index below is byte-identical
// to what those migrations created.
//
//   ⚠ NEVER run `drizzle-kit push` or `drizzle-kit generate` against this
//   schema. Prisma's constraint names (Table_pkey / Table_col_key /
//   Table_col_fkey / Table_col_idx) differ from Drizzle's naming convention,
//   so push would try to drop and recreate constraints on the live database.
//   `drizzle-kit pull` (read-only) is the only kit command that may run.
//
// Two pieces of Prisma CLIENT-SIDE magic are reproduced here in Drizzle terms
// (the DB columns have no defaults for either):
//   - `@default(cuid())` id columns  → `$defaultFn(() => createId())` (cuid2)
//   - `@updatedAt` columns           → `$defaultFn` on insert + `$onUpdate`
//
// Layout mirrors the parent Pluvus `shared/schema.ts` style (single file,
// pgEnum + pgTable + drizzle-zod insert-schema companions + inferred types) so
// the later merge into the parent is copy-paste.
// =============================================================================

import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON value types (replacing Prisma.JsonValue / Prisma.InputJsonValue)
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

/** Write-side alias kept for parity with Prisma.InputJsonValue. */
export type InputJsonValue = JsonValue;

/** Object-shaped JSON (parity with Prisma.JsonObject). */
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Column helpers — Prisma client-side magic, reproduced
// ---------------------------------------------------------------------------

/** Prisma `@id @default(cuid())`: TEXT pk, id generated CLIENT-side. */
const cuidId = (name: string) =>
  text(name)
    .primaryKey()
    .$defaultFn(() => createId());

/** Prisma `DateTime` → TIMESTAMP(3) (naive, stored as UTC). */
const ts = (name: string) => timestamp(name, { precision: 3, mode: "date" });

/** Prisma `@default(now())`. */
const tsNow = (name: string) => ts(name).notNull().defaultNow();

/**
 * Prisma `@updatedAt`: NOT NULL with NO db default — the client stamps it on
 * both insert and update. `$onUpdate` covers `db.update(...)`; without the
 * insert-side `$defaultFn`, inserts would violate NOT NULL.
 */
const tsUpdatedAt = (name: string) =>
  ts(name)
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Enums (10) — names and member order exactly as they exist in the database
// ---------------------------------------------------------------------------

export const instanceStateEnum = pgEnum("InstanceState", [
  "ENROLLED",
  "OUTREACH_SENT",
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REWARD_PENDING",
  "REWARD_CONFIRMED",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "CONTENT_BRIEF_SENT",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
]);

// DB member order differs from schema.prisma's declaration order for the
// members added by later migrations (Postgres appends/positions via ALTER
// TYPE): END precedes the newer node types here. Order is DDL-only — values
// travel as strings at runtime — but we keep the DB's truth.
export const nodeTypeEnum = pgEnum("NodeType", [
  "IMPORT_CREATOR_LIST",
  "INITIAL_OUTREACH",
  "FOLLOW_UP",
  "REPLY_DETECTION",
  "NEGOTIATION",
  "END",
  "REWARD_SETUP",
  "PAYMENT_INFO",
  "CONTENT_BRIEF",
]);

export const messageDirectionEnum = pgEnum("MessageDirection", [
  "OUTBOUND",
  "INBOUND",
]);

export const replyIntentEnum = pgEnum("ReplyIntent", [
  "POSITIVE",
  "NEGATIVE",
  "QUESTION",
  "OPT_OUT",
  "UNKNOWN",
  "DEFERRED",
]);

export const eventTypeEnum = pgEnum("EventType", [
  "FOLLOW_UP_SCHEDULED",
  "FOLLOW_UP_CANCELLED",
  "FOLLOW_UP_DUE",
  "INBOUND_REPLY_RECEIVED",
  "STATE_TRANSITION",
  "NODE_ENTERED",
  "NODE_COMPLETED",
  "OUTREACH_DRAFTED",
  "REPLY_CLASSIFIED",
  "NEGOTIATION_TURN",
  "MANUAL_REVIEW_FLAGGED",
  "BRAND_NOTIFIED",
  "REWARD_SETUP_SENT",
  "REWARD_CONFIRMED",
  "REWARD_REPLY_UNCONFIRMED",
  "PAYMENT_INFO_SENT",
  "PAYMENT_RECEIVED",
  "CONTENT_BRIEF_SENT",
  "PAYMENT_REPLY_UNRESOLVED",
]);

export const workflowStatusEnum = pgEnum("WorkflowStatus", [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
]);

export const outboxStatusEnum = pgEnum("OutboxStatus", [
  "PENDING",
  "SENT",
  "FAILED",
]);

export const brandNotificationStatusEnum = pgEnum("BrandNotificationStatus", [
  "SENT",
  "FAILED",
  "SKIPPED",
]);

export const paymentInfoStatusEnum = pgEnum("PaymentInfoStatus", [
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
]);

export const payoutMethodEnum = pgEnum("PayoutMethod", [
  "PAYPAL",
  "WISE",
  "BANK_TRANSFER",
]);

// String-literal union types with the same names @prisma/client exported.
export type InstanceState = (typeof instanceStateEnum.enumValues)[number];
export type NodeType = (typeof nodeTypeEnum.enumValues)[number];
export type MessageDirection = (typeof messageDirectionEnum.enumValues)[number];
export type ReplyIntent = (typeof replyIntentEnum.enumValues)[number];
export type EventType = (typeof eventTypeEnum.enumValues)[number];
export type WorkflowStatus = (typeof workflowStatusEnum.enumValues)[number];
export type OutboxStatus = (typeof outboxStatusEnum.enumValues)[number];
export type BrandNotificationStatus =
  (typeof brandNotificationStatusEnum.enumValues)[number];
export type PaymentInfoStatus =
  (typeof paymentInfoStatusEnum.enumValues)[number];
export type PayoutMethod = (typeof payoutMethodEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Definition models
// ---------------------------------------------------------------------------

export const campaigns = pgTable("Campaign", {
  id: cuidId("id"),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  objective: text("objective"),
  notes: text("notes"),
  notifyEmail: text("notifyEmail"),
  brandDescription: text("brandDescription"),
  deliverables: text("deliverables"),
  timeline: text("timeline"),
  rewardDescription: text("rewardDescription"),
  shipsPhysicalProduct: boolean("shipsPhysicalProduct").notNull().default(false),
  usageRights: text("usageRights"),
  exclusivity: text("exclusivity"),
  paymentTerms: text("paymentTerms"),
  attributionWindow: text("attributionWindow"),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

export const workflows = pgTable("Workflow", {
  id: cuidId("id"),
  name: text("name").notNull(),
  description: text("description"),
  status: workflowStatusEnum("status").notNull().default("DRAFT"),
  campaignId: text("campaignId").references(() => campaigns.id),
  draftNodes: jsonb("draftNodes").$type<JsonValue>(),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

export const workflowVersions = pgTable(
  "WorkflowVersion",
  {
    id: cuidId("id"),
    workflowId: text("workflowId")
      .notNull()
      .references(() => workflows.id),
    version: integer("version").notNull(),
    nodeGraph: jsonb("nodeGraph").$type<JsonValue>().notNull(),
    publishedAt: tsNow("publishedAt"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    uniqueIndex("WorkflowVersion_workflowId_version_key").on(
      table.workflowId,
      table.version,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Creator model
// ---------------------------------------------------------------------------

export const creators = pgTable(
  "Creator",
  {
    id: cuidId("id"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    handle: text("handle"),
    niche: text("niche"),
    platform: text("platform"),
    metadata: jsonb("metadata").$type<JsonValue>(),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [uniqueIndex("Creator_email_key").on(table.email)],
);

// ---------------------------------------------------------------------------
// Execution models
// ---------------------------------------------------------------------------

export const executionInstances = pgTable(
  "ExecutionInstance",
  {
    id: cuidId("id"),
    workflowVersionId: text("workflowVersionId")
      .notNull()
      .references(() => workflowVersions.id),
    creatorId: text("creatorId")
      .notNull()
      .references(() => creators.id),
    currentState: instanceStateEnum("currentState").notNull().default("ENROLLED"),
    currentNodeId: text("currentNodeId"),
    followUpCount: integer("followUpCount").notNull().default(0),
    negotiationRound: integer("negotiationRound").notNull().default(0),
    dueAt: ts("dueAt"),
    enrolledAt: tsNow("enrolledAt"),
    completedAt: ts("completedAt"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("ExecutionInstance_workflowVersionId_creatorId_key").on(
      table.workflowVersionId,
      table.creatorId,
    ),
    // HARD-R1: poller + reconciliation sweep scan by currentState (+ dueAt).
    index("ExecutionInstance_currentState_dueAt_idx").on(
      table.currentState,
      table.dueAt,
    ),
  ],
);

export const messages = pgTable(
  "Message",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    direction: messageDirectionEnum("direction").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    threadId: text("threadId"),
    senderEmail: text("senderEmail"),
    externalMessageId: text("externalMessageId"),
    idempotencyKey: text("idempotencyKey"),
    replyIntent: replyIntentEnum("replyIntent"),
    classifyConfidence: doublePrecision("classifyConfidence"),
    sentAt: ts("sentAt"),
    receivedAt: ts("receivedAt"),
    processedAt: ts("processedAt"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    uniqueIndex("Message_externalMessageId_key").on(table.externalMessageId),
    uniqueIndex("Message_idempotencyKey_key").on(table.idempotencyKey),
    index("Message_threadId_idx").on(table.threadId),
    index("Message_instanceId_idx").on(table.instanceId),
  ],
);

export const events = pgTable(
  "Event",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    type: eventTypeEnum("type").notNull(),
    nodeId: text("nodeId"),
    payload: jsonb("payload").$type<JsonValue>(),
    occurredAt: tsNow("occurredAt"),
  },
  (table) => [
    index("Event_instanceId_occurredAt_idx").on(
      table.instanceId,
      table.occurredAt,
    ),
  ],
);

export const outboxJobs = pgTable(
  "OutboxJob",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    dedupeKey: text("dedupeKey").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("lastError"),
    createdAt: tsNow("createdAt"),
    sentAt: ts("sentAt"),
  },
  (table) => [
    uniqueIndex("OutboxJob_dedupeKey_key").on(table.dedupeKey),
    index("OutboxJob_status_createdAt_idx").on(table.status, table.createdAt),
    index("OutboxJob_instanceId_idx").on(table.instanceId),
  ],
);

export const brandNotifications = pgTable(
  "BrandNotification",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    recipient: text("recipient").notNull(),
    reason: text("reason").notNull(),
    status: brandNotificationStatusEnum("status").notNull().default("SENT"),
    idempotencyKey: text("idempotencyKey").notNull(),
    error: text("error"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    uniqueIndex("BrandNotification_idempotencyKey_key").on(table.idempotencyKey),
    index("BrandNotification_instanceId_idx").on(table.instanceId),
  ],
);

export const paymentInfo = pgTable(
  "PaymentInfo",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    token: text("token").notNull(),
    status: paymentInfoStatusEnum("status").notNull().default("PAYMENT_PENDING"),
    method: payoutMethodEnum("method"),
    accountIdentifier: text("accountIdentifier"),
    country: text("country"),
    notes: text("notes"),
    extra: jsonb("extra").$type<JsonValue>(),
    expiresAt: ts("expiresAt"),
    createdAt: tsNow("createdAt"),
    submittedAt: ts("submittedAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("PaymentInfo_instanceId_key").on(table.instanceId),
    uniqueIndex("PaymentInfo_token_key").on(table.token),
    index("PaymentInfo_instanceId_idx").on(table.instanceId),
  ],
);

// HARD-O1: one row per LLM call the agent service made on behalf of a workflow
// instance — the durable token/latency/cost telemetry the in-process agent ring
// buffer cannot provide. Rows are written best-effort by the observability sink
// (llmUsage.ts) from the `llmUsage` block each agent response carries; a lost
// row degrades reporting, never the workflow, so there is no FK-cascade or
// NOT NULL coupling beyond the instance reference. instanceId is nullable:
// calls made outside an instance step (harnesses, ad-hoc API use) still count
// toward totals. Token columns are nullable — a provider that reports no
// usage_metadata stays "unreported", distinct from 0.
export const llmCalls = pgTable(
  "LlmCall",
  {
    id: cuidId("id"),
    instanceId: text("instanceId").references(() => executionInstances.id),
    // Which agent path made the call: "classify" | "negotiate" | "draft".
    role: text("role").notNull(),
    // Provider-qualified model label (e.g. "anthropic:claude-opus-4-8").
    model: text("model").notNull(),
    promptVersion: text("promptVersion"),
    latencyMs: doublePrecision("latencyMs").notNull(),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    estCostUsd: doublePrecision("estCostUsd"),
    ok: boolean("ok").notNull().default(true),
    errorKind: text("errorKind"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    index("LlmCall_instanceId_idx").on(table.instanceId),
    index("LlmCall_createdAt_idx").on(table.createdAt),
  ],
);

/** The agent paths that produce LLM calls (LlmCall.role values). */
export type LlmCallRole = "classify" | "negotiate" | "draft";

// ---------------------------------------------------------------------------
// drizzle-zod insert-schema companions (parent Pluvus convention)
// ---------------------------------------------------------------------------

export const insertCampaignSchema = createInsertSchema(campaigns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertWorkflowSchema = createInsertSchema(workflows).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertWorkflowVersionSchema = createInsertSchema(
  workflowVersions,
).omit({ id: true, createdAt: true, publishedAt: true });
export const insertCreatorSchema = createInsertSchema(creators).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertExecutionInstanceSchema = createInsertSchema(
  executionInstances,
).omit({ id: true, createdAt: true, updatedAt: true, enrolledAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});
export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
  occurredAt: true,
});
export const insertOutboxJobSchema = createInsertSchema(outboxJobs).omit({
  id: true,
  createdAt: true,
});
export const insertBrandNotificationSchema = createInsertSchema(
  brandNotifications,
).omit({ id: true, createdAt: true });
export const insertPaymentInfoSchema = createInsertSchema(paymentInfo).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// ---------------------------------------------------------------------------
// Inferred model types — same names @prisma/client exported
// ---------------------------------------------------------------------------

export type Campaign = typeof campaigns.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type Creator = typeof creators.$inferSelect;
export type ExecutionInstance = typeof executionInstances.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Event = typeof events.$inferSelect;
export type OutboxJob = typeof outboxJobs.$inferSelect;
export type BrandNotification = typeof brandNotifications.$inferSelect;
export type PaymentInfo = typeof paymentInfo.$inferSelect;
export type LlmCall = typeof llmCalls.$inferSelect;

export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type InsertWorkflowVersion = z.infer<typeof insertWorkflowVersionSchema>;
export type InsertCreator = z.infer<typeof insertCreatorSchema>;
export type InsertExecutionInstance = z.infer<
  typeof insertExecutionInstanceSchema
>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type InsertOutboxJob = z.infer<typeof insertOutboxJobSchema>;
export type InsertBrandNotification = z.infer<
  typeof insertBrandNotificationSchema
>;
export type InsertPaymentInfo = z.infer<typeof insertPaymentInfoSchema>;

// Raw insert types (what db.insert(...).values() accepts, ids/timestamps
// optional because of the $defaultFn/default declarations above).
export type CampaignInsert = typeof campaigns.$inferInsert;
export type WorkflowInsert = typeof workflows.$inferInsert;
export type WorkflowVersionInsert = typeof workflowVersions.$inferInsert;
export type CreatorInsert = typeof creators.$inferInsert;
export type ExecutionInstanceInsert = typeof executionInstances.$inferInsert;
export type MessageInsert = typeof messages.$inferInsert;
export type EventInsert = typeof events.$inferInsert;
export type OutboxJobInsert = typeof outboxJobs.$inferInsert;
export type BrandNotificationInsert = typeof brandNotifications.$inferInsert;
export type PaymentInfoInsert = typeof paymentInfo.$inferInsert;
export type LlmCallInsert = typeof llmCalls.$inferInsert;
