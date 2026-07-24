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
export const hrShiftRosterStatus = pgEnum("hr_shift_roster_status", [
  "draft",
  "published",
  "superseded",
]);
export const hrShiftAssignmentStatus = pgEnum("hr_shift_assignment_status", [
  "active",
  "cancelled",
]);
export const hrAttendanceObservationKind = pgEnum("hr_attendance_observation_kind", [
  "presence_start",
  "presence_end",
]);
export const hrAttendanceSourceKind = pgEnum("hr_attendance_source_kind", ["manual", "synthetic"]);
export const hrTimesheetStatus = pgEnum("hr_timesheet_status", [
  "draft",
  "submitted",
  "approved",
  "rejected",
]);
export const hrTimesheetDecision = pgEnum("hr_timesheet_decision", ["approved", "rejected"]);

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

export const hrShiftAssignmentServiceControl = pgTable(
  "hr_shift_assignment_service_control",
  {
    serviceControlId: uuid("service_control_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    serviceKey: text("service_key").default("shift_assignment").notNull(),
    settingsVersion: integer("settings_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceKey],
      foreignColumns: [serviceActivations.tenantId, serviceActivations.serviceKey],
      name: "hr_shift_assignment_service_control_activation_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_shift_assignment_service_control_tenant_key").on(
      table.tenantId,
      table.serviceKey,
    ),
    check(
      "hr_shift_assignment_service_control_key_exact",
      sql`${table.serviceKey} = 'shift_assignment'`,
    ),
    check(
      "hr_shift_assignment_service_control_settings_version_positive",
      sql`${table.settingsVersion} > 0`,
    ),
    check("hr_shift_assignment_service_control_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrShiftRosterVersions = pgTable(
  "hr_shift_roster_versions",
  {
    rosterVersionId: uuid("roster_version_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    status: hrShiftRosterStatus("status").default("draft").notNull(),
    version: integer("version").notNull(),
    supersedesRosterVersionId: uuid("supersedes_roster_version_id"),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    unique("uq_hr_shift_roster_versions_composite_identity").on(
      table.tenantId,
      table.rosterVersionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.supersedesRosterVersionId],
      foreignColumns: [table.tenantId, table.rosterVersionId],
      name: "hr_shift_roster_versions_predecessor_same_tenant_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_shift_roster_versions_tenant_period_version").on(
      table.tenantId,
      table.periodStart,
      table.periodEnd,
      table.version,
    ),
    uniqueIndex("uq_hr_shift_rosters_tenant_period_published")
      .on(table.tenantId, table.periodStart, table.periodEnd, table.status)
      .where(sql`${table.status} = 'published'`),
    uniqueIndex("uq_hr_shift_rosters_tenant_period_draft")
      .on(table.tenantId, table.periodStart, table.periodEnd, table.status)
      .where(sql`${table.status} = 'draft'`),
    uniqueIndex("uq_hr_shift_rosters_tenant_period_successor")
      .on(table.tenantId, table.periodStart, table.periodEnd, table.supersedesRosterVersionId)
      .where(sql`${table.supersedesRosterVersionId} IS NOT NULL`),
    check("hr_shift_roster_versions_period_valid", sql`${table.periodEnd} >= ${table.periodStart}`),
    check(
      "hr_shift_roster_versions_publication_consistent",
      sql`(${table.status} = 'draft' AND ${table.publishedAt} IS NULL
             AND ${table.supersedesRosterVersionId} IS NULL)
          OR (${table.status} IN ('published', 'superseded') AND ${table.publishedAt} IS NOT NULL)`,
    ),
    check("hr_shift_roster_versions_version_positive", sql`${table.version} > 0`),
    check("hr_shift_roster_versions_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrShiftAssignments = pgTable(
  "hr_shift_assignments",
  {
    shiftAssignmentId: uuid("shift_assignment_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    rosterVersionId: uuid("roster_version_id").notNull(),
    workerProfileId: uuid("worker_profile_id").notNull(),
    startsAt: timestamp("starts_at", { mode: "date", withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { mode: "date", withTimezone: true }).notNull(),
    ianaTimezone: text("iana_timezone").notNull(),
    status: hrShiftAssignmentStatus("status").default("active").notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    unique("uq_hr_shift_assignments_composite_identity").on(
      table.tenantId,
      table.shiftAssignmentId,
    ),
    foreignKey({
      columns: [table.tenantId, table.rosterVersionId],
      foreignColumns: [hrShiftRosterVersions.tenantId, hrShiftRosterVersions.rosterVersionId],
      name: "hr_shift_assignments_roster_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_shift_assignments_worker_same_tenant_fk",
    }).onDelete("restrict"),
    index("idx_hr_shift_assignments_tenant_worker_start").on(
      table.tenantId,
      table.workerProfileId,
      table.startsAt,
      table.shiftAssignmentId,
    ),
    index("idx_hr_shift_assignments_tenant_roster_status_start").on(
      table.tenantId,
      table.rosterVersionId,
      table.status,
      table.startsAt,
      table.shiftAssignmentId,
    ),
    index("idx_hr_shift_assignments_tenant_worker_overlap").on(
      table.tenantId,
      table.workerProfileId,
      table.status,
      table.startsAt,
      table.shiftAssignmentId,
    ),
    check("hr_shift_assignments_time_range_valid", sql`${table.endsAt} > ${table.startsAt}`),
    check(
      "hr_shift_assignments_iana_timezone_not_blank",
      sql`char_length(trim(${table.ianaTimezone})) > 0`,
    ),
    check("hr_shift_assignments_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrAttendanceServiceControl = pgTable(
  "hr_attendance_service_control",
  {
    serviceControlId: uuid("service_control_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    serviceKey: text("service_key").default("attendance").notNull(),
    settingsVersion: integer("settings_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceKey],
      foreignColumns: [serviceActivations.tenantId, serviceActivations.serviceKey],
      name: "hr_attendance_service_control_activation_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_attendance_service_control_tenant_key").on(table.tenantId, table.serviceKey),
    check("hr_attendance_service_control_key_exact", sql`${table.serviceKey} = 'attendance'`),
    check(
      "hr_attendance_service_control_settings_version_positive",
      sql`${table.settingsVersion} > 0`,
    ),
    check("hr_attendance_service_control_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrAttendanceObservations = pgTable(
  "hr_attendance_observations",
  {
    attendanceObservationId: uuid("attendance_observation_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    workerProfileId: uuid("worker_profile_id").notNull(),
    observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull(),
    observationKind: hrAttendanceObservationKind("observation_kind").notNull(),
    sourceKind: hrAttendanceSourceKind("source_kind").notNull(),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    unique("uq_hr_attendance_observations_composite_identity").on(
      table.tenantId,
      table.attendanceObservationId,
    ),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_attendance_observations_worker_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.actorPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "hr_attendance_observations_actor_same_tenant_fk",
    }).onDelete("restrict"),
    index("idx_hr_attendance_observations_tenant_worker_observed").on(
      table.tenantId,
      table.workerProfileId,
      table.observedAt.desc(),
      table.attendanceObservationId.desc(),
    ),
    index("idx_hr_attendance_observations_tenant_observed").on(
      table.tenantId,
      table.observedAt.desc(),
      table.attendanceObservationId.desc(),
    ),
    check("hr_attendance_observations_row_version_fixed", sql`${table.rowVersion} = 1`),
  ],
).enableRLS();

export const hrAttendanceCorrections = pgTable(
  "hr_attendance_corrections",
  {
    attendanceCorrectionId: uuid("attendance_correction_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    attendanceObservationId: uuid("attendance_observation_id").notNull(),
    correctedObservedAt: timestamp("corrected_observed_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    correctedObservationKind: hrAttendanceObservationKind("corrected_observation_kind").notNull(),
    reason: text("reason").notNull(),
    correctionVersion: integer("correction_version").notNull(),
    supersedesAttendanceCorrectionId: uuid("supersedes_attendance_correction_id"),
    actorPrincipalId: uuid("actor_principal_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table): PgTableExtras => [
    unique("uq_hr_attendance_corrections_composite_identity").on(
      table.tenantId,
      table.attendanceObservationId,
      table.attendanceCorrectionId,
    ),
    foreignKey({
      columns: [table.tenantId, table.attendanceObservationId],
      foreignColumns: [
        hrAttendanceObservations.tenantId,
        hrAttendanceObservations.attendanceObservationId,
      ],
      name: "hr_attendance_corrections_observation_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.tenantId,
        table.attendanceObservationId,
        table.supersedesAttendanceCorrectionId,
      ],
      foreignColumns: [table.tenantId, table.attendanceObservationId, table.attendanceCorrectionId],
      name: "hr_attendance_corrections_predecessor_same_root_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.actorPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "hr_attendance_corrections_actor_same_tenant_fk",
    }).onDelete("restrict"),
    index("idx_hr_attendance_corrections_tenant_observation_version").on(
      table.tenantId,
      table.attendanceObservationId,
      table.correctionVersion.desc(),
      table.attendanceCorrectionId.desc(),
    ),
    uniqueIndex("uq_hr_attendance_corrections_tenant_observation_version").on(
      table.tenantId,
      table.attendanceObservationId,
      table.correctionVersion,
    ),
    uniqueIndex("uq_hr_attendance_corrections_tenant_successor")
      .on(table.tenantId, table.supersedesAttendanceCorrectionId)
      .where(sql`${table.supersedesAttendanceCorrectionId} IS NOT NULL`),
    check(
      "hr_attendance_corrections_reason_valid",
      sql`char_length(trim(${table.reason})) BETWEEN 1 AND 2000`,
    ),
    check(
      "hr_attendance_corrections_predecessor_version_consistent",
      sql`(${table.correctionVersion} = 1
              AND ${table.supersedesAttendanceCorrectionId} IS NULL)
          OR (${table.correctionVersion} > 1
              AND ${table.supersedesAttendanceCorrectionId} IS NOT NULL)`,
    ),
    check("hr_attendance_corrections_version_positive", sql`${table.correctionVersion} > 0`),
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

export const hrTimesheetServiceControl = pgTable(
  "hr_timesheet_service_control",
  {
    serviceControlId: uuid("service_control_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    serviceKey: text("service_key").default("timesheet").notNull(),
    settingsVersion: integer("settings_version").default(1).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.serviceKey],
      foreignColumns: [serviceActivations.tenantId, serviceActivations.serviceKey],
      name: "hr_timesheet_service_control_activation_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_timesheet_service_control_tenant_key").on(table.tenantId, table.serviceKey),
    check("hr_timesheet_service_control_key_exact", sql`${table.serviceKey} = 'timesheet'`),
    check(
      "hr_timesheet_service_control_settings_version_positive",
      sql`${table.settingsVersion} > 0`,
    ),
    check("hr_timesheet_service_control_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrTimesheets = pgTable(
  "hr_timesheets",
  {
    timesheetId: uuid("timesheet_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    workerProfileId: uuid("worker_profile_id").notNull(),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    currentVersionId: uuid("current_version_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    unique("uq_hr_timesheets_composite_identity").on(table.tenantId, table.timesheetId),
    foreignKey({
      columns: [table.tenantId, table.workerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_timesheets_worker_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.timesheetId, table.currentVersionId],
      foreignColumns: [
        hrTimesheetVersions.tenantId,
        hrTimesheetVersions.timesheetId,
        hrTimesheetVersions.timesheetVersionId,
      ],
      name: "hr_timesheets_current_version_same_root_fk",
    }).onDelete("restrict"),
    index("idx_hr_timesheets_tenant_worker_period_cursor").on(
      table.tenantId,
      table.workerProfileId,
      table.periodStart.desc(),
      table.timesheetId.desc(),
    ),
    uniqueIndex("uq_hr_timesheets_tenant_worker_period").on(
      table.tenantId,
      table.workerProfileId,
      table.periodStart,
      table.periodEnd,
    ),
    check("hr_timesheets_period_valid", sql`${table.periodEnd} >= ${table.periodStart}`),
    check("hr_timesheets_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrTimesheetVersions = pgTable(
  "hr_timesheet_versions",
  {
    timesheetVersionId: uuid("timesheet_version_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    timesheetId: uuid("timesheet_id").notNull(),
    supersedesVersionId: uuid("supersedes_version_id"),
    version: integer("version").notNull(),
    status: hrTimesheetStatus("status").default("draft").notNull(),
    assignedApproverWorkerProfileId: uuid("assigned_approver_worker_profile_id"),
    submittedAt: timestamp("submitted_at", { mode: "date", withTimezone: true }),
    totalMinutes: integer("total_minutes").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table): PgTableExtras => [
    foreignKey({
      columns: [table.tenantId, table.timesheetId],
      foreignColumns: [hrTimesheets.tenantId, hrTimesheets.timesheetId],
      name: "hr_timesheet_versions_timesheet_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.timesheetId, table.supersedesVersionId],
      foreignColumns: [table.tenantId, table.timesheetId, table.timesheetVersionId],
      name: "hr_timesheet_versions_predecessor_same_root_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.assignedApproverWorkerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_timesheet_versions_approver_same_tenant_fk",
    }).onDelete("restrict"),
    unique("uq_hr_timesheet_versions_composite_identity").on(
      table.tenantId,
      table.timesheetId,
      table.timesheetVersionId,
    ),
    unique("uq_hr_timesheet_versions_tenant_identity").on(table.tenantId, table.timesheetVersionId),
    uniqueIndex("uq_hr_timesheet_versions_tenant_number").on(
      table.tenantId,
      table.timesheetId,
      table.version,
    ),
    uniqueIndex("uq_hr_timesheet_versions_tenant_successor")
      .on(table.tenantId, table.timesheetId, table.supersedesVersionId)
      .where(sql`${table.supersedesVersionId} IS NOT NULL`),
    index("idx_hr_timesheet_versions_tenant_approver_submitted").on(
      table.tenantId,
      table.assignedApproverWorkerProfileId,
      table.status,
      table.submittedAt,
      table.timesheetVersionId,
    ),
    index("idx_hr_timesheet_versions_tenant_timesheet_cursor").on(
      table.tenantId,
      table.timesheetId,
      table.version.desc(),
      table.timesheetVersionId.desc(),
    ),
    check(
      "hr_timesheet_versions_predecessor_version_consistent",
      sql`(${table.version} = 1 AND ${table.supersedesVersionId} IS NULL)
          OR (${table.version} > 1 AND ${table.supersedesVersionId} IS NOT NULL)`,
    ),
    check(
      "hr_timesheet_versions_submission_consistent",
      sql`(${table.status} = 'draft'
            AND ${table.assignedApproverWorkerProfileId} IS NULL
            AND ${table.submittedAt} IS NULL)
          OR (${table.status} IN ('submitted', 'approved', 'rejected')
            AND ${table.assignedApproverWorkerProfileId} IS NOT NULL
            AND ${table.submittedAt} IS NOT NULL)`,
    ),
    check("hr_timesheet_versions_total_minutes_valid", sql`${table.totalMinutes} >= 0`),
    check("hr_timesheet_versions_version_positive", sql`${table.version} > 0`),
    check("hr_timesheet_versions_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrTimesheetEntries = pgTable(
  "hr_timesheet_entries",
  {
    timesheetEntryId: uuid("timesheet_entry_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    timesheetVersionId: uuid("timesheet_version_id").notNull(),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    minutes: integer("minutes").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.timesheetVersionId],
      foreignColumns: [hrTimesheetVersions.tenantId, hrTimesheetVersions.timesheetVersionId],
      name: "hr_timesheet_entries_version_same_tenant_fk",
    }).onDelete("restrict"),
    index("idx_hr_timesheet_entries_tenant_version_date").on(
      table.tenantId,
      table.timesheetVersionId,
      table.entryDate,
      table.timesheetEntryId,
    ),
    check("hr_timesheet_entries_minutes_valid", sql`${table.minutes} BETWEEN 1 AND 1440`),
    check(
      "hr_timesheet_entries_description_valid",
      sql`${table.description} IS NULL
          OR char_length(trim(${table.description})) BETWEEN 1 AND 500`,
    ),
    check("hr_timesheet_entries_row_version_positive", sql`${table.rowVersion} > 0`),
  ],
).enableRLS();

export const hrTimesheetApprovals = pgTable(
  "hr_timesheet_approvals",
  {
    timesheetApprovalId: uuid("timesheet_approval_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    timesheetVersionId: uuid("timesheet_version_id").notNull(),
    approverWorkerProfileId: uuid("approver_worker_profile_id").notNull(),
    decision: hrTimesheetDecision("decision").notNull(),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    correlationId: uuid("correlation_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.timesheetVersionId],
      foreignColumns: [hrTimesheetVersions.tenantId, hrTimesheetVersions.timesheetVersionId],
      name: "hr_timesheet_approvals_version_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.approverWorkerProfileId],
      foreignColumns: [hrWorkforceProfiles.tenantId, hrWorkforceProfiles.workerProfileId],
      name: "hr_timesheet_approvals_approver_same_tenant_fk",
    }).onDelete("restrict"),
    uniqueIndex("uq_hr_timesheet_approvals_tenant_version").on(
      table.tenantId,
      table.timesheetVersionId,
    ),
    check(
      "hr_timesheet_approvals_note_valid",
      sql`${table.decisionNote} IS NULL
          OR char_length(trim(${table.decisionNote})) BETWEEN 1 AND 2000`,
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
