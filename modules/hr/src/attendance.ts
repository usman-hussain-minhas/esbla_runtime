import { createHash } from "node:crypto";
import type {
  HrAttendanceObservation,
  HrAttendanceObservationKind,
  HrAttendanceRecordManualBody,
} from "@esbla/contracts";
import {
  appendEvidence,
  assertPolicyAllowed,
  deriveStableUuid,
  evaluatePolicy,
  type OperationContext,
  PlatformError,
  recordMutationProof,
  type TenantTransaction,
  withTenantTransaction,
} from "@esbla/platform-core";
import type { Pool } from "pg";
import { hrManifest } from "./manifest.js";

export const HR_ATTENDANCE_SERVICE_KEY = "attendance";
export const HR_ATTENDANCE_BILLING_STATE = "non_billable";
const ACTION_KEY = "hr.attendance.record_manual";
const EVENT_TYPE = ACTION_KEY;
const SUBJECT_OBSERVATION = "hr.attendance.observation";
const SUBJECT_RECEIPT = "hr.attendance.idempotency";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AttendanceErrorCode =
  | "ATTENDANCE_CONFLICT"
  | "ATTENDANCE_DEPENDENCY_INACTIVE"
  | "ATTENDANCE_INPUT_INVALID"
  | "ATTENDANCE_SERVICE_INACTIVE"
  | "ATTENDANCE_WORKER_UNAVAILABLE";

export class HrAttendanceError extends Error {
  readonly code: AttendanceErrorCode;

  constructor(code: AttendanceErrorCode, message: string) {
    super(message);
    this.name = "HrAttendanceError";
    this.code = code;
  }
}

export interface RecordManualAttendanceInput extends HrAttendanceRecordManualBody {
  readonly idempotencyKey: string;
}

export interface RecordManualAttendanceResult {
  readonly billingState: typeof HR_ATTENDANCE_BILLING_STATE;
  readonly observation: HrAttendanceObservation;
  readonly replayed: boolean;
}

interface ObservationRow {
  readonly attendance_observation_id: string;
  readonly observation_kind: HrAttendanceObservationKind;
  readonly observed_at: Date | string;
  readonly row_version: number;
  readonly source_kind: "manual" | "synthetic";
  readonly worker_profile_id: string;
}

interface Receipt {
  readonly receiptId: string;
  readonly semanticSha256: string;
}

function inputInvalid(message: string): HrAttendanceError {
  return new HrAttendanceError("ATTENDANCE_INPUT_INVALID", message);
}

function conflict(message: string): HrAttendanceError {
  return new HrAttendanceError("ATTENDANCE_CONFLICT", message);
}

function idempotencyConflict(): PlatformError {
  return new PlatformError(
    "IDEMPOTENCY_CONFLICT",
    "Idempotency key was already used with different Attendance data",
  );
}

function isPostgresCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    codes.includes(String((error as { code?: unknown }).code))
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw inputInvalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

function normalizeInstant(value: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    !/[zZ]|[+-]\d\d:\d\d$/.test(value)
  ) {
    throw inputInvalid("observedAt must be a timezone-aware instant");
  }
  return new Date(value).toISOString();
}

