import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  type PgTableExtraConfigValue,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { memberships, serviceActivations, tenants } from "./core.js";

export const hrLeaveCategory = pgEnum("hr_leave_category", ["annual", "sick", "unpaid", "other"]);
export const hrLeaveRequestStatus = pgEnum("hr_leave_request_status", [
  "submitted",
  "approved",
  "rejected",
]);
export const hrWorkforceStatus = pgEnum("hr_workforce_status", [
  "draft",
  "active",
  "suspended",
  "terminated",
]);
export const hrReportingRelationshipStatus = pgEnum("hr_reporting_relationship_status", [
  "assigned",
  "unassigned",
]);
export const hrEmploymentRecordStatus = pgEnum("hr_employment_record_status", [
  "draft",
  "active",
  "ended",
]);
export const hrEmploymentVersionKind = pgEnum("hr_employment_version_kind", ["effective", "end"]);

type PgTableExtras = PgTableExtraConfigValue[];

export const hrEmploymentRecordServiceControl = pgTable(
  "hr_employment_record_service_control",
  {
    serviceControlId: uuid("service_control_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    serviceKey: text("service_key").default("employment_record").notNull(),
    settingsVersion: integer("settings_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceKey],
      foreignColumns: [serviceActivations.tenantId, serviceActivations.serviceKey],
      name: "hr_employment_record_service_control_activation_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_employment_record_service_control_tenant_key").on(
      table.tenantId,
      table.serviceKey,
    ),
    check(
      "hr_employment_record_service_control_key_exact",
      sql`${table.serviceKey} = 'employment_record'`,
    ),
    check(
      "hr_employment_record_service_control_settings_version_positive",
      sql`${table.settingsVersion} > 0`,
    ),
    check(
      "hr_employment_record_service_control_row_version_positive",
      sql`${table.rowVersion} > 0`,
    ),
  ],
).enableRLS();

export const hrEmploymentRecords = pgTable(
  "hr_employment_records",
  {
    employmentRecordId: uuid("employment_record_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    workerProfileId: uuid("worker_profile_id").notNull(),
    status: hrEmploymentRecordStatus("status").default("draft").notNull(),
    currentVersionId: uuid("current_version_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    unique("uq_hr_employment_records_composite_identity").on(
      table.tenantId,
      table.employmentRecordId,
    ),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_employment_records_worker_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.employmentRecordId, table.currentVersionId],
      foreignColumns: [
        hrEmploymentRecordVersions.tenantId,
        hrEmploymentRecordVersions.employmentRecordId,
        hrEmploymentRecordVersions.employmentRecordVersionId,
      ],
      name: "hr_employment_records_current_version_same_root_fk",
    }).onDelete("restrict"),
    index("idx_hr_employment_records_tenant_cursor").on(
      table.tenantId,
      table.workerProfileId,
      table.createdAt.desc(),
      table.employmentRecordId.desc(),
    ),
    index("idx_hr_employment_records_tenant_order_cursor").on(
      table.tenantId,
      table.createdAt.desc(),
      table.employmentRecordId.desc(),
    ),
    index("idx_hr_employment_records_tenant_worker_active_head").on(
      table.tenantId,
      table.workerProfileId,
      table.status,
      table.employmentRecordId,
    ),
    uniqueIndex("uq_hr_employment_records_tenant_worker_current")
      .on(table.tenantId, table.workerProfileId)
      .where(sql`${table.status} <> 'ended'`),
    check(
      "hr_employment_records_status_head_consistent",
      sql`(${table.status} = 'draft' AND ${table.currentVersionId} IS NULL)
          OR (${table.status} IN ('active', 'ended') AND ${table.currentVersionId} IS NOT NULL)`,
    ),
    check("hr_employment_records_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrEmploymentRecordVersions = pgTable(
  "hr_employment_record_versions",
  {
    employmentRecordVersionId: uuid("employment_record_version_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    employmentRecordId: uuid("employment_record_id").notNull(),
    workerProfileId: uuid("worker_profile_id").notNull(),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    employmentTypeCode: text("employment_type_code"),
    organizationReference: text("organization_reference"),
    positionReference: text("position_reference"),
    supersedesVersionId: uuid("supersedes_version_id"),
    version: integer("version").notNull(),
    versionKind: hrEmploymentVersionKind("version_kind").notNull(),
    terminalVersion: boolean("terminal_version").default(false).notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
      name: "hr_employment_record_versions_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.employmentRecordId],
      foreignColumns: [hrEmploymentRecords.tenantId, hrEmploymentRecords.employmentRecordId],
      name: "hr_employment_record_versions_record_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_employment_record_versions_worker_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.employmentRecordId, table.supersedesVersionId],
      foreignColumns: [table.tenantId, table.employmentRecordId, table.employmentRecordVersionId],
      name: "hr_employment_record_versions_predecessor_same_root_fk",
    }).onDelete("restrict"),
    unique("uq_hr_employment_record_versions_composite_identity").on(
      table.tenantId,
      table.employmentRecordId,
      table.employmentRecordVersionId,
    ),
    uniqueIndex("uq_hr_employment_record_versions_tenant_record_version").on(
      table.tenantId,
      table.employmentRecordId,
      table.version,
    ),
    uniqueIndex("uq_hr_employment_record_versions_tenant_successor")
      .on(table.tenantId, table.employmentRecordId, table.supersedesVersionId)
      .where(sql`${table.supersedesVersionId} IS NOT NULL`),
    index("idx_hr_employment_record_versions_tenant_record_cursor").on(
      table.tenantId,
      table.employmentRecordId,
      table.version.desc(),
      table.employmentRecordVersionId.desc(),
    ),
    check(
      "hr_employment_record_versions_effective_range_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} >= ${table.effectiveFrom}`,
    ),
    check(
      "hr_employment_record_versions_identifier_values_valid",
      sql`(${table.employmentTypeCode} IS NULL OR char_length(trim(${table.employmentTypeCode})) > 0)
          AND (${table.organizationReference} IS NULL OR char_length(trim(${table.organizationReference})) > 0)
          AND (${table.positionReference} IS NULL OR char_length(trim(${table.positionReference})) > 0)`,
    ),
    check(
      "hr_employment_record_versions_predecessor_version_consistent",
      sql`(${table.version} = 1 AND ${table.supersedesVersionId} IS NULL)
          OR (${table.version} > 1 AND ${table.supersedesVersionId} IS NOT NULL)`,
    ),
    check(
      "hr_employment_record_versions_terminal_kind_consistent",
      sql`(${table.versionKind} = 'effective' AND ${table.terminalVersion} = false)
          OR (${table.versionKind} = 'end' AND ${table.terminalVersion} = true
              AND ${table.effectiveTo} IS NOT NULL)`,
    ),
    check("hr_employment_record_versions_version_positive", sql`${table.version} > 0`),
    check("hr_employment_record_versions_row_version_fixed", sql`${table.rowVersion} = 1`),
  ],
).enableRLS();

