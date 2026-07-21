import { createHash } from "node:crypto";
import {
  appendEvidence,
  assertPolicyAllowed,
  deriveStableUuid,
  evaluatePolicy,
  PlatformError,
  recordMutationProof,
  type TenantTransaction,
} from "@esbla/platform-core";
import { hrManifest } from "./manifest.js";
import {
  HrWorkforceProfileError,
  workforceInputInvalid,
  workforceProfileConflict,
} from "./workforce-errors.js";
import {
  HR_WORKFORCE_PROFILE_SERVICE_KEY,
  HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
  type WorkforceProfileCommandResult,
  type WorkforceProfileView,
  type WorkforceStatus,
} from "./workforce-types.js";

export const WORKFORCE_PROFILE_COLUMNS = `worker_profile_id, employee_number,
  principal_id IS NOT NULL AS principal_linked, workforce_status, row_version`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_SUBJECT_TYPE = "hr.workforce_profile.idempotency";

export type WorkforceMutationAction = "change_status" | "create_profile" | "link_principal";

export interface WorkforceProfileRow {
  readonly employee_number: string | null;
  readonly principal_linked: boolean;
  readonly row_version: number;
  readonly worker_profile_id: string;
  readonly workforce_status: WorkforceStatus;
}

export interface WorkforceMutationReceipt {
  readonly action: WorkforceMutationAction;
  readonly employeeNumber?: string | null;
  readonly eventType: string;
  readonly expectedVersion?: number;
  readonly principalId?: string;
  readonly receiptId: string;
  readonly status?: WorkforceStatus;
  readonly workerProfileId?: string;
}

function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Workforce Profile data",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWorkforceUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw workforceInputInvalid(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function assertExpectedVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw workforceInputInvalid("expectedVersion must be a positive integer");
  }
}

export function normalizeEmployeeNumber(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value.trim().length === 0) {
    throw workforceInputInvalid("employeeNumber must not be blank");
  }
  return value;
}

export function mapWorkforceProfile(row: WorkforceProfileRow): WorkforceProfileView {
  if (
    !Number.isSafeInteger(row.row_version) ||
    row.row_version < 1 ||
    !["active", "draft", "suspended", "terminated"].includes(row.workforce_status)
  ) {
    throw workforceProfileConflict("Workforce Profile state is invalid");
  }
  return {
    employeeNumber: row.employee_number,
    principalLinked: row.principal_linked,
    version: row.row_version,
    workerProfileId: row.worker_profile_id,
    workforceStatus: row.workforce_status,
  };
}

function responseSha256(profile: WorkforceProfileView): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile.workerProfileId,
        profile.principalLinked,
        profile.workforceStatus,
        profile.version,
      ]),
    )
    .digest("hex");
}

export function requireWorkforceServiceActive(transaction: TenantTransaction): void {
  const activation = transaction.lockedServiceActivation;
  if (
    activation?.serviceKey !== HR_WORKFORCE_PROFILE_SERVICE_KEY ||
    activation.state !== "active"
  ) {
    throw new HrWorkforceProfileError(
      "WORKFORCE_SERVICE_INACTIVE",
      "Workforce Profile service is inactive",
    );
  }
}

