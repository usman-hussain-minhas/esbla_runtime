import { sql } from "drizzle-orm";
import {
  boolean,
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

export const presentationSettingValues = pgTable(
  "presentation_setting_values",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    settingKey: text("setting_key").notNull(),
    value: jsonb("value").notNull(),
    locked: boolean("locked").default(false).notNull(),
    version: integer("version").default(1).notNull(),
    updatedByPrincipalId: uuid("updated_by_principal_id").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.subjectType, table.subjectId, table.settingKey],
      name: "presentation_setting_values_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.updatedByPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_setting_values_updater_membership_fk",
    }).onDelete("restrict"),
    index("presentation_setting_values_tenant_subject_idx").on(
      table.tenantId,
      table.subjectType,
      table.subjectId,
    ),
    check(
      "presentation_setting_values_subject_type_valid",
      sql`${table.subjectType} IN ('tenant_default', 'user_override')`,
    ),
    check(
      "presentation_setting_values_subject_shape_valid",
      sql`${table.subjectType} <> 'tenant_default' OR ${table.subjectId} = ${table.tenantId}`,
    ),
    check(
      "presentation_setting_values_key_valid",
      sql`${table.settingKey} IN (
        'appearance.palette.v1',
        'appearance.high_contrast.v1',
        'appearance.reduced_motion.v1',
        'appearance.density.v1'
      )`,
    ),
    check(
      "presentation_setting_values_value_valid",
      sql`(
        (${table.settingKey} = 'appearance.palette.v1'
          AND ${table.value} IN ('"light"'::jsonb, '"dark"'::jsonb))
        OR (${table.settingKey} = 'appearance.high_contrast.v1'
          AND ${table.value} IN ('true'::jsonb, 'false'::jsonb))
        OR (${table.settingKey} = 'appearance.reduced_motion.v1'
          AND ${table.value} IN ('"auto"'::jsonb, '"reduce"'::jsonb))
        OR (${table.settingKey} = 'appearance.density.v1'
          AND ${table.value} IN ('"comfortable"'::jsonb, '"compact"'::jsonb))
      )`,
    ),
    check(
      "presentation_setting_values_lock_valid",
      sql`(
        ${table.locked} = false
        OR (
          ${table.subjectType} = 'tenant_default'
          AND (
            ${table.settingKey} = 'appearance.density.v1'
            OR (${table.settingKey} = 'appearance.high_contrast.v1'
              AND ${table.value} = 'true'::jsonb)
            OR (${table.settingKey} = 'appearance.reduced_motion.v1'
              AND ${table.value} = '"reduce"'::jsonb)
          )
        )
      )`,
    ),
    check("presentation_setting_values_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

export const presentationShortcutUserPatches = pgTable(
  "presentation_shortcut_user_patches",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    principalId: uuid("principal_id").notNull(),
    settingKey: text("setting_key").notNull(),
    contextKind: text("context_kind").notNull(),
    contextId: text("context_id").notNull(),
    patch: jsonb("patch").notNull(),
    version: integer("version").default(1).notNull(),
    updatedByPrincipalId: uuid("updated_by_principal_id").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.principalId,
        table.settingKey,
        table.contextKind,
        table.contextId,
      ],
      name: "presentation_shortcut_user_patches_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_shortcut_user_patches_membership_fk",
    }).onDelete("restrict"),
    check(
      "presentation_shortcut_user_patches_setting_context_valid",
      sql`(
        ${table.settingKey} = 'navigation.universal_shortcuts.v1'
        AND ${table.contextKind} = 'global'
        AND ${table.contextId} = 'global'
      ) OR (
        ${table.settingKey} = 'navigation.contextual_shortcuts.v1'
        AND ${table.contextKind} IN ('service', 'surface')
        AND char_length(trim(${table.contextId})) BETWEEN 1 AND 160
      )`,
    ),
    check(
      "presentation_shortcut_user_patches_own_actor_valid",
      sql`${table.principalId} = ${table.updatedByPrincipalId}`,
    ),
    check(
      "presentation_shortcut_user_patches_patch_object_valid",
      sql`jsonb_typeof(${table.patch}) = 'object'`,
    ),
    check("presentation_shortcut_user_patches_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

export const presentationSurfaceVersions = pgTable(
  "presentation_surface_versions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    surfaceId: text("surface_id").notNull(),
    baseVersion: integer("base_version").notNull(),
    basedOnVersion: integer("based_on_version"),
    definitionHash: text("definition_hash").notNull(),
    layout: jsonb("layout").notNull(),
    publishedByPrincipalId: uuid("published_by_principal_id").notNull(),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.surfaceId, table.baseVersion],
      name: "presentation_surface_versions_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.publishedByPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_surface_versions_publisher_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.surfaceId, table.basedOnVersion],
      foreignColumns: [table.tenantId, table.surfaceId, table.baseVersion],
      name: "presentation_surface_versions_based_on_fk",
    }).onDelete("restrict"),
    index("presentation_surface_versions_tenant_surface_published_idx").on(
      table.tenantId,
      table.surfaceId,
      table.publishedAt,
    ),
    check(
      "presentation_surface_versions_surface_valid",
      sql`${table.surfaceId} IN ('surface.mission-control', 'surface.hr.mission-control')`,
    ),
    check("presentation_surface_versions_base_version_positive", sql`${table.baseVersion} > 0`),
    check(
      "presentation_surface_versions_lineage_valid",
      sql`(${table.baseVersion} = 1 AND ${table.basedOnVersion} IS NULL)
          OR (${table.baseVersion} > 1 AND ${table.basedOnVersion} > 0
              AND ${table.basedOnVersion} < ${table.baseVersion})`,
    ),
    check(
      "presentation_surface_versions_definition_hash_valid",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "presentation_surface_versions_layout_array",
      sql`jsonb_typeof(${table.layout}) = 'array'`,
    ),
  ],
).enableRLS();