export const hrWorkforceProfileServiceControl = pgTable(
  "hr_workforce_profile_service_control",
  {
    serviceControlId: uuid("service_control_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    serviceKey: text("service_key").default("workforce_profile").notNull(),
    settingsVersion: integer("settings_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceKey],
      foreignColumns: [serviceActivations.tenantId, serviceActivations.serviceKey],
      name: "hr_workforce_profile_service_control_activation_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_workforce_profile_service_control_tenant_key").on(
      table.tenantId,
      table.serviceKey,
    ),
    check(
      "hr_workforce_profile_service_control_key_exact",
      sql`${table.serviceKey} = 'workforce_profile'`,
    ),
    check(
      "hr_workforce_profile_service_control_settings_version_positive",
      sql`${table.settingsVersion} > 0`,
    ),
    check(
      "hr_workforce_profile_service_control_row_version_positive",
      sql`${table.rowVersion} > 0`,
    ),
  ],
).enableRLS();

export const hrWorkforceProfiles = pgTable(
  "hr_worker_profiles",
  {
    workerProfileId: uuid("worker_profile_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    principalId: uuid("principal_id"),
    employeeNumber: text("employee_number"),
    workforceStatus: hrWorkforceStatus("workforce_status").default("draft").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    currentReportingRelationshipId: uuid("current_reporting_relationship_id"),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "hr_worker_profiles_principal_same_tenant_fk",
    }).onDelete("restrict"),
    unique("hr_worker_profiles_tenant_profile_uq").on(table.tenantId, table.workerProfileId),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId, table.currentReportingRelationshipId],
      foreignColumns: [
        hrReportingRelationships.tenantId,
        hrReportingRelationships.workerProfileId,
        hrReportingRelationships.reportingRelationshipId,
      ],
      name: "hr_worker_profiles_current_relationship_same_root_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_worker_profiles_tenant_principal_current")
      .on(table.tenantId, table.principalId)
      .where(sql`${table.principalId} IS NOT NULL AND ${table.workforceStatus} <> 'terminated'`),
    index("idx_hr_worker_profiles_tenant_principal_fk").on(table.tenantId, table.principalId),
    index("idx_hr_worker_profiles_tenant_status_cursor").on(
      table.tenantId,
      table.workforceStatus,
      table.createdAt.desc(),
      table.workerProfileId.desc(),
    ),
    uniqueIndex("uq_hr_worker_profiles_tenant_relationship_head")
      .on(table.tenantId, table.currentReportingRelationshipId)
      .where(sql`${table.currentReportingRelationshipId} IS NOT NULL`),
    check(
      "hr_worker_profiles_employee_number_not_blank",
      sql`${table.employeeNumber} IS NULL OR char_length(trim(${table.employeeNumber})) > 0`,
    ),
    check("hr_worker_profiles_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrReportingRelationships = pgTable(
  "hr_reporting_relationships",
  {
    reportingRelationshipId: uuid("reporting_relationship_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workerProfileId: uuid("worker_profile_id").notNull(),
    managerWorkerProfileId: uuid("manager_worker_profile_id"),
    relationshipStatus: hrReportingRelationshipStatus("relationship_status").notNull(),
    effectiveAt: timestamp("effective_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    supersedesReportingRelationshipId: uuid("supersedes_reporting_relationship_id"),
    relationshipVersion: integer("relationship_version").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
      name: "hr_reporting_relationships_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_reporting_relationships_report_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.managerWorkerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_reporting_relationships_manager_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId, table.supersedesReportingRelationshipId],
      foreignColumns: [table.tenantId, table.workerProfileId, table.reportingRelationshipId],
      name: "hr_reporting_relationships_predecessor_same_worker_fk",
    }).onDelete("restrict"),
    unique("uq_hr_reporting_relationships_composite_identity").on(
      table.tenantId,
      table.workerProfileId,
      table.reportingRelationshipId,
    ),
    uniqueIndex("uq_hr_reporting_relationships_tenant_worker_version").on(
      table.tenantId,
      table.workerProfileId,
      table.relationshipVersion,
    ),
    uniqueIndex("uq_hr_reporting_relationships_tenant_successor")
      .on(table.tenantId, table.supersedesReportingRelationshipId)
      .where(sql`${table.supersedesReportingRelationshipId} IS NOT NULL`),
    index("idx_hr_reporting_relationships_tenant_manager_current_cursor").on(
      table.tenantId,
      table.managerWorkerProfileId,
      table.relationshipStatus,
      sql`${table.effectiveAt} DESC`,
      sql`${table.reportingRelationshipId} DESC`,
    ),
    index("idx_hr_reporting_relationships_tenant_worker_history").on(
      table.tenantId,
      table.workerProfileId,
      sql`${table.relationshipVersion} DESC`,
      sql`${table.reportingRelationshipId} DESC`,
    ),
    check(
      "hr_reporting_relationships_status_manager_consistent",
      sql`(${table.relationshipStatus} = 'assigned' AND ${table.managerWorkerProfileId} IS NOT NULL)
          OR (${table.relationshipStatus} = 'unassigned' AND ${table.managerWorkerProfileId} IS NULL)`,
    ),
    check(
      "hr_reporting_relationships_relationship_version_positive",
      sql`${table.relationshipVersion} > 0`,
    ),
    check("hr_reporting_relationships_row_version_fixed", sql`${table.rowVersion} = 1`),
  ],
).enableRLS();

