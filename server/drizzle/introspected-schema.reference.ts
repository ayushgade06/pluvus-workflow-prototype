import { pgTable, check, varchar, timestamp, text, integer, index, foreignKey, jsonb, uniqueIndex, doublePrecision, boolean, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const brandNotificationStatus = pgEnum("BrandNotificationStatus", ['SENT', 'FAILED', 'SKIPPED'])
export const eventType = pgEnum("EventType", ['FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_CANCELLED', 'FOLLOW_UP_DUE', 'INBOUND_REPLY_RECEIVED', 'STATE_TRANSITION', 'NODE_ENTERED', 'NODE_COMPLETED', 'OUTREACH_DRAFTED', 'REPLY_CLASSIFIED', 'NEGOTIATION_TURN', 'MANUAL_REVIEW_FLAGGED', 'BRAND_NOTIFIED', 'REWARD_SETUP_SENT', 'REWARD_CONFIRMED', 'REWARD_REPLY_UNCONFIRMED', 'PAYMENT_INFO_SENT', 'PAYMENT_RECEIVED', 'CONTENT_BRIEF_SENT', 'PAYMENT_REPLY_UNRESOLVED'])
export const instanceState = pgEnum("InstanceState", ['ENROLLED', 'OUTREACH_SENT', 'AWAITING_REPLY', 'FOLLOWED_UP', 'REPLY_RECEIVED', 'NEGOTIATING', 'ACCEPTED', 'REWARD_PENDING', 'REWARD_CONFIRMED', 'PAYMENT_PENDING', 'PAYMENT_RECEIVED', 'CONTENT_BRIEF_SENT', 'REJECTED', 'OPTED_OUT', 'NO_RESPONSE', 'MANUAL_REVIEW'])
export const messageDirection = pgEnum("MessageDirection", ['OUTBOUND', 'INBOUND'])
export const nodeType = pgEnum("NodeType", ['IMPORT_CREATOR_LIST', 'INITIAL_OUTREACH', 'FOLLOW_UP', 'REPLY_DETECTION', 'NEGOTIATION', 'END', 'REWARD_SETUP', 'PAYMENT_INFO', 'CONTENT_BRIEF'])
export const outboxStatus = pgEnum("OutboxStatus", ['PENDING', 'SENT', 'FAILED'])
export const paymentInfoStatus = pgEnum("PaymentInfoStatus", ['PAYMENT_PENDING', 'PAYMENT_RECEIVED'])
export const payoutMethod = pgEnum("PayoutMethod", ['PAYPAL', 'WISE', 'BANK_TRANSFER'])
export const replyIntent = pgEnum("ReplyIntent", ['POSITIVE', 'NEGATIVE', 'QUESTION', 'OPT_OUT', 'UNKNOWN', 'DEFERRED'])
export const workflowStatus = pgEnum("WorkflowStatus", ['DRAFT', 'PUBLISHED', 'ARCHIVED'])


export const prismaMigrations = pgTable("_prisma_migrations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	checksum: varchar({ length: 64 }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	migrationName: varchar("migration_name", { length: 255 }).notNull(),
	logs: text(),
	rolledBackAt: timestamp("rolled_back_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	appliedStepsCount: integer("applied_steps_count").default(0).notNull(),
}, (table) => [
	check("_prisma_migrations_id_not_null", sql`NOT NULL id`),
	check("_prisma_migrations_checksum_not_null", sql`NOT NULL checksum`),
	check("_prisma_migrations_migration_name_not_null", sql`NOT NULL migration_name`),
	check("_prisma_migrations_started_at_not_null", sql`NOT NULL started_at`),
	check("_prisma_migrations_applied_steps_count_not_null", sql`NOT NULL applied_steps_count`),
]);

export const event = pgTable("Event", {
	id: text().primaryKey().notNull(),
	instanceId: text().notNull(),
	type: eventType().notNull(),
	nodeId: text(),
	payload: jsonb(),
	occurredAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("Event_instanceId_occurredAt_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops"), table.occurredAt.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [executionInstance.id],
			name: "Event_instanceId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("Event_id_not_null", sql`NOT NULL id`),
	check("Event_instanceId_not_null", sql`NOT NULL "instanceId"`),
	check("Event_type_not_null", sql`NOT NULL type`),
	check("Event_occurredAt_not_null", sql`NOT NULL "occurredAt"`),
]);

export const workflow = pgTable("Workflow", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	status: workflowStatus().default('DRAFT').notNull(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
	campaignId: text(),
	draftNodes: jsonb(),
}, (table) => [
	foreignKey({
			columns: [table.campaignId],
			foreignColumns: [campaign.id],
			name: "Workflow_campaignId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	check("Workflow_id_not_null", sql`NOT NULL id`),
	check("Workflow_name_not_null", sql`NOT NULL name`),
	check("Workflow_status_not_null", sql`NOT NULL status`),
	check("Workflow_createdAt_not_null", sql`NOT NULL "createdAt"`),
	check("Workflow_updatedAt_not_null", sql`NOT NULL "updatedAt"`),
]);

export const brandNotification = pgTable("BrandNotification", {
	id: text().primaryKey().notNull(),
	instanceId: text().notNull(),
	recipient: text().notNull(),
	reason: text().notNull(),
	status: brandNotificationStatus().default('SENT').notNull(),
	idempotencyKey: text().notNull(),
	error: text(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("BrandNotification_idempotencyKey_key").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")),
	index("BrandNotification_instanceId_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [executionInstance.id],
			name: "BrandNotification_instanceId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("BrandNotification_id_not_null", sql`NOT NULL id`),
	check("BrandNotification_instanceId_not_null", sql`NOT NULL "instanceId"`),
	check("BrandNotification_recipient_not_null", sql`NOT NULL recipient`),
	check("BrandNotification_reason_not_null", sql`NOT NULL reason`),
	check("BrandNotification_status_not_null", sql`NOT NULL status`),
	check("BrandNotification_idempotencyKey_not_null", sql`NOT NULL "idempotencyKey"`),
	check("BrandNotification_createdAt_not_null", sql`NOT NULL "createdAt"`),
]);

export const message = pgTable("Message", {
	id: text().primaryKey().notNull(),
	instanceId: text().notNull(),
	direction: messageDirection().notNull(),
	subject: text(),
	body: text().notNull(),
	threadId: text(),
	externalMessageId: text(),
	replyIntent: replyIntent(),
	classifyConfidence: doublePrecision(),
	sentAt: timestamp({ precision: 3, mode: 'string' }),
	receivedAt: timestamp({ precision: 3, mode: 'string' }),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	idempotencyKey: text(),
	senderEmail: text(),
	processedAt: timestamp({ precision: 3, mode: 'string' }),
}, (table) => [
	uniqueIndex("Message_externalMessageId_key").using("btree", table.externalMessageId.asc().nullsLast().op("text_ops")),
	uniqueIndex("Message_idempotencyKey_key").using("btree", table.idempotencyKey.asc().nullsLast().op("text_ops")),
	index("Message_instanceId_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	index("Message_threadId_idx").using("btree", table.threadId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [executionInstance.id],
			name: "Message_instanceId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("Message_id_not_null", sql`NOT NULL id`),
	check("Message_instanceId_not_null", sql`NOT NULL "instanceId"`),
	check("Message_direction_not_null", sql`NOT NULL direction`),
	check("Message_body_not_null", sql`NOT NULL body`),
	check("Message_createdAt_not_null", sql`NOT NULL "createdAt"`),
]);

export const paymentInfo = pgTable("PaymentInfo", {
	id: text().primaryKey().notNull(),
	instanceId: text().notNull(),
	token: text().notNull(),
	status: paymentInfoStatus().default('PAYMENT_PENDING').notNull(),
	method: payoutMethod(),
	accountIdentifier: text(),
	country: text(),
	notes: text(),
	extra: jsonb(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	submittedAt: timestamp({ precision: 3, mode: 'string' }),
	updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
	expiresAt: timestamp({ precision: 3, mode: 'string' }),
}, (table) => [
	index("PaymentInfo_instanceId_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("PaymentInfo_instanceId_key").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	uniqueIndex("PaymentInfo_token_key").using("btree", table.token.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [executionInstance.id],
			name: "PaymentInfo_instanceId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("PaymentInfo_id_not_null", sql`NOT NULL id`),
	check("PaymentInfo_instanceId_not_null", sql`NOT NULL "instanceId"`),
	check("PaymentInfo_token_not_null", sql`NOT NULL token`),
	check("PaymentInfo_status_not_null", sql`NOT NULL status`),
	check("PaymentInfo_createdAt_not_null", sql`NOT NULL "createdAt"`),
	check("PaymentInfo_updatedAt_not_null", sql`NOT NULL "updatedAt"`),
]);

export const campaign = pgTable("Campaign", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	brand: text().notNull(),
	objective: text(),
	notes: text(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
	notifyEmail: text(),
	brandDescription: text(),
	deliverables: text(),
	timeline: text(),
	rewardDescription: text(),
	shipsPhysicalProduct: boolean().default(false).notNull(),
	attributionWindow: text(),
	exclusivity: text(),
	paymentTerms: text(),
	usageRights: text(),
}, (table) => [
	check("Campaign_id_not_null", sql`NOT NULL id`),
	check("Campaign_name_not_null", sql`NOT NULL name`),
	check("Campaign_brand_not_null", sql`NOT NULL brand`),
	check("Campaign_createdAt_not_null", sql`NOT NULL "createdAt"`),
	check("Campaign_updatedAt_not_null", sql`NOT NULL "updatedAt"`),
	check("Campaign_shipsPhysicalProduct_not_null", sql`NOT NULL "shipsPhysicalProduct"`),
]);

export const creator = pgTable("Creator", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	handle: text(),
	niche: text(),
	platform: text(),
	metadata: jsonb(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("Creator_email_key").using("btree", table.email.asc().nullsLast().op("text_ops")),
	check("Creator_id_not_null", sql`NOT NULL id`),
	check("Creator_name_not_null", sql`NOT NULL name`),
	check("Creator_email_not_null", sql`NOT NULL email`),
	check("Creator_createdAt_not_null", sql`NOT NULL "createdAt"`),
	check("Creator_updatedAt_not_null", sql`NOT NULL "updatedAt"`),
]);

export const workflowVersion = pgTable("WorkflowVersion", {
	id: text().primaryKey().notNull(),
	workflowId: text().notNull(),
	version: integer().notNull(),
	nodeGraph: jsonb().notNull(),
	publishedAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("WorkflowVersion_workflowId_version_key").using("btree", table.workflowId.asc().nullsLast().op("int4_ops"), table.version.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.workflowId],
			foreignColumns: [workflow.id],
			name: "WorkflowVersion_workflowId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("WorkflowVersion_id_not_null", sql`NOT NULL id`),
	check("WorkflowVersion_workflowId_not_null", sql`NOT NULL "workflowId"`),
	check("WorkflowVersion_version_not_null", sql`NOT NULL version`),
	check("WorkflowVersion_nodeGraph_not_null", sql`NOT NULL "nodeGraph"`),
	check("WorkflowVersion_publishedAt_not_null", sql`NOT NULL "publishedAt"`),
	check("WorkflowVersion_createdAt_not_null", sql`NOT NULL "createdAt"`),
]);

export const outboxJob = pgTable("OutboxJob", {
	id: text().primaryKey().notNull(),
	instanceId: text().notNull(),
	queue: text().notNull(),
	payload: jsonb().notNull(),
	dedupeKey: text().notNull(),
	status: outboxStatus().default('PENDING').notNull(),
	attempts: integer().default(0).notNull(),
	lastError: text(),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	sentAt: timestamp({ precision: 3, mode: 'string' }),
}, (table) => [
	uniqueIndex("OutboxJob_dedupeKey_key").using("btree", table.dedupeKey.asc().nullsLast().op("text_ops")),
	index("OutboxJob_instanceId_idx").using("btree", table.instanceId.asc().nullsLast().op("text_ops")),
	index("OutboxJob_status_createdAt_idx").using("btree", table.status.asc().nullsLast().op("enum_ops"), table.createdAt.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.instanceId],
			foreignColumns: [executionInstance.id],
			name: "OutboxJob_instanceId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("OutboxJob_id_not_null", sql`NOT NULL id`),
	check("OutboxJob_instanceId_not_null", sql`NOT NULL "instanceId"`),
	check("OutboxJob_queue_not_null", sql`NOT NULL queue`),
	check("OutboxJob_payload_not_null", sql`NOT NULL payload`),
	check("OutboxJob_dedupeKey_not_null", sql`NOT NULL "dedupeKey"`),
	check("OutboxJob_status_not_null", sql`NOT NULL status`),
	check("OutboxJob_attempts_not_null", sql`NOT NULL attempts`),
	check("OutboxJob_createdAt_not_null", sql`NOT NULL "createdAt"`),
]);

export const executionInstance = pgTable("ExecutionInstance", {
	id: text().primaryKey().notNull(),
	workflowVersionId: text().notNull(),
	creatorId: text().notNull(),
	currentState: instanceState().default('ENROLLED').notNull(),
	currentNodeId: text(),
	followUpCount: integer().default(0).notNull(),
	negotiationRound: integer().default(0).notNull(),
	dueAt: timestamp({ precision: 3, mode: 'string' }),
	enrolledAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	completedAt: timestamp({ precision: 3, mode: 'string' }),
	createdAt: timestamp({ precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("ExecutionInstance_currentState_dueAt_idx").using("btree", table.currentState.asc().nullsLast().op("timestamp_ops"), table.dueAt.asc().nullsLast().op("enum_ops")),
	uniqueIndex("ExecutionInstance_workflowVersionId_creatorId_key").using("btree", table.workflowVersionId.asc().nullsLast().op("text_ops"), table.creatorId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.workflowVersionId],
			foreignColumns: [workflowVersion.id],
			name: "ExecutionInstance_workflowVersionId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.creatorId],
			foreignColumns: [creator.id],
			name: "ExecutionInstance_creatorId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("ExecutionInstance_id_not_null", sql`NOT NULL id`),
	check("ExecutionInstance_workflowVersionId_not_null", sql`NOT NULL "workflowVersionId"`),
	check("ExecutionInstance_creatorId_not_null", sql`NOT NULL "creatorId"`),
	check("ExecutionInstance_followUpCount_not_null", sql`NOT NULL "followUpCount"`),
	check("ExecutionInstance_negotiationRound_not_null", sql`NOT NULL "negotiationRound"`),
	check("ExecutionInstance_enrolledAt_not_null", sql`NOT NULL "enrolledAt"`),
	check("ExecutionInstance_createdAt_not_null", sql`NOT NULL "createdAt"`),
	check("ExecutionInstance_updatedAt_not_null", sql`NOT NULL "updatedAt"`),
	check("ExecutionInstance_currentState_not_null", sql`NOT NULL "currentState"`),
]);
