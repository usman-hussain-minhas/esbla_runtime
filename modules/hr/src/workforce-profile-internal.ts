import {
  assertPolicyAllowed,
  evaluatePolicy,
  type PolicyRule,
  type TenantTransaction,
} from "@esbla/platform-core";
import { HrWorkforceProfileError } from "./workforce-profile-errors.js";
import {
  HR_WORKFORCE_PROFILE_SERVICE_KEY,
  type WorkforceProfile,
  type WorkforceStatus,
} from "./workforce-profile-types.js";

export interface WorkforceProfileRow {
  readonly created_at: string;
  readonly current_reporting_relationship_id: string | null;
  readonly employee_number: string | null;
  readonly principal_id: string | null;
  readonly tenant_id: string;
  readonly updated_at: string;
  readonly row_version: number;
  readonly worker_profile_id: string;
  readonly workforce_status: WorkforceStatus;
}

export const WORKFORCE_PROFILE_COLUMNS = `worker_profile_id, tenant_id, principal_id,
  employee_number, workforce_status, current_reporting_relationship_id, row_version,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function mapWorkforceProfileRow(row: WorkforceProfileRow): WorkforceProfile {
  return {
    createdAt: row.created_at,
    employeeNumber: row.employee_number,
    principalLinked: row.principal_id !== null,
    updatedAt: row.updated_at,
    version: row.row_version,
    workerProfileId: row.worker_profile_id,
    workforceStatus: row.workforce_status,
  };
}

export function assertWorkforceUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_INPUT_INVALID",
      `${field} must be a UUID`,
      { field },
    );
  }
}

export function assertWorkforceExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_INPUT_INVALID",
      "Expected version must be a positive integer",
    );
  }
}

export function assertWorkforceIdempotency(
  transactionCorrelationId: string,
  idempotencyKey: string,
): void {
  if (!UUID_PATTERN.test(idempotencyKey) || idempotencyKey !== transactionCorrelationId) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_INPUT_INVALID",
      "Idempotency key must match the authenticated mutation correlation",
    );
  }
}

export function normalizeEmployeeNumber(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 64) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_INPUT_INVALID",
      "Employee number must contain 1 to 64 characters",
      { field: "employeeNumber" },
    );
  }
  return normalized;
}

export function requireWorkforceProfileServiceActive(transaction: TenantTransaction): void {
  const activation = transaction.lockedServiceActivation;
  if (
    activation?.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
    activation.state !== "active"
  ) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_SERVICE_INACTIVE",
      "Workforce Profile service is inactive",
    );
  }
}

export function authorizeWorkforceAction<Input>(
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

export function authorizeHrOperator(
  transaction: TenantTransaction,
  actionKey: string,
  resourceKey: string,
): void {
  authorizeWorkforceAction(transaction, actionKey, resourceKey, {}, [
    {
      effect: "allow",
      id: "current_hr_operator_only",
      matches: (_input, actor) => actor.roleKey === "hr_operator",
    },
  ]);
}

export function authorizeTenantAdmin(
  transaction: TenantTransaction,
  actionKey: string,
  resourceKey: string,
): void {
  authorizeWorkforceAction(transaction, actionKey, resourceKey, {}, [
    {
      effect: "allow",
      id: "current_tenant_admin_only",
      matches: (_input, actor) => actor.roleKey === "tenant_admin",
    },
  ]);
}

export async function selectWorkforceProfileForUpdate(
  transaction: TenantTransaction,
  workerProfileId: string,
): Promise<WorkforceProfileRow> {
  const result = await transaction.client.query<WorkforceProfileRow>(
    `SELECT ${WORKFORCE_PROFILE_COLUMNS}
     FROM hr_worker_profiles
     WHERE tenant_id = $1 AND worker_profile_id = $2
     FOR UPDATE`,
    [transaction.context.tenantId, workerProfileId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_PROFILE_NOT_FOUND",
      "Workforce profile was not found",
    );
  }
  return row;
}
