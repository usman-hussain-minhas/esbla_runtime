import {
  deriveStableUuid,
  type OperationContext,
  recordMutationProof,
  resolveSetting,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import { HrWorkforceProfileError } from "./workforce-profile-errors.js";
import {
  assertWorkforceExpectedVersion,
  assertWorkforceIdempotency,
  assertWorkforceUuid,
  authorizeHrOperator,
  mapWorkforceProfileRow,
  normalizeEmployeeNumber,
  requireWorkforceProfileServiceActive,
  selectWorkforceProfileForUpdate,
  WORKFORCE_PROFILE_COLUMNS,
  type WorkforceProfileRow,
} from "./workforce-profile-internal.js";
import { hrWorkforceProfileSettings } from "./workforce-profile-settings.js";
import {
  type ChangeWorkforceStatusInput,
  type CreateWorkforceProfileInput,
  HR_WORKFORCE_PROFILE_BILLING_STATE,
  HR_WORKFORCE_PROFILE_SERVICE_KEY,
  HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
  type LinkWorkforcePrincipalInput,
  type WorkforceProfileCommandResult,
} from "./workforce-profile-types.js";

const CREATE_EVENT_TYPE = "hr.workforce_profile.create_profile";
const LINK_EVENT_TYPE = "hr.workforce_profile.link_principal";
const STATUS_EVENT_TYPE = "hr.workforce_profile.change_status";

interface MutationReplayRow {
  readonly aggregate_version: number;
  readonly payload: unknown;
  readonly subject_id: string;
}

function commandResult(row: WorkforceProfileRow, replayed: boolean): WorkforceProfileCommandResult {
  return {
    billingState: HR_WORKFORCE_PROFILE_BILLING_STATE,
    profile: mapWorkforceProfileRow(row),
    replayed,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idempotencyConflict(): HrWorkforceProfileError {
  return new HrWorkforceProfileError(
    "WORKFORCE_PROFILE_IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Workforce Profile data",
  );
}

async function findMutationReplay(
  transaction: TenantTransaction,
  workerProfileId: string,
  eventType: string,
): Promise<MutationReplayRow | null> {
  const result = await transaction.client.query<MutationReplayRow>(
    `SELECT e.subject_id, o.aggregate_version, o.payload
     FROM evidence_events e
     JOIN outbox_events o
       ON o.tenant_id = e.tenant_id
      AND o.aggregate_type = e.subject_type
      AND o.aggregate_id = e.subject_id
      AND o.correlation_id = e.correlation_id
     WHERE e.tenant_id = $1 AND e.subject_type = $2
       AND e.event_type = $3 AND e.correlation_id = $4
       AND e.actor_principal_id = $5 AND o.event_type = $3
     ORDER BY e.subject_id
     LIMIT 2`,
    [
      transaction.context.tenantId,
      HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
      eventType,
      transaction.context.correlationId,
      transaction.context.actorPrincipalId,
    ],
  );
  if (result.rows.length > 1 || (result.rows[0] && result.rows[0].subject_id !== workerProfileId)) {
    throw idempotencyConflict();
  }
  return result.rows[0] ?? null;
}

function assertCreateReplay(
  replay: MutationReplayRow | null,
  row: WorkforceProfileRow,
  expectedEmployeeNumber: string | null,
): void {
  if (!replay || !isRecord(replay.payload)) throw idempotencyConflict();
  if (
    replay.aggregate_version !== 1 ||
    replay.payload.action !== "create_profile" ||
    replay.payload.afterVersion !== 1 ||
    replay.payload.beforeVersion !== null ||
    replay.payload.workerProfileId !== row.worker_profile_id ||
    row.employee_number !== expectedEmployeeNumber ||
    row.row_version < 1
  ) {
    throw idempotencyConflict();
  }
}

function assertLinkReplay(
  replay: MutationReplayRow | null,
  row: WorkforceProfileRow,
  input: LinkWorkforcePrincipalInput,
): boolean {
  if (!replay) return false;
  if (
    !isRecord(replay.payload) ||
    replay.aggregate_version !== input.expectedVersion + 1 ||
    replay.payload.action !== "link_principal" ||
    replay.payload.afterVersion !== input.expectedVersion + 1 ||
    replay.payload.beforeVersion !== input.expectedVersion ||
    replay.payload.workerProfileId !== row.worker_profile_id ||
    row.principal_id !== input.principalId ||
    row.row_version < replay.aggregate_version
  ) {
    throw idempotencyConflict();
  }
  return true;
}

function assertStatusReplay(
  replay: MutationReplayRow | null,
  row: WorkforceProfileRow,
  input: ChangeWorkforceStatusInput,
): boolean {
  if (!replay) return false;
  if (
    !isRecord(replay.payload) ||
    replay.aggregate_version !== input.expectedVersion + 1 ||
    replay.payload.action !== "change_status" ||
    replay.payload.afterVersion !== input.expectedVersion + 1 ||
    replay.payload.beforeVersion !== input.expectedVersion ||
    replay.payload.targetStatus !== input.targetStatus ||
    replay.payload.workerProfileId !== row.worker_profile_id ||
    row.workforce_status !== input.targetStatus ||
    row.row_version < replay.aggregate_version
  ) {
    throw idempotencyConflict();
  }
  return true;
}

async function appendStatusHistory(
  transaction: TenantTransaction,
  workerProfileId: string,
  previousStatus: "draft" | null,
  newStatus: "active" | "draft",
  eventType: string,
): Promise<void> {
  const historyId = deriveStableUuid(
    "hr.workforce_profile.status_history",
    transaction.context.tenantId,
    workerProfileId,
    transaction.context.correlationId,
    eventType,
  );
  await transaction.client.query(
    `INSERT INTO hr_workforce_status_history
       (workforce_status_history_id, tenant_id, worker_profile_id, previous_status,
        new_status, actor_principal_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      historyId,
      transaction.context.tenantId,
      workerProfileId,
      previousStatus,
      newStatus,
      transaction.context.actorPrincipalId,
      transaction.context.correlationId,
    ],
  );
}

export async function createWorkforceProfile(
  pool: Pool,
  context: OperationContext,
  input: CreateWorkforceProfileInput,
): Promise<WorkforceProfileCommandResult> {
  assertWorkforceIdempotency(context.correlationId, input.idempotencyKey);
  const employeeNumber = normalizeEmployeeNumber(input.employeeNumber);
  const workerProfileId = deriveStableUuid(
    CREATE_EVENT_TYPE,
    context.tenantId,
    context.actorPrincipalId,
    input.idempotencyKey,
  );
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceProfileServiceActive(transaction);
      authorizeHrOperator(transaction, "hr.workforce.create_profile", workerProfileId);

      const existing = await transaction.client.query<WorkforceProfileRow>(
        `SELECT ${WORKFORCE_PROFILE_COLUMNS}
         FROM hr_worker_profiles
         WHERE tenant_id = $1 AND worker_profile_id = $2
         FOR UPDATE`,
        [transaction.context.tenantId, workerProfileId],
      );
      const replayRow = existing.rows[0];
      if (replayRow) {
        assertCreateReplay(
          await findMutationReplay(transaction, workerProfileId, CREATE_EVENT_TYPE),
          replayRow,
          employeeNumber,
        );
        return commandResult(replayRow, true);
      }

      const employeeNumberRequired = await resolveSetting(
        transaction,
        hrWorkforceProfileSettings.employeeNumberRequired,
      );
      const unlinkedCreationAllowed = await resolveSetting(
        transaction,
        hrWorkforceProfileSettings.unlinkedWorkerCreationAllowed,
      );
      if (!unlinkedCreationAllowed.value) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_STATE_CONFLICT",
          "Unlinked workforce profile creation is disabled",
        );
      }
      if (employeeNumberRequired.value && employeeNumber === null) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_INPUT_INVALID",
          "Employee number is required by tenant policy",
          { field: "employeeNumber" },
        );
      }

      const inserted = await transaction.client.query<WorkforceProfileRow>(
        `INSERT INTO hr_worker_profiles
           (worker_profile_id, tenant_id, principal_id, employee_number, workforce_status,
            current_reporting_relationship_id, row_version)
         VALUES ($1, $2, NULL, $3, 'draft', NULL, 1)
         ON CONFLICT DO NOTHING
         RETURNING ${WORKFORCE_PROFILE_COLUMNS}`,
        [workerProfileId, transaction.context.tenantId, employeeNumber],
      );
      const row = inserted.rows[0];
      if (!row) {
        const concurrent = await transaction.client.query<WorkforceProfileRow>(
          `SELECT ${WORKFORCE_PROFILE_COLUMNS}
           FROM hr_worker_profiles
           WHERE tenant_id = $1 AND worker_profile_id = $2
           FOR UPDATE`,
          [transaction.context.tenantId, workerProfileId],
        );
        const concurrentReplay = concurrent.rows[0];
        if (!concurrentReplay) throw idempotencyConflict();
        assertCreateReplay(
          await findMutationReplay(transaction, workerProfileId, CREATE_EVENT_TYPE),
          concurrentReplay,
          employeeNumber,
        );
        return commandResult(concurrentReplay, true);
      }

      await appendStatusHistory(
        transaction,
        row.worker_profile_id,
        null,
        "draft",
        CREATE_EVENT_TYPE,
      );
      await recordMutationProof(transaction, {
        evidence: {
          eventType: CREATE_EVENT_TYPE,
          newState: "draft",
          priorState: null,
          subjectId: row.worker_profile_id,
          subjectType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
        },
        outbox: {
          aggregateId: row.worker_profile_id,
          aggregateType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
          aggregateVersion: row.row_version,
          eventType: CREATE_EVENT_TYPE,
          payload: {
            action: "create_profile",
            afterVersion: row.row_version,
            beforeVersion: null,
            workerProfileId: row.worker_profile_id,
            workforceStatus: row.workforce_status,
          },
        },
      });
      return commandResult(row, false);
    },
    { serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY },
  );
}

export async function linkWorkforcePrincipal(
  pool: Pool,
  context: OperationContext,
  input: LinkWorkforcePrincipalInput,
): Promise<WorkforceProfileCommandResult> {
  assertWorkforceIdempotency(context.correlationId, input.idempotencyKey);
  assertWorkforceUuid(input.workerProfileId, "workerProfileId");
  assertWorkforceUuid(input.principalId, "principalId");
  assertWorkforceExpectedVersion(input.expectedVersion);
  try {
    return await withTenantTransaction(
      pool,
      context,
      async (transaction) => {
        requireWorkforceProfileServiceActive(transaction);
        authorizeHrOperator(transaction, "hr.workforce.link_principal", input.workerProfileId);
        const targetMembership = await transaction.client.query(
          `SELECT 1
           FROM memberships
           WHERE tenant_id = $1 AND principal_id = $2 AND status = 'active'
           FOR SHARE`,
          [transaction.context.tenantId, input.principalId],
        );
        if (targetMembership.rowCount !== 1) {
          throw new HrWorkforceProfileError(
            "WORKFORCE_PROFILE_PRINCIPAL_UNAVAILABLE",
            "Principal is unavailable for workforce profile linking",
          );
        }

        const row = await selectWorkforceProfileForUpdate(transaction, input.workerProfileId);
        if (
          assertLinkReplay(
            await findMutationReplay(transaction, row.worker_profile_id, LINK_EVENT_TYPE),
            row,
            input,
          )
        ) {
          return commandResult(row, true);
        }

        if (row.workforce_status !== "draft" || row.principal_id !== null) {
          throw new HrWorkforceProfileError(
            "WORKFORCE_PROFILE_STATE_CONFLICT",
            "Workforce profile is not available for principal linking",
          );
        }
        if (row.row_version !== input.expectedVersion) {
          throw new HrWorkforceProfileError(
            "WORKFORCE_PROFILE_VERSION_CONFLICT",
            "Workforce profile version is stale",
          );
        }

        const updated = await transaction.client.query<WorkforceProfileRow>(
          `UPDATE hr_worker_profiles
           SET principal_id = $3, updated_at = now(), row_version = row_version + 1
           WHERE tenant_id = $1 AND worker_profile_id = $2
             AND principal_id IS NULL AND workforce_status = 'draft' AND row_version = $4
           RETURNING ${WORKFORCE_PROFILE_COLUMNS}`,
          [
            transaction.context.tenantId,
            row.worker_profile_id,
            input.principalId,
            input.expectedVersion,
          ],
        );
        const linked = updated.rows[0];
        if (!linked) {
          throw new HrWorkforceProfileError(
            "WORKFORCE_PROFILE_VERSION_CONFLICT",
            "Workforce profile changed concurrently",
          );
        }

        await recordMutationProof(transaction, {
          evidence: {
            eventType: LINK_EVENT_TYPE,
            newState: "draft",
            priorState: "draft",
            subjectId: linked.worker_profile_id,
            subjectType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
          },
          outbox: {
            aggregateId: linked.worker_profile_id,
            aggregateType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
            aggregateVersion: linked.row_version,
            eventType: LINK_EVENT_TYPE,
            payload: {
              action: "link_principal",
              afterVersion: linked.row_version,
              beforeVersion: row.row_version,
              workerProfileId: linked.worker_profile_id,
              workforceStatus: linked.workforce_status,
            },
          },
        });
        return commandResult(linked, false);
      },
      { serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY },
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new HrWorkforceProfileError(
        "WORKFORCE_PROFILE_PRINCIPAL_UNAVAILABLE",
        "Principal is unavailable for workforce profile linking",
      );
    }
    throw error;
  }
}

export async function changeWorkforceStatus(
  pool: Pool,
  context: OperationContext,
  input: ChangeWorkforceStatusInput,
): Promise<WorkforceProfileCommandResult> {
  assertWorkforceIdempotency(context.correlationId, input.idempotencyKey);
  assertWorkforceUuid(input.workerProfileId, "workerProfileId");
  assertWorkforceExpectedVersion(input.expectedVersion);

  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      requireWorkforceProfileServiceActive(transaction);
      authorizeHrOperator(transaction, "hr.workforce.change_status", input.workerProfileId);
      if (input.targetStatus !== "active") {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_STATE_CONFLICT",
          "Only the draft to active Workforce Profile transition is admitted",
        );
      }
      const principalLink = await transaction.client.query<{ principal_id: string | null }>(
        `SELECT principal_id
         FROM hr_worker_profiles
         WHERE tenant_id = $1 AND worker_profile_id = $2`,
        [transaction.context.tenantId, input.workerProfileId],
      );
      const linkedPrincipalId = principalLink.rows[0]?.principal_id;
      if (principalLink.rowCount !== 1) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_NOT_FOUND",
          "Workforce profile was not found",
        );
      }
      if (!linkedPrincipalId) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_STATE_CONFLICT",
          "Workforce profile is not eligible for activation",
        );
      }
      const activePrincipalLink = await transaction.client.query(
        `SELECT 1
         FROM memberships
         WHERE tenant_id = $1 AND principal_id = $2 AND status = 'active'
         FOR SHARE`,
        [transaction.context.tenantId, linkedPrincipalId],
      );
      if (activePrincipalLink.rowCount !== 1) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_STATE_CONFLICT",
          "Workforce profile is not eligible for activation",
        );
      }
      const row = await selectWorkforceProfileForUpdate(transaction, input.workerProfileId);
      if (row.principal_id !== linkedPrincipalId) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_STATE_CONFLICT",
          "Workforce profile is not eligible for activation",
        );
      }
      if (
        assertStatusReplay(
          await findMutationReplay(transaction, row.worker_profile_id, STATUS_EVENT_TYPE),
          row,
          input,
        )
      ) {
        return commandResult(row, true);
      }

      if (row.workforce_status !== "draft" || row.principal_id === null) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_STATE_CONFLICT",
          "Workforce profile is not eligible for activation",
        );
      }
      if (row.row_version !== input.expectedVersion) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_VERSION_CONFLICT",
          "Workforce profile version is stale",
        );
      }

      const updated = await transaction.client.query<WorkforceProfileRow>(
        `UPDATE hr_worker_profiles
         SET workforce_status = 'active', updated_at = now(), row_version = row_version + 1
         WHERE tenant_id = $1 AND worker_profile_id = $2
           AND workforce_status = 'draft' AND principal_id IS NOT NULL AND row_version = $3
         RETURNING ${WORKFORCE_PROFILE_COLUMNS}`,
        [transaction.context.tenantId, row.worker_profile_id, input.expectedVersion],
      );
      const activated = updated.rows[0];
      if (!activated) {
        throw new HrWorkforceProfileError(
          "WORKFORCE_PROFILE_VERSION_CONFLICT",
          "Workforce profile changed concurrently",
        );
      }

      await appendStatusHistory(
        transaction,
        activated.worker_profile_id,
        "draft",
        "active",
        STATUS_EVENT_TYPE,
      );
      await recordMutationProof(transaction, {
        evidence: {
          eventType: STATUS_EVENT_TYPE,
          newState: "active",
          priorState: "draft",
          subjectId: activated.worker_profile_id,
          subjectType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
        },
        outbox: {
          aggregateId: activated.worker_profile_id,
          aggregateType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
          aggregateVersion: activated.row_version,
          eventType: STATUS_EVENT_TYPE,
          payload: {
            action: "change_status",
            afterVersion: activated.row_version,
            beforeVersion: row.row_version,
            targetStatus: "active",
            workerProfileId: activated.worker_profile_id,
          },
        },
      });
      return commandResult(activated, false);
    },
    { serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY },
  );
}