export async function authorizeWorkforceAction(
  transaction: TenantTransaction,
  action: WorkforceMutationAction | "view_own",
  roleKey: "employee" | "hr_operator",
): Promise<void> {
  const actionKey = `hr.workforce.${action}`;
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "tenant" && id === actionKey,
  );
  const capability = await transaction.client.query(
    `SELECT capability_id
     FROM membership_capabilities
     WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = $3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  const input = { capabilityCurrent: registered && capability.rows.length === 1, roleKey };
  assertPolicyAllowed(
    evaluatePolicy(
      {
        actionKey,
        input,
        resourceKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
        transaction,
      },
      [
        {
          effect: "allow",
          id: `current_${roleKey}_${action}`,
          matches: (request, actor) =>
            actor.roleKey === request.roleKey && request.capabilityCurrent,
        },
      ],
    ),
    transaction,
    actionKey,
    HR_WORKFORCE_PROFILE_SERVICE_KEY,
  );
}

export async function prepareWorkforceMutation(
  transaction: TenantTransaction,
  action: WorkforceMutationAction,
  idempotencyKey: string,
  semantics: Readonly<{
    employeeNumber?: string | null;
    expectedVersion?: number;
    principalId?: string;
    status?: WorkforceStatus;
    workerProfileId?: string;
  }>,
): Promise<WorkforceMutationReceipt> {
  const normalizedKey = normalizeWorkforceUuid(idempotencyKey, "idempotencyKey");
  const receiptId = deriveStableUuid(
    "hr.workforce_profile.idempotency.v1",
    transaction.context.tenantId.toLowerCase(),
    transaction.context.actorPrincipalId.toLowerCase(),
    action,
    normalizedKey,
  );
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))",
    [receiptId],
  );
  return {
    action,
    ...semantics,
    eventType: `hr.workforce_profile.${action}`,
    receiptId,
  };
}

const REPLAY_PAYLOAD_KEYS =
  '["action","afterVersion","beforeVersion","principalLinked","receiptId","workerProfileId","workforceStatus"]';

function isExactReplayPayload(value: Record<string, unknown>): boolean {
  return JSON.stringify(Object.keys(value).sort()) === REPLAY_PAYLOAD_KEYS;
}

export function isAllowedWorkforceStatusTransition(prior: string | null, next: string): boolean {
  return (
    (prior === "draft" && next === "active") ||
    (prior === "active" && (next === "suspended" || next === "terminated")) ||
    (prior === "suspended" && (next === "active" || next === "terminated"))
  );
}

export async function readWorkforceMutationReplay(
  transaction: TenantTransaction,
  receipt: WorkforceMutationReceipt,
): Promise<WorkforceProfileView | null> {
  const binding = await transaction.client.query<{
    correlation_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT correlation_id, prior_state, new_state
     FROM evidence_events
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND event_type = $4 AND actor_principal_id = $5
     ORDER BY occurred_at, evidence_event_id
     LIMIT 2`,
    [
      transaction.context.tenantId,
      RECEIPT_SUBJECT_TYPE,
      receipt.receiptId,
      `${receipt.eventType}.response_bound`,
      transaction.context.actorPrincipalId,
    ],
  );
  if (binding.rows.length === 0) return null;
  const bound = binding.rows[0];
  if (binding.rows.length !== 1 || !bound || bound.prior_state !== receipt.action) {
    throw idempotencyConflict();
  }

  const result = await transaction.client.query<{
    aggregate_id: string;
    aggregate_version: number;
    employee_number: string | null;
    new_state: string;
    payload: unknown;
    principal_id: string | null;
    prior_state: string | null;
  }>(
    `SELECT evidence.subject_id AS aggregate_id, evidence.prior_state,
            evidence.new_state, outbox.aggregate_version, outbox.payload,
            profile.employee_number, profile.principal_id
     FROM evidence_events evidence
     JOIN outbox_events outbox
       ON outbox.tenant_id = evidence.tenant_id
      AND outbox.aggregate_type = evidence.subject_type
      AND outbox.aggregate_id = evidence.subject_id
      AND outbox.correlation_id = evidence.correlation_id
     JOIN hr_worker_profiles profile
       ON profile.tenant_id = evidence.tenant_id
      AND profile.worker_profile_id = evidence.subject_id
     WHERE evidence.tenant_id = $1 AND evidence.event_type = $2
       AND evidence.subject_type = $3 AND evidence.correlation_id = $4
       AND evidence.actor_principal_id = $5 AND outbox.event_type = $2
       AND outbox.payload ->> 'receiptId' = $6
     LIMIT 2`,
    [
      transaction.context.tenantId,
      receipt.eventType,
      HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
      bound.correlation_id,
      transaction.context.actorPrincipalId,
      receipt.receiptId,
    ],
  );
  const replay = result.rows[0];
  if (result.rows.length !== 1 || !replay || !isRecord(replay.payload)) {
    throw idempotencyConflict();
  }
  const payload = replay.payload;
  const beforeVersion = payload.beforeVersion;
  const afterVersion = payload.afterVersion;
  const versionShapeValid =
    Number.isSafeInteger(afterVersion) &&
    (afterVersion as number) >= 1 &&
    (beforeVersion === null ||
      (Number.isSafeInteger(beforeVersion) && (beforeVersion as number) >= 1)) &&
    (beforeVersion === null ? afterVersion === 1 : afterVersion === (beforeVersion as number) + 1);
  const proofShapeValid =
    receipt.action === "create_profile"
      ? beforeVersion === null &&
        replay.prior_state === null &&
        replay.new_state === "draft" &&
        payload.principalLinked === false
      : receipt.action === "link_principal"
        ? beforeVersion !== null &&
          replay.prior_state === "draft" &&
          replay.new_state === "draft" &&
          payload.principalLinked === true
        : beforeVersion !== null &&
          typeof payload.workforceStatus === "string" &&
          isAllowedWorkforceStatusTransition(replay.prior_state, payload.workforceStatus) &&
          payload.principalLinked === true;
  if (
    !isExactReplayPayload(payload) ||
    payload.action !== receipt.action ||
    payload.receiptId !== receipt.receiptId ||
    payload.workerProfileId !== replay.aggregate_id ||
    afterVersion !== replay.aggregate_version ||
    !versionShapeValid ||
    !proofShapeValid ||
    replay.new_state !== payload.workforceStatus ||
    typeof payload.principalLinked !== "boolean" ||
    typeof payload.workforceStatus !== "string" ||
    !["active", "draft", "suspended", "terminated"].includes(payload.workforceStatus)
  ) {
    throw idempotencyConflict();
  }
  if (
    receipt.action === "create_profile" &&
    replay.employee_number !== (receipt.employeeNumber ?? null)
  ) {
    throw idempotencyConflict();
  }
  if (
    receipt.action !== "create_profile" &&
    (receipt.workerProfileId !== replay.aggregate_id ||
      receipt.expectedVersion !== beforeVersion ||
      (receipt.action === "link_principal" && receipt.principalId !== replay.principal_id) ||
      (receipt.action === "change_status" && receipt.status !== replay.new_state))
  ) {
    throw idempotencyConflict();
  }
  const profile: WorkforceProfileView = {
    employeeNumber: replay.employee_number,
    principalLinked: payload.principalLinked,
    version: replay.aggregate_version,
    workerProfileId: replay.aggregate_id,
    workforceStatus: payload.workforceStatus as WorkforceStatus,
  };
  if (bound.new_state !== responseSha256(profile)) {
    throw idempotencyConflict();
  }
  return profile;
}

