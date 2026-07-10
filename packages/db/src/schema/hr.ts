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
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { memberships, tenants } from "./core.js";

export const hrLeaveCategory = pgEnum("hr_leave_category", ["annual", "sick", "unpaid", "other"]);
export const hrLeaveRequestStatus = pgEnum("hr_leave_request_status", [
  "submitted",
  "approved",
  "rejected",
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