export const hrWorkforceStatusHistory = pgTable(
  "hr_workforce_status_history",
  {
    workforceStatusHistoryId: uuid("workforce_status_history_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    workerProfileId: uuid("worker_profile_id").notNull(),
    previousStatus: hrWorkforceStatus("previous_status"),
    newStatus: hrWorkforceStatus("new_status").notNull(),
    effectiveAt: timestamp("effective_at", { mode: "date", withTimezone: true }).notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
      name: "hr_workforce_status_history_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_workforce_status_history_profile_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.actorPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "hr_workforce_status_history_actor_same_tenant_fk",
    }).onDelete("restrict"),
    index("idx_hr_workforce_status_history_tenant_worker_effective").on(
      table.tenantId,
      table.workerProfileId,
      table.effectiveAt.desc(),
      table.workforceStatusHistoryId.desc(),
    ),
    index("idx_hr_workforce_status_history_tenant_actor_fk").on(
      table.tenantId,
      table.actorPrincipalId,
    ),
    check(
      "hr_workforce_status_history_transition_valid",
      sql`((${table.previousStatus} IS NULL AND ${table.newStatus} = 'draft') OR
          (${table.previousStatus} = 'draft' AND ${table.newStatus} = 'active') OR
          (${table.previousStatus} = 'active' AND ${table.newStatus} IN ('suspended', 'terminated')) OR
          (${table.previousStatus} = 'suspended' AND ${table.newStatus} IN ('active', 'terminated'))) IS TRUE`,
    ),
  ],
).enableRLS();