export const presentationSurfaceHeads = pgTable(
  "presentation_surface_heads",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    surfaceId: text("surface_id").notNull(),
    currentBaseVersion: integer("current_base_version").notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    updatedByPrincipalId: uuid("updated_by_principal_id").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.surfaceId],
      name: "presentation_surface_heads_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.surfaceId, table.currentBaseVersion],
      foreignColumns: [
        presentationSurfaceVersions.tenantId,
        presentationSurfaceVersions.surfaceId,
        presentationSurfaceVersions.baseVersion,
      ],
      name: "presentation_surface_heads_current_version_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.updatedByPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_surface_heads_updater_membership_fk",
    }).onDelete("restrict"),
    check(
      "presentation_surface_heads_surface_valid",
      sql`${table.surfaceId} IN ('surface.mission-control', 'surface.hr.mission-control')`,
    ),
    check(
      "presentation_surface_heads_current_version_positive",
      sql`${table.currentBaseVersion} > 0`,
    ),
    check("presentation_surface_heads_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const presentationSurfaceSettings = pgTable(
  "presentation_surface_settings",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    surfaceId: text("surface_id").notNull(),
    personalizationEnabled: boolean("personalization_enabled").default(true).notNull(),
    version: integer("version").default(1).notNull(),
    updatedByPrincipalId: uuid("updated_by_principal_id").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.surfaceId],
      name: "presentation_surface_settings_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.updatedByPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_surface_settings_updater_membership_fk",
    }).onDelete("restrict"),
    check(
      "presentation_surface_settings_surface_valid",
      sql`${table.surfaceId} IN ('surface.mission-control', 'surface.hr.mission-control')`,
    ),
    check("presentation_surface_settings_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

export const presentationSurfaceDrafts = pgTable(
  "presentation_surface_drafts",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    surfaceId: text("surface_id").notNull(),
    basedOnVersion: integer("based_on_version").notNull(),
    definitionHash: text("definition_hash").notNull(),
    layout: jsonb("layout").notNull(),
    version: integer("version").default(1).notNull(),
    updatedByPrincipalId: uuid("updated_by_principal_id").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.surfaceId],
      name: "presentation_surface_drafts_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.surfaceId, table.basedOnVersion],
      foreignColumns: [
        presentationSurfaceVersions.tenantId,
        presentationSurfaceVersions.surfaceId,
        presentationSurfaceVersions.baseVersion,
      ],
      name: "presentation_surface_drafts_based_on_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.updatedByPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_surface_drafts_updater_membership_fk",
    }).onDelete("restrict"),
    index("presentation_surface_drafts_tenant_updated_idx").on(table.tenantId, table.updatedAt),
    check(
      "presentation_surface_drafts_surface_valid",
      sql`${table.surfaceId} IN ('surface.mission-control', 'surface.hr.mission-control')`,
    ),
    check(
      "presentation_surface_drafts_based_on_version_positive",
      sql`${table.basedOnVersion} > 0`,
    ),
    check(
      "presentation_surface_drafts_definition_hash_valid",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("presentation_surface_drafts_layout_array", sql`jsonb_typeof(${table.layout}) = 'array'`),
    check("presentation_surface_drafts_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();

export const presentationSurfaceOverlays = pgTable(
  "presentation_surface_overlays",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    principalId: uuid("principal_id").notNull(),
    surfaceId: text("surface_id").notNull(),
    baseVersion: integer("base_version").notNull(),
    layout: jsonb("layout").notNull(),
    version: integer("version").default(1).notNull(),
    updatedByPrincipalId: uuid("updated_by_principal_id").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.principalId, table.surfaceId],
      name: "presentation_surface_overlays_pk",
    }),
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_surface_overlays_owner_membership_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.surfaceId, table.baseVersion],
      foreignColumns: [
        presentationSurfaceVersions.tenantId,
        presentationSurfaceVersions.surfaceId,
        presentationSurfaceVersions.baseVersion,
      ],
      name: "presentation_surface_overlays_base_version_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.updatedByPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "presentation_surface_overlays_updater_membership_fk",
    }).onDelete("restrict"),
    index("presentation_surface_overlays_tenant_principal_idx").on(
      table.tenantId,
      table.principalId,
    ),
    check(
      "presentation_surface_overlays_surface_valid",
      sql`${table.surfaceId} IN ('surface.mission-control', 'surface.hr.mission-control')`,
    ),
    check("presentation_surface_overlays_base_version_positive", sql`${table.baseVersion} > 0`),
    check(
      "presentation_surface_overlays_layout_array",
      sql`jsonb_typeof(${table.layout}) = 'array'`,
    ),
    check("presentation_surface_overlays_version_positive", sql`${table.version} > 0`),
    check(
      "presentation_surface_overlays_own_update",
      sql`${table.principalId} = ${table.updatedByPrincipalId}`,
    ),
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
    unique("outbox_events_tenant_event_uq").on(table.tenantId, table.eventId),
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

