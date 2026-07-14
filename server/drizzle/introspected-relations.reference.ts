import { relations } from "drizzle-orm/relations";
import { executionInstance, event, campaign, workflow, brandNotification, message, paymentInfo, workflowVersion, outboxJob, creator } from "./schema";

export const eventRelations = relations(event, ({one}) => ({
	executionInstance: one(executionInstance, {
		fields: [event.instanceId],
		references: [executionInstance.id]
	}),
}));

export const executionInstanceRelations = relations(executionInstance, ({one, many}) => ({
	events: many(event),
	brandNotifications: many(brandNotification),
	messages: many(message),
	paymentInfos: many(paymentInfo),
	outboxJobs: many(outboxJob),
	workflowVersion: one(workflowVersion, {
		fields: [executionInstance.workflowVersionId],
		references: [workflowVersion.id]
	}),
	creator: one(creator, {
		fields: [executionInstance.creatorId],
		references: [creator.id]
	}),
}));

export const workflowRelations = relations(workflow, ({one, many}) => ({
	campaign: one(campaign, {
		fields: [workflow.campaignId],
		references: [campaign.id]
	}),
	workflowVersions: many(workflowVersion),
}));

export const campaignRelations = relations(campaign, ({many}) => ({
	workflows: many(workflow),
}));

export const brandNotificationRelations = relations(brandNotification, ({one}) => ({
	executionInstance: one(executionInstance, {
		fields: [brandNotification.instanceId],
		references: [executionInstance.id]
	}),
}));

export const messageRelations = relations(message, ({one}) => ({
	executionInstance: one(executionInstance, {
		fields: [message.instanceId],
		references: [executionInstance.id]
	}),
}));

export const paymentInfoRelations = relations(paymentInfo, ({one}) => ({
	executionInstance: one(executionInstance, {
		fields: [paymentInfo.instanceId],
		references: [executionInstance.id]
	}),
}));

export const workflowVersionRelations = relations(workflowVersion, ({one, many}) => ({
	workflow: one(workflow, {
		fields: [workflowVersion.workflowId],
		references: [workflow.id]
	}),
	executionInstances: many(executionInstance),
}));

export const outboxJobRelations = relations(outboxJob, ({one}) => ({
	executionInstance: one(executionInstance, {
		fields: [outboxJob.instanceId],
		references: [executionInstance.id]
	}),
}));

export const creatorRelations = relations(creator, ({many}) => ({
	executionInstances: many(executionInstance),
}));