function semanticSha256(values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function mapObservation(row: ObservationRow): HrAttendanceObservation {
  const observedAt =
    row.observed_at instanceof Date
      ? row.observed_at.toISOString()
      : new Date(row.observed_at).toISOString();
  if (
    !UUID_PATTERN.test(row.attendance_observation_id) ||
    !UUID_PATTERN.test(row.worker_profile_id) ||
    !Number.isFinite(Date.parse(observedAt)) ||
    !["presence_start", "presence_end"].includes(row.observation_kind) ||
    !["manual", "synthetic"].includes(row.source_kind) ||
    row.row_version !== 1
  ) {
    throw conflict("Stored Attendance observation is invalid");
  }
  return {
    attendanceObservationId: row.attendance_observation_id,
    observationKind: row.observation_kind,
    observedAt,
    sourceKind: row.source_kind,
    version: 1,
    workerProfileId: row.worker_profile_id,
  };
}

async function withAttendanceTransaction<T>(
  pool: Pool,
  context: OperationContext,
  operation: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      if (transaction.lockedServiceActivation?.state !== "active") {
        throw new HrAttendanceError(
          "ATTENDANCE_SERVICE_INACTIVE",
          "Attendance service is inactive",
        );
      }
      let dependency:
        | { readonly rows: readonly { readonly state: "active" | "inactive" }[] }
        | undefined;
      try {
        dependency = await transaction.client.query<{ state: "active" | "inactive" }>(
          `SELECT state FROM service_activations
           WHERE tenant_id=$1 AND service_key='workforce_profile' FOR SHARE NOWAIT`,
          [transaction.context.tenantId],
        );
      } catch (error) {
        if (!isPostgresCode(error, "55P03")) throw error;
      }
      if (dependency?.rows[0]?.state !== "active") {
        throw new HrAttendanceError(
          "ATTENDANCE_DEPENDENCY_INACTIVE",
          "Attendance dependency is unavailable",
        );
      }
      return await operation(transaction);
    },
    { serviceActivationKey: HR_ATTENDANCE_SERVICE_KEY, serviceActivationLock: "share" },
  );
}

async function authorize(transaction: TenantTransaction): Promise<void> {
  const registered = hrManifest.capabilities.some(
    ({ exposure, id }) => exposure === "tenant" && id === ACTION_KEY,
  );
  const capability = await transaction.client.query(
    `SELECT capability_id FROM membership_capabilities
     WHERE tenant_id=$1 AND principal_id=$2 AND capability_id=$3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, ACTION_KEY],
  );
  assertPolicyAllowed(
    evaluatePolicy(
      {
        actionKey: ACTION_KEY,
        input: { capabilityCurrent: registered && capability.rows.length === 1 },
        resourceKey: HR_ATTENDANCE_SERVICE_KEY,
        transaction,
      },
      [
        {
          effect: "allow",
          id: "current_hr_operator_record_manual",
          matches: (request, actor) => actor.roleKey === "hr_operator" && request.capabilityCurrent,
        },
      ],
    ),
    transaction,
    ACTION_KEY,
    HR_ATTENDANCE_SERVICE_KEY,
  );
}

async function prepareReceipt(
  transaction: TenantTransaction,
  idempotencyKey: string,
  semantics: readonly unknown[],
): Promise<Receipt> {
  const receiptId = deriveStableUuid(
    "hr.attendance.idempotency.v1",
    transaction.context.tenantId,
    transaction.context.actorPrincipalId,
    "record_manual",
    normalizeUuid(idempotencyKey, "idempotencyKey"),
  );
  await transaction.client.query(
    "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))",
    [receiptId],
  );
  return { receiptId, semanticSha256: semanticSha256(semantics) };
}

async function readReplay(
  transaction: TenantTransaction,
  receipt: Receipt,
): Promise<HrAttendanceObservation | null> {
  const bound = await transaction.client.query<{
    actor_principal_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT actor_principal_id,prior_state,new_state FROM evidence_events
     WHERE tenant_id=$1 AND subject_type=$2 AND subject_id=$3
       AND event_type=$4 AND correlation_id=$5 LIMIT 2`,
    [
      transaction.context.tenantId,
      SUBJECT_RECEIPT,
      receipt.receiptId,
      `${EVENT_TYPE}.response_bound`,
      transaction.context.correlationId,
    ],
  );
  if (bound.rows.length === 0) return null;
  const binding = bound.rows[0];
  if (
    bound.rows.length !== 1 ||
    binding?.actor_principal_id !== transaction.context.actorPrincipalId ||
    binding.prior_state !== receipt.semanticSha256
  ) {
    throw idempotencyConflict();
  }
  const proof = await transaction.client.query<
    ObservationRow & {
      aggregate_version: number;
      new_state: string;
      payload: unknown;
      prior_state: string | null;
    }
  >(
    `SELECT observation.attendance_observation_id,observation.worker_profile_id,
            observation.observed_at,observation.observation_kind,observation.source_kind,
            observation.row_version,outbox.aggregate_version,outbox.payload,
            evidence.prior_state,evidence.new_state
     FROM evidence_events evidence
     JOIN outbox_events outbox
       ON outbox.tenant_id=evidence.tenant_id
      AND outbox.event_type=evidence.event_type
      AND outbox.aggregate_type=evidence.subject_type
      AND outbox.aggregate_id=evidence.subject_id
      AND outbox.correlation_id=evidence.correlation_id
     JOIN hr_attendance_observations observation
       ON observation.tenant_id=evidence.tenant_id
      AND observation.attendance_observation_id=evidence.subject_id
     WHERE evidence.tenant_id=$1 AND evidence.event_type=$2
       AND evidence.correlation_id=$3 AND evidence.actor_principal_id=$4
       AND outbox.payload->>'receiptId'=$5 LIMIT 2`,
    [
      transaction.context.tenantId,
      EVENT_TYPE,
      transaction.context.correlationId,
      transaction.context.actorPrincipalId,
      receipt.receiptId,
    ],
  );
  const row = proof.rows[0];
  const payload =
    typeof row?.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  if (
    proof.rows.length !== 1 ||
    !row ||
    !payload ||
    row.aggregate_version !== 1 ||
    row.prior_state !== null ||
    row.new_state !== "recorded" ||
    payload.action !== "record_manual" ||
    payload.afterVersion !== 1 ||
    payload.beforeVersion !== null ||
    payload.billingState !== HR_ATTENDANCE_BILLING_STATE ||
    payload.receiptId !== receipt.receiptId
  ) {
    throw idempotencyConflict();
  }
  const observation = mapObservation(row);
  if (binding.new_state !== semanticSha256([observation])) throw idempotencyConflict();
  return observation;
}