export const notificationIntents = pgTable(
  "notification_intents",
  {
    intentId: uuid("intent_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    sourceEventId: uuid("source_event_id").notNull(),
    recipientPrincipalId: uuid("recipient_principal_id").notNull(),
    sourceServiceKey: text("source_service_key").notNull(),
    state: text("state").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    lastFailureCode: text("last_failure_code"),
    intentPayload: jsonb("intent_payload").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).notNull(),
    terminalAt: timestamp("terminal_at", { mode: "date", withTimezone: true }),
    payloadRedactedAt: timestamp("payload_redacted_at", {
      mode: "date",
      withTimezone: true,
    }),
    rowVersion: integer("row_version").default(1).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("notification_intents_tenant_intent_uq").on(table.tenantId, table.intentId),
    unique("notification_intents_source_recipient_uq").on(
      table.tenantId,
      table.sourceEventId,
      table.recipientPrincipalId,
    ),
    foreignKey({
      columns: [table.tenantId, table.sourceEventId],
      foreignColumns: [outboxEvents.tenantId, outboxEvents.eventId],
      name: "notification_intents_source_event_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.recipientPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "notification_intents_recipient_same_tenant_fk",
    }).onDelete("restrict"),
    index("notification_intents_projector_idx")
      .on(table.nextAttemptAt, table.occurredAt, table.sourceEventId, table.recipientPrincipalId)
      .where(sql`${table.state} IN ('pending', 'retrying')`),
    index("notification_intents_tenant_source_idx").on(
      table.tenantId,
      table.sourceEventId,
      table.recipientPrincipalId,
    ),
    check(
      "notification_intents_source_service_key_valid",
      sql`${table.sourceServiceKey} ~ '^[a-z][a-z0-9_.-]{0,127}$'`,
    ),
    check(
      "notification_intents_state_valid",
      sql`${table.state} IN (
        'pending',
        'retrying',
        'projected',
        'withheld_membership',
        'withheld_service_inactive',
        'withheld_target_denied',
        'withheld_target_missing',
        'poisoned'
      )`,
    ),
    check("notification_intents_attempt_count_valid", sql`${table.attemptCount} BETWEEN 0 AND 8`),
    check(
      "notification_intents_failure_code_valid",
      sql`${table.lastFailureCode} IS NULL
          OR ${table.lastFailureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
    check(
      "notification_intents_payload_object",
      sql`jsonb_typeof(${table.intentPayload}) = 'object'`,
    ),
    check(
      "notification_intents_terminal_shape",
      sql`(
        ${table.state} IN ('pending', 'retrying')
        AND ${table.terminalAt} IS NULL
        AND ${table.payloadRedactedAt} IS NULL
      ) OR (
        ${table.state} = 'poisoned'
        AND ${table.terminalAt} IS NOT NULL
        AND ${table.payloadRedactedAt} IS NULL
      ) OR (
        ${table.state} NOT IN ('pending', 'retrying', 'poisoned')
        AND ${table.terminalAt} IS NOT NULL
        AND ${table.payloadRedactedAt} IS NOT NULL
      )`,
    ),
    check("notification_intents_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const notificationProjections = pgTable(
  "notification_projections",
  {
    notificationId: uuid("notification_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    recipientPrincipalId: uuid("recipient_principal_id").notNull(),
    intentId: uuid("intent_id").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    sourceServiceKey: text("source_service_key").notNull(),
    category: text("category").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    safeSummary: varchar("safe_summary", { length: 240 }).notNull(),
    targetKind: text("target_kind").notNull(),
    targetResourceId: uuid("target_resource_id"),
    targetHref: text("target_href").notNull(),
    targetReadCapabilityId: text("target_read_capability_id").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    readAt: timestamp("read_at", { mode: "date", withTimezone: true }),
    retentionStatus: text("retention_status").default("active").notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    unique("notification_projections_tenant_notification_uq").on(
      table.tenantId,
      table.notificationId,
    ),
    unique("notification_projections_source_recipient_uq").on(
      table.tenantId,
      table.sourceEventId,
      table.recipientPrincipalId,
    ),
    unique("notification_projections_intent_uq").on(table.tenantId, table.intentId),
    foreignKey({
      columns: [table.tenantId, table.recipientPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "notification_projections_recipient_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [notificationIntents.tenantId, notificationIntents.intentId],
      name: "notification_projections_intent_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.sourceEventId],
      foreignColumns: [outboxEvents.tenantId, outboxEvents.eventId],
      name: "notification_projections_source_event_same_tenant_fk",
    }).onDelete("restrict"),
    index("notification_projections_recipient_cursor_idx").on(
      table.tenantId,
      table.recipientPrincipalId,
      table.occurredAt.desc(),
      table.notificationId.desc(),
    ),
    index("notification_projections_recipient_unread_idx")
      .on(
        table.tenantId,
        table.recipientPrincipalId,
        table.occurredAt.desc(),
        table.notificationId.desc(),
      )
      .where(sql`${table.readAt} IS NULL AND ${table.retentionStatus} = 'active'`),
    index("notification_projections_retention_idx").on(
      table.tenantId,
      table.occurredAt,
      table.notificationId,
    ),
    check(
      "notification_projections_source_service_key_valid",
      sql`${table.sourceServiceKey} ~ '^[a-z][a-z0-9_.-]{0,127}$'`,
    ),
    check(
      "notification_projections_category_valid",
      sql`${table.category} ~ '^[a-z][a-z0-9_.-]{0,127}$'`,
    ),
    check("notification_projections_title_not_blank", sql`char_length(trim(${table.title})) > 0`),
    check(
      "notification_projections_summary_not_blank",
      sql`char_length(trim(${table.safeSummary})) > 0`,
    ),
    check(
      "notification_projections_target_kind_valid",
      sql`${table.targetKind} IN (
        'hr.attendance.detail',
        'hr.employment_record.detail',
        'hr.expense_claim.detail',
        'hr.leave_request.detail',
        'hr.shift_assignment.detail',
        'hr.shift_assignment.own_shifts',
        'hr.timesheet.detail',
        'hr.workforce_profile.detail',
        'hr.workforce_profile.direct_reports'
      )`,
    ),
    check(
      "notification_projections_target_resource_shape",
      sql`(${table.targetKind} IN (
              'hr.shift_assignment.own_shifts',
              'hr.workforce_profile.direct_reports'
            )
            AND ${table.targetResourceId} IS NULL)
          OR (${table.targetKind} NOT IN (
              'hr.shift_assignment.own_shifts',
              'hr.workforce_profile.direct_reports'
            )
            AND ${table.targetResourceId} IS NOT NULL)`,
    ),
    check(
      "notification_projections_target_href_valid",
      sql`${table.targetHref} ~ '^/[^/[:space:]#][^[:space:]#]*([?][^#[:space:]]*)?$'`,
    ),
    check(
      "notification_projections_target_capability_valid",
      sql`${table.targetReadCapabilityId} ~ '^[a-z][a-z0-9_.-]{0,127}$'`,
    ),
    check(
      "notification_projections_retention_status_valid",
      sql`${table.retentionStatus} = 'active'`,
    ),
    check("notification_projections_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const notificationProjectionReceipts = pgTable(
  "notification_projection_receipts",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    consumerKey: text("consumer_key").notNull(),
    consumerVersion: integer("consumer_version").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    recipientPrincipalId: uuid("recipient_principal_id").notNull(),
    intentId: uuid("intent_id").notNull(),
    notificationId: uuid("notification_id"),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.consumerKey,
        table.consumerVersion,
        table.sourceEventId,
        table.recipientPrincipalId,
      ],
      name: "notification_projection_receipts_pk",
    }),
    unique("notification_projection_receipts_intent_uq").on(
      table.tenantId,
      table.consumerKey,
      table.consumerVersion,
      table.intentId,
    ),
    foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [notificationIntents.tenantId, notificationIntents.intentId],
      name: "notification_projection_receipts_intent_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.sourceEventId],
      foreignColumns: [outboxEvents.tenantId, outboxEvents.eventId],
      name: "notification_projection_receipts_source_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.notificationId],
      foreignColumns: [notificationProjections.tenantId, notificationProjections.notificationId],
      name: "notification_projection_receipts_projection_same_tenant_fk",
    }).onDelete("restrict"),
    index("notification_projection_receipts_source_idx").on(
      table.tenantId,
      table.sourceEventId,
      table.recipientPrincipalId,
    ),
    check(
      "notification_projection_receipts_consumer_exact",
      sql`${table.consumerKey} = 'platform.notifications.projector'
          AND ${table.consumerVersion} = 1`,
    ),
    check(
      "notification_projection_receipts_outcome_valid",
      sql`${table.outcome} IN (
        'projected',
        'withheld_membership',
        'withheld_service_inactive',
        'withheld_target_denied',
        'withheld_target_missing'
      )`,
    ),
    check(
      "notification_projection_receipts_projection_shape",
      sql`(${table.outcome} = 'projected' AND ${table.notificationId} IS NOT NULL)
          OR (${table.outcome} <> 'projected' AND ${table.notificationId} IS NULL)`,
    ),
  ],
).enableRLS();

export const notificationProjectorEvidence = pgTable(
  "notification_projector_evidence",
  {
    evidenceEventId: uuid("evidence_event_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    intentId: uuid("intent_id").notNull(),
    sourceEventId: uuid("source_event_id").notNull(),
    eventType: text("event_type").notNull(),
    resultCode: text("result_code").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.intentId],
      foreignColumns: [notificationIntents.tenantId, notificationIntents.intentId],
      name: "notification_projector_evidence_intent_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.sourceEventId],
      foreignColumns: [outboxEvents.tenantId, outboxEvents.eventId],
      name: "notification_projector_evidence_source_same_tenant_fk",
    }).onDelete("restrict"),
    index("notification_projector_evidence_tenant_source_idx").on(
      table.tenantId,
      table.sourceEventId,
      table.occurredAt,
    ),
    check(
      "notification_projector_evidence_event_type_valid",
      sql`${table.eventType} IN (
        'platform.notifications.projected',
        'platform.notifications.withheld',
        'platform.notifications.retry_scheduled',
        'platform.notifications.poisoned'
      )`,
    ),
    check(
      "notification_projector_evidence_result_code_valid",
      sql`${table.resultCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
  ],
).enableRLS();
