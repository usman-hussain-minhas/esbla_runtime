import { randomUUID } from "node:crypto";
import type { TenantTransaction } from "./context.js";
import { PlatformError } from "./errors.js";

export interface CreateWorkItemInput {
  readonly assigneePrincipalId: string;
  readonly subjectId: string;
  readonly subjectType: string;
  readonly workItemId?: string;
  readonly workType: string;
}

export interface WorkItemResult {
  readonly assigneePrincipalId: string;
  readonly replayed: boolean;
  readonly status: "cancelled" | "completed" | "open";
  readonly subjectId: string;
  readonly subjectType: string;
  readonly workItemId: string;
  readonly workType: string;
}

export async function createWorkItem(
  transaction: TenantTransaction,
  input: CreateWorkItemInput,
): Promise<WorkItemResult> {
  const inserted = await transaction.client.query<{
    assignee_principal_id: string;
    status: WorkItemResult["status"];
    subject_id: string;
    subject_type: string;
    work_item_id: string;
    work_type: string;
  }>(
    `INSERT INTO work_items
       (work_item_id, tenant_id, assignee_principal_id, work_type, subject_type, subject_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, work_type, subject_type, subject_id)
     DO NOTHING
     RETURNING work_item_id, assignee_principal_id, work_type, subject_type, subject_id, status`,
    [
      input.workItemId ?? randomUUID(),
      transaction.context.tenantId,
      input.assigneePrincipalId,
      input.workType,
      input.subjectType,
      input.subjectId,
    ],
  );
  const created = inserted.rows[0];
  if (created) {
    return {
      assigneePrincipalId: created.assignee_principal_id,
      replayed: false,
      status: created.status,
      subjectId: created.subject_id,
      subjectType: created.subject_type,
      workItemId: created.work_item_id,
      workType: created.work_type,
    };
  }

  const existing = await transaction.client.query<{
    assignee_principal_id: string;
    status: WorkItemResult["status"];
    subject_id: string;
    subject_type: string;
    work_item_id: string;
    work_type: string;
  }>(
    `SELECT work_item_id, assignee_principal_id, work_type, subject_type, subject_id, status
     FROM work_items
     WHERE tenant_id = $1 AND work_type = $2 AND subject_type = $3 AND subject_id = $4`,
    [transaction.context.tenantId, input.workType, input.subjectType, input.subjectId],
  );
  const row = existing.rows[0];
  if (!row || row.assignee_principal_id !== input.assigneePrincipalId) {
    throw new PlatformError("WORK_ITEM_CONFLICT", "Work item retry changed its assignee", {
      subjectId: input.subjectId,
      workType: input.workType,
    });
  }
  return {
    assigneePrincipalId: row.assignee_principal_id,
    replayed: true,
    status: row.status,
    subjectId: row.subject_id,
    subjectType: row.subject_type,
    workItemId: row.work_item_id,
    workType: row.work_type,
  };
}

export async function completeWorkItem(
  transaction: TenantTransaction,
  workItemId: string,
): Promise<WorkItemResult> {
  const selected = await transaction.client.query<{
    assignee_principal_id: string;
    status: WorkItemResult["status"];
    subject_id: string;
    subject_type: string;
    work_item_id: string;
    work_type: string;
  }>(
    `SELECT work_item_id, assignee_principal_id, work_type, subject_type, subject_id, status
     FROM work_items
     WHERE tenant_id = $1 AND work_item_id = $2
     FOR UPDATE`,
    [transaction.context.tenantId, workItemId],
  );
  const row = selected.rows[0];
  if (!row || row.assignee_principal_id !== transaction.context.actorPrincipalId) {
    throw new PlatformError("WORK_ITEM_CONFLICT", "Work item is not assigned to this actor", {
      workItemId,
    });
  }
  if (row.status === "cancelled") {
    throw new PlatformError("WORK_ITEM_CONFLICT", "Cancelled work item cannot be completed", {
      workItemId,
    });
  }
  const replayed = row.status === "completed";
  if (!replayed) {
    await transaction.client.query(
      `UPDATE work_items
       SET status = 'completed', completed_at = now()
       WHERE tenant_id = $1 AND work_item_id = $2`,
      [transaction.context.tenantId, workItemId],
    );
  }
  return {
    assigneePrincipalId: row.assignee_principal_id,
    replayed,
    status: "completed",
    subjectId: row.subject_id,
    subjectType: row.subject_type,
    workItemId: row.work_item_id,
    workType: row.work_type,
  };
}
