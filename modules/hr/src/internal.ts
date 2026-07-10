import {
  assertPolicyAllowed,
  evaluatePolicy,
  getServiceActivation,
  type PolicyRule,
  type TenantTransaction,
} from "@esbla/platform-core";
import { HrLeaveError } from "./errors.js";
import {
  HR_LEAVE_SERVICE_KEY,
  type LeaveCategory,
  type LeaveRequest,
  type LeaveRequestStatus,
} from "./types.js";

export interface LeaveRow {
  approver_principal_id: string;
  category_code: LeaveCategory;
  correlation_id: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  employee_principal_id: string;
  end_date: string;
  idempotency_key: string;
  leave_request_id: string;
  reason: string | null;
  start_date: string;
  status: LeaveRequestStatus;
  submitted_at: string;
  tenant_id: string;
  updated_at: string;
  version: number;
}

export const LEAVE_COLUMNS = `leave_request_id, tenant_id, employee_principal_id,
  approver_principal_id, category_code, start_date::text AS start_date,
  end_date::text AS end_date, reason, status,
  decision_note, idempotency_key, correlation_id, version,
  to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS submitted_at,
  CASE WHEN decided_at IS NULL THEN NULL ELSE
    to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS decided_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set<LeaveCategory>(["annual", "sick", "unpaid", "other"]);

export function mapLeaveRow(row: LeaveRow): LeaveRequest {
  return {
    approverPrincipalId: row.approver_principal_id,
    categoryCode: row.category_code,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    employeePrincipalId: row.employee_principal_id,
    endDate: row.end_date,
    idempotencyKey: row.idempotency_key,
    leaveRequestId: row.leave_request_id,
    reason: row.reason,
    startDate: row.start_date,
    status: row.status,
    submittedAt: row.submitted_at,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function normalizeOptionalText(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2000) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", `${field} must contain 1 to 2000 characters`, {
      field,
    });
  }
  return normalized;
}

export function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", `${field} must be a UUID`, { field });
  }
}

export function assertTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", `${field} must be an ISO timestamp`, { field });
  }
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function validateSubmissionInput(input: {
  categoryCode: LeaveCategory;
  endDate: string;
  idempotencyKey: string;
  startDate: string;
}): void {
  if (!CATEGORIES.has(input.categoryCode)) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", "Leave category is not registered");
  }
  if (!isCalendarDate(input.startDate) || !isCalendarDate(input.endDate)) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", "Leave dates must be valid ISO calendar dates");
  }
  if (input.endDate < input.startDate) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", "Leave end date cannot precede start date");
  }
  const key = input.idempotencyKey.trim();
  if (key.length === 0 || key.length > 128) {
    throw new HrLeaveError(
      "LEAVE_INPUT_INVALID",
      "Idempotency key must contain 1 to 128 characters",
    );
  }
}

export async function requireLeaveServiceActive(transaction: TenantTransaction): Promise<void> {
  const activation = await getServiceActivation(transaction, HR_LEAVE_SERVICE_KEY);
  if (activation?.state !== "active") {
    throw new HrLeaveError("LEAVE_SERVICE_INACTIVE", "HR Leave Request service is inactive");
  }
}

export function authorizeLeaveAction<Input>(
  transaction: TenantTransaction,
  actionKey: string,
  resourceKey: string,
  input: Input,
  rules: readonly PolicyRule<Input>[],
): void {
  assertPolicyAllowed(
    evaluatePolicy({ actionKey, input, resourceKey, transaction }, rules),
    transaction,
    actionKey,
    resourceKey,
  );
}

export async function selectLeaveForUpdate(
  transaction: TenantTransaction,
  leaveRequestId: string,
): Promise<LeaveRow> {
  const result = await transaction.client.query<LeaveRow>(
    `SELECT ${LEAVE_COLUMNS}
     FROM hr_leave_requests
     WHERE tenant_id = $1 AND leave_request_id = $2
     FOR UPDATE`,
    [transaction.context.tenantId, leaveRequestId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HrLeaveError("LEAVE_NOT_FOUND", "Leave request was not found");
  }
  return row;
}

export function authorizeView(transaction: TenantTransaction, row: LeaveRow): void {
  authorizeLeaveAction(transaction, "hr.leave.view", row.leave_request_id, row, [
    {
      effect: "allow",
      id: "employee_view_own",
      matches: (request, actor) => request.employee_principal_id === actor.principalId,
    },
    {
      effect: "allow",
      id: "manager_view_assigned",
      matches: (request, actor) => request.approver_principal_id === actor.principalId,
    },
  ]);
}

export function validatePageSize(pageSize: number, maximum: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maximum) {
    throw new HrLeaveError("LEAVE_INPUT_INVALID", `Page size must be between 1 and ${maximum}`);
  }
  return pageSize;
}