export async function recordWorkforceMutation(
  transaction: TenantTransaction,
  receipt: WorkforceMutationReceipt,
  beforeVersion: number | null,
  priorState: WorkforceStatus | null,
  profile: WorkforceProfileView,
): Promise<void> {
  await recordMutationProof(transaction, {
    evidence: {
      eventType: receipt.eventType,
      newState: profile.workforceStatus,
      priorState,
      subjectId: profile.workerProfileId,
      subjectType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
    },
    outbox: {
      aggregateId: profile.workerProfileId,
      aggregateType: HR_WORKFORCE_PROFILE_SUBJECT_TYPE,
      aggregateVersion: profile.version,
      eventType: receipt.eventType,
      payload: {
        action: receipt.action,
        afterVersion: profile.version,
        beforeVersion,
        principalLinked: profile.principalLinked,
        receiptId: receipt.receiptId,
        workerProfileId: profile.workerProfileId,
        workforceStatus: profile.workforceStatus,
      },
    },
  });
  const binding = await appendEvidence(transaction, {
    eventType: `${receipt.eventType}.response_bound`,
    newState: responseSha256(profile),
    priorState: receipt.action,
    subjectId: receipt.receiptId,
    subjectType: RECEIPT_SUBJECT_TYPE,
  });
  if (binding.replayed) throw idempotencyConflict();
}

export function commandResult(
  profile: WorkforceProfileView,
  replayed: boolean,
): WorkforceProfileCommandResult {
  return { billingState: "non_billable", profile, replayed };
}

export const workforceTransactionOptions = {
  serviceActivationKey: HR_WORKFORCE_PROFILE_SERVICE_KEY,
  serviceActivationLock: "share" as const,
};
