import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const serviceActivationState = pgEnum("service_activation_state", ["inactive", "active"]);
export const settingValueType = pgEnum("setting_value_type", [
  "boolean",
  "integer",
  "decimal",
  "text",
  "enum",
  "duration",
]);
export const workItemStatus = pgEnum("work_item_status", ["open", "completed", "cancelled"]);

export const tenants = pgTable(
  "tenants",
  {
    tenantId: uuid("tenant_id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
  },
  (table) => [check("tenants_name_not_blank", sql`char_length(trim(${table.name})) > 0`)],
);

export const principals = pgTable(
  "principals",
  {
    principalId: uuid("principal_id").defaultRandom().primaryKey(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
  },
  (table) => [
    check("principals_display_name_not_blank", sql`char_length(trim(${table.displayName})) > 0`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    membershipId: uuid("membership_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.principalId, { onDelete: "restrict" }),
    roleKey: text("role_key").notNull(),
    status: text("status").default("active").notNull(),
    managerPrincipalId: uuid("manager_principal_id").references(() => principals.principalId, {
      onDelete: "restrict",
    }),
  },
  (table) => [
    unique("memberships_tenant_principal_uq").on(table.tenantId, table.principalId),
    foreignKey({
      columns: [table.tenantId, table.managerPrincipalId],
      foreignColumns: [table.tenantId, table.principalId],
      name: "memberships_manager_same_tenant_fk",
    }).onDelete("restrict"),
    index("memberships_tenant_manager_idx").on(table.tenantId, table.managerPrincipalId),
    check("memberships_role_key_not_blank", sql`char_length(trim(${table.roleKey})) > 0`),
    check("memberships_status_valid", sql`${table.status} IN ('active', 'suspended')`),
  ],
).enableRLS();

export const membershipCapabilities = pgTable(
  "membership_capabilities",
  {
    tenantId: uuid("tenant_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    capabilityId: text("capability_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.principalId, table.capabilityId],
      name: "membership_capabilities_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "membership_capabilities_membership_fk",
    }).onDelete("restrict"),
    check(
      "membership_capabilities_id_not_blank",
      sql`char_length(trim(${table.capabilityId})) > 0`,
    ),
  ],
).enableRLS();

export const serviceActivations = pgTable(
  "service_activations",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    serviceKey: text("service_key").notNull(),
    state: serviceActivationState("state").default("inactive").notNull(),
    version: integer("version").default(1).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.serviceKey], name: "service_activations_pk" }),
    check("service_activations_key_not_blank", sql`char_length(trim(${table.serviceKey})) > 0`),
    check("service_activations_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

export const tenantSettings = pgTable(
  "tenant_settings",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    settingKey: text("setting_key").notNull(),
    valueType: settingValueType("value_type").notNull(),
    value: jsonb("value").notNull(),
    version: integer("version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.settingKey], name: "tenant_settings_pk" }),
    check("tenant_settings_key_not_blank", sql`char_length(trim(${table.settingKey})) > 0`),
    check("tenant_settings_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

export const workItems = pgTable(
  "work_items",
  {
    workItemId: uuid("work_item_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    assigneePrincipalId: uuid("assignee_principal_id").notNull(),
    workType: text("work_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    status: workItemStatus("status").default("open").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.assigneePrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "work_items_assignee_same_tenant_fk",
    }).onDelete("restrict"),
    unique("work_items_tenant_work_subject_uq").on(
      table.tenantId,
      table.workType,
      table.subjectType,
      table.subjectId,
    ),
    index("work_items_tenant_assignee_status_created_idx").on(
      table.tenantId,
      table.assigneePrincipalId,
      table.status,
      table.createdAt,
    ),
    check(
      "work_items_completion_consistent",
      sql`(${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL) OR (${table.status} <> 'completed' AND ${table.completedAt} IS NULL)`,
    ),
    check("work_items_work_type_not_blank", sql`char_length(trim(${table.workType})) > 0`),
    check("work_items_subject_type_not_blank", sql`char_length(trim(${table.subjectType})) > 0`),
  ],
).enableRLS();

export const evidenceEvents = pgTable(
  "evidence_events",
  {
    evidenceEventId: uuid("evidence_event_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    priorState: text("prior_state"),
    newState: text("new_state").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.actorPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "evidence_events_actor_same_tenant_fk",
    }).onDelete("restrict"),
    unique("evidence_events_idempotency_uq").on(
      table.tenantId,
      table.subjectType,
      table.subjectId,
      table.eventType,
      table.correlationId,
    ),
    index("evidence_events_tenant_subject_occurred_idx").on(
      table.tenantId,
      table.subjectType,
      table.subjectId,
      table.occurredAt,
      table.evidenceEventId,
    ),
    check("evidence_events_type_not_blank", sql`char_length(trim(${table.eventType})) > 0`),
    check(
      "evidence_events_subject_type_not_blank",
      sql`char_length(trim(${table.subjectType})) > 0`,
    ),
    check("evidence_events_new_state_not_blank", sql`char_length(trim(${table.newState})) > 0`),
  ],
).enableRLS();

export const outboxEvents = pgTable(
  "outbox_events",
  {
    eventId: uuid("event_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateVersion: integer("aggregate_version").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    unique("outbox_events_idempotency_uq").on(
      table.tenantId,
      table.eventType,
      table.aggregateType,
      table.aggregateId,
      table.aggregateVersion,
    ),
    index("outbox_events_unpublished_idx")
      .on(table.occurredAt, table.eventId)
      .where(sql`${table.publishedAt} IS NULL`),
    index("outbox_events_tenant_correlation_idx").on(table.tenantId, table.correlationId),
    check("outbox_events_type_not_blank", sql`char_length(trim(${table.eventType})) > 0`),
    check(
      "outbox_events_aggregate_type_not_blank",
      sql`char_length(trim(${table.aggregateType})) > 0`,
    ),
    check("outbox_events_aggregate_version_positive", sql`${table.aggregateVersion} > 0`),
  ],
).enableRLS();