export const hrLeaveRequests = pgTable(
  "hr_leave_requests",
  {
    leaveRequestId: uuid("leave_request_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    employeePrincipalId: uuid("employee_principal_id").notNull(),
    approverPrincipalId: uuid("approver_principal_id").notNull(),
    categoryCode: hrLeaveCategory("category_code").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    reason: text("reason"),
    status: hrLeaveRequestStatus("status").default("submitted").notNull(),
    decisionNote: text("decision_note"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    version: integer("version").default(1).notNull(),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.employeePrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "hr_leave_requests_employee_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.approverPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "hr_leave_requests_approver_same_tenant_fk",
    }).onDelete("restrict"),
    unique("hr_leave_requests_tenant_employee_idempotency_uq").on(
      table.tenantId,
      table.employeePrincipalId,
      table.idempotencyKey,
    ),
    index("hr_leave_requests_assigned_open_idx")
      .on(table.tenantId, table.approverPrincipalId, table.submittedAt, table.leaveRequestId)
      .where(sql`${table.status} = 'submitted'`),
    index("hr_leave_requests_employee_history_idx").on(
      table.tenantId,
      table.employeePrincipalId,
      table.submittedAt.desc(),
      table.leaveRequestId.desc(),
    ),
    check("hr_leave_requests_dates_valid", sql`${table.endDate} >= ${table.startDate}`),
    check(
      "hr_leave_requests_distinct_approver",
      sql`${table.employeePrincipalId} <> ${table.approverPrincipalId}`,
    ),
    check(
      "hr_leave_requests_reason_valid",
      sql`${table.reason} IS NULL OR (char_length(trim(${table.reason})) BETWEEN 1 AND 2000)`,
    ),
    check(
      "hr_leave_requests_decision_note_valid",
      sql`${table.decisionNote} IS NULL OR (char_length(trim(${table.decisionNote})) BETWEEN 1 AND 2000)`,
    ),
    check(
      "hr_leave_requests_decision_consistent",
      sql`(${table.status} = 'submitted' AND ${table.decidedAt} IS NULL AND ${table.decisionNote} IS NULL) OR (${table.status} IN ('approved', 'rejected') AND ${table.decidedAt} IS NOT NULL)`,
    ),
    check(
      "hr_leave_requests_idempotency_not_blank",
      sql`char_length(trim(${table.idempotencyKey})) > 0`,
    ),
    check("hr_leave_requests_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();