async function assertKindAllowed(
  transaction: TenantTransaction,
  observationKind: HrAttendanceObservationKind,
): Promise<void> {
  const result = await transaction.client.query<{ snapshot: unknown }>(
    "SELECT public.esbla_lock_hr_attendance_settings_snapshot() AS snapshot",
  );
  const snapshot = asRecord(result.rows[0]?.snapshot);
  const settings = asRecord(snapshot?.settings);
  const settingsVersion = snapshot?.settingsVersion;
  const rootKeys = snapshot ? Object.keys(snapshot).sort() : [];
  const settingKeys = settings ? Object.keys(settings).sort() : [];
  if (
    rootKeys.length !== 2 ||
    rootKeys[0] !== "settings" ||
    rootKeys[1] !== "settingsVersion" ||
    !settings ||
    !Number.isSafeInteger(settingsVersion) ||
    Number(settingsVersion) < 1
  ) {
    throw conflict("Attendance settings are not current");
  }
  if (settingsVersion === 1 && settingKeys.length === 0) return;
  const correction = asRecord(settings["hr.attendance.correction_note_required"]);
  const manual = asRecord(settings["hr.attendance.manual_observation_kinds"]);
  if (
    settingKeys.join(",") !==
      "hr.attendance.correction_note_required,hr.attendance.manual_observation_kinds" ||
    Object.keys(correction ?? {})
      .sort()
      .join(",") !== "type,value,version" ||
    Object.keys(manual ?? {})
      .sort()
      .join(",") !== "type,value,version" ||
    correction?.type !== "boolean" ||
    correction?.value !== true ||
    correction.version !== Number(settingsVersion) - 1 ||
    manual?.type !== "text" ||
    typeof manual?.value !== "string" ||
    !["", "presence_start", "presence_end", "presence_start,presence_end"].includes(manual.value) ||
    manual.version !== Number(settingsVersion) - 1
  ) {
    throw conflict("Attendance settings are not current");
  }
  if (!manual.value.split(",").includes(observationKind)) {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the observation kind");
  }
}

