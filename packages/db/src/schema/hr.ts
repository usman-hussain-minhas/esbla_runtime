import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { memberships, serviceActivationState, serviceActivations, tenants } from "./core.js";

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

export const hrWorkerProfiles = pgTable(
  "hr_worker_profiles",
  {
    workerProfileId: uuid("worker_profile_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    principalId: uuid("principal_id"),
    employeeNumber: varchar("employee_number", { length: 64 }),
    workforceStatus: hrWorkforceStatus("workforce_status").default("draft").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    currentReportingRelationshipId: uuid("current_reporting_relationship_id"),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "hr_worker_profiles_principal_same_tenant_fk",
    }).onDelete("restrict"),
    unique("hr_worker_profiles_tenant_worker_profile_uq").on(table.tenantId, table.workerProfileId),
    uniqueIndex("uq_hr_worker_profiles_tenant_principal_current")
      .on(table.tenantId, table.principalId)
      .where(sql`${table.principalId} IS NOT NULL AND ${table.workforceStatus} <> 'terminated'`),
    index("idx_hr_worker_profiles_tenant_status_cursor").on(
      table.tenantId,
      table.workforceStatus,
      table.createdAt.desc(),
      table.workerProfileId.desc(),
    ),
    check(
      "hr_worker_profiles_employee_number_valid",
      sql`${table.employeeNumber} IS NULL OR char_length(trim(${table.employeeNumber})) BETWEEN 1 AND 64`,
    ),
    check(
      "hr_worker_profiles_active_principal_link_required",
      sql`${table.workforceStatus} <> 'active' OR ${table.principalId} IS NOT NULL`,
    ),
    check(
      "hr_worker_profiles_relationship_head_reserved",
      sql`${table.currentReportingRelationshipId} IS NULL`,
    ),
    check("hr_worker_profiles_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrWorkforceStatusHistory = pgTable(
  "hr_workforce_status_history",
  {
    workforceStatusHistoryId: uuid("workforce_status_history_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    workerProfileId: uuid("worker_profile_id").notNull(),
    previousStatus: hrWorkforceStatus("previous_status"),
    newStatus: hrWorkforceStatus("new_status").notNull(),
    effectiveAt: timestamp("effective_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkerProfiles.tenantId, hrWorkerProfiles.workerProfileId],
      name: "hr_workforce_status_history_worker_same_tenant_fk",
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
    check(
      "hr_workforce_status_history_transition_changes_status",
      sql`${table.previousStatus} IS NULL OR ${table.previousStatus} <> ${table.newStatus}`,
    ),
  ],
).enableRLS();

export const hrWorkforceProfileServiceControl = pgTable(
  "hr_workforce_profile_service_control",
  {
    serviceControlId: uuid("service_control_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    serviceKey: text("service_key").default("workforce_profile").notNull(),
    activationState: serviceActivationState("activation_state").notNull(),
    activationVersion: integer("activation_version").default(1).notNull(),
    settingsVersion: integer("settings_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
      name: "hr_wfp_service_control_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.serviceKey],
      foreignColumns: [serviceActivations.tenantId, serviceActivations.serviceKey],
      name: "hr_workforce_profile_service_control_activation_fk",
    }).onDelete("restrict"),
    unique("uq_hr_workforce_profile_service_control_tenant_key").on(
      table.tenantId,
      table.serviceKey,
    ),
    check(
      "hr_workforce_profile_service_control_key_exact",
      sql`${table.serviceKey} = 'workforce_profile'`,
    ),
    check(
      "hr_wfp_service_control_activation_version_positive",
      sql`${table.activationVersion} > 0`,
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
