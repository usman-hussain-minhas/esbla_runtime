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

export const workspaceTaskStatus = pgEnum("workspace_task_status", ["open", "completed"]);

export const workspaceTasks = pgTable(
  "workspace_tasks",
  {
    taskId: uuid("task_id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.tenantId, { onDelete: "restrict" }),
    createdByPrincipalId: uuid("created_by_principal_id").notNull(),
    assigneePrincipalId: uuid("assignee_principal_id").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    description: text("description"),
    status: workspaceTaskStatus("status").default("open").notNull(),
    dueOn: date("due_on", { mode: "string" }),
    completionNote: text("completion_note"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    correlationId: uuid("correlation_id").notNull(),
    version: integer("version").default(1).notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.createdByPrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "workspace_tasks_creator_same_tenant_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.assigneePrincipalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
      name: "workspace_tasks_assignee_same_tenant_fk",
    }).onDelete("restrict"),
    unique("workspace_tasks_tenant_creator_idempotency_uq").on(
      table.tenantId,
      table.createdByPrincipalId,
      table.idempotencyKey,
    ),
    unique("workspace_tasks_tenant_task_id_uq").on(table.tenantId, table.taskId),
    index("workspace_tasks_assignee_open_idx")
      .on(table.tenantId, table.assigneePrincipalId, table.dueOn, table.createdAt, table.taskId)
      .where(sql`${table.status} = 'open'`),
    check("workspace_tasks_title_valid", sql`char_length(trim(${table.title})) BETWEEN 1 AND 160`),
    check(
      "workspace_tasks_description_valid",
      sql`${table.description} IS NULL OR char_length(trim(${table.description})) BETWEEN 1 AND 2000`,
    ),
    check(
      "workspace_tasks_completion_note_valid",
      sql`${table.completionNote} IS NULL OR char_length(trim(${table.completionNote})) BETWEEN 1 AND 2000`,
    ),
    check(
      "workspace_tasks_completion_consistent",
      sql`(${table.status} = 'open' AND ${table.completedAt} IS NULL AND ${table.completionNote} IS NULL) OR (${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "workspace_tasks_idempotency_not_blank",
      sql`char_length(trim(${table.idempotencyKey})) > 0`,
    ),
    check("workspace_tasks_version_positive", sql`${table.version} > 0`),
  ],
).enableRLS();