function translateWriteError(error: unknown): never {
  if (error instanceof HrAttendanceError || error instanceof PlatformError) throw error;
  if (isPostgresCode(error, "42501")) {
    throw new PlatformError("POLICY_DENIED", "Attendance authority was denied");
  }
  if (isPostgresCode(error, "23503")) {
    throw new HrAttendanceError(
      "ATTENDANCE_WORKER_UNAVAILABLE",
      "Attendance worker is unavailable",
    );
  }
  if (isPostgresCode(error, "22023", "22007", "22008")) {
    throw inputInvalid("Attendance data is invalid");
  }
  if (isPostgresCode(error, "40001", "40P01", "55000")) {
    throw conflict("Attendance currentness check failed");
  }
  throw error;
}

export async function recordManualAttendanceObservation(
  pool: Pool,
  context: OperationContext,
  input: RecordManualAttendanceInput,
): Promise<RecordManualAttendanceResult> {
  const workerProfileId = normalizeUuid(input.workerProfileId, "workerProfileId");
  const observedAt = normalizeInstant(input.observedAt);
  if (!["presence_start", "presence_end"].includes(input.observationKind)) {
    throw inputInvalid("observationKind is invalid");
  }
  try {
    return await withAttendanceTransaction(pool, context, async (transaction) => {
      await authorize(transaction);
      const receipt = await prepareReceipt(transaction, input.idempotencyKey, [
        workerProfileId,
        observedAt,
        input.observationKind,
        "manual",
      ]);
      const replay = await readReplay(transaction, receipt);
      if (replay) {
        return {
          billingState: HR_ATTENDANCE_BILLING_STATE,
          observation: replay,
          replayed: true,
        };
      }
      await assertKindAllowed(transaction, input.observationKind);
      const worker = await transaction.client.query<{ workforce_status: string }>(
        `SELECT workforce_status FROM hr_worker_profiles
         WHERE tenant_id=$1 AND worker_profile_id=$2 FOR SHARE`,
        [transaction.context.tenantId, workerProfileId],
      );
      if (worker.rows[0]?.workforce_status !== "active") {
        throw new HrAttendanceError(
          "ATTENDANCE_WORKER_UNAVAILABLE",
          "Attendance worker is unavailable",
        );
      }
      const inserted = await transaction.client.query<ObservationRow>(
        `INSERT INTO hr_attendance_observations
           (tenant_id,worker_profile_id,observed_at,observation_kind,source_kind)
         VALUES ($1,$2,$3,$4,'manual')
         RETURNING attendance_observation_id,worker_profile_id,observed_at,
                   observation_kind,source_kind,row_version`,
        [transaction.context.tenantId, workerProfileId, observedAt, input.observationKind],
      );
      const observation = mapObservation(inserted.rows[0] as ObservationRow);
      await recordMutationProof(transaction, {
        evidence: {
          eventType: EVENT_TYPE,
          newState: "recorded",
          priorState: null,
          subjectId: observation.attendanceObservationId,
          subjectType: SUBJECT_OBSERVATION,
        },
        outbox: {
          aggregateId: observation.attendanceObservationId,
          aggregateType: SUBJECT_OBSERVATION,
          aggregateVersion: 1,
          eventType: EVENT_TYPE,
          payload: {
            action: "record_manual",
            afterVersion: 1,
            beforeVersion: null,
            billingState: HR_ATTENDANCE_BILLING_STATE,
            observationKind: observation.observationKind,
            receiptId: receipt.receiptId,
            workerProfileId: observation.workerProfileId,
          },
        },
      });
      const bound = await appendEvidence(transaction, {
        eventType: `${EVENT_TYPE}.response_bound`,
        newState: semanticSha256([observation]),
        priorState: receipt.semanticSha256,
        subjectId: receipt.receiptId,
        subjectType: SUBJECT_RECEIPT,
      });
      if (bound.replayed) throw idempotencyConflict();
      return {
        billingState: HR_ATTENDANCE_BILLING_STATE,
        observation,
        replayed: false,
      };
    });
  } catch (error) {
    return translateWriteError(error);
  }
}
