import {
  type ApiProblemDetails,
  type HrReportingRelationshipStatus,
  type HrWorkforceStatus,
  type HrWorkforceStatusTarget,
  parseApiProblemDetails,
  parseHrReportingRelationship,
  parseHrWorkforceProfile,
} from "@esbla/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_STATUSES = new Set([400, 403, 404, 409, 415, 422, 503]);

export type WorkforceMaintenanceOperation = "reporting" | "status";
export type WorkforceMaintenanceFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export type WorkforceMaintenanceField = "managerWorkerProfileId" | "status";

export type WorkforceMaintenanceAction =
  | {
      readonly body: Readonly<{
        expectedVersion: number;
        managerWorkerProfileId: string | null;
        relationshipStatus: HrReportingRelationshipStatus;
      }>;
      readonly idempotencyKey: string;
      readonly operation: "reporting";
    }
  | {
      readonly body: Readonly<{
        expectedVersion: number;
        status: HrWorkforceStatusTarget;
      }>;
      readonly idempotencyKey: string;
      readonly operation: "status";
    };

export type WorkforceMaintenanceResult =
  | Readonly<{
      managerWorkerProfileId: string | null;
      operation: "reporting";
      relationshipStatus: HrReportingRelationshipStatus;
      workerProfileId: string;
      workerProfileVersion: number;
    }>
  | Readonly<{
      operation: "status";
      status: HrWorkforceStatusTarget;
      workerProfileId: string;
      workerProfileVersion: number;
    }>;

export interface WorkforceMaintenanceFormState {
  readonly fieldErrors: Readonly<Partial<Record<WorkforceMaintenanceField, string>>>;
  readonly kind: WorkforceMaintenanceFailureKind;
  readonly message: string;
  readonly status: "error";
}

export type WorkforceMaintenanceValidation =
  | { readonly ok: false; readonly state: WorkforceMaintenanceFormState }
  | { readonly ok: true; readonly value: WorkforceMaintenanceAction };

export type WorkforceMaintenanceTransport =
  | { readonly ok: false; readonly state: WorkforceMaintenanceFormState }
  | { readonly ok: true; readonly result: WorkforceMaintenanceResult };

export class WorkforceMaintenanceUiError extends Error {
  constructor(
    readonly kind: WorkforceMaintenanceFailureKind,
    readonly httpStatus = 503,
    readonly field?: WorkforceMaintenanceField,
  ) {
    super("Workforce Profile maintenance request failed");
    this.name = "WorkforceMaintenanceUiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function uuid(value: unknown, field?: WorkforceMaintenanceField): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new WorkforceMaintenanceUiError("validation", 400, field);
  }
  return value.toLowerCase();
}

export function normalizeWorkforceMaintenanceTarget(value: unknown): string {
  return uuid(value);
}

const nextStatusTargets: Readonly<Record<HrWorkforceStatus, readonly HrWorkforceStatusTarget[]>> = {
  active: ["suspended", "terminated"],
  draft: ["active"],
  suspended: ["active", "terminated"],
  terminated: [],
};

export function allowedWorkforceStatusTargets(
  status: HrWorkforceStatus,
): readonly HrWorkforceStatusTarget[] {
  return nextStatusTargets[status];
}

function fixedFormState(
  kind: WorkforceMaintenanceFailureKind,
  field?: WorkforceMaintenanceField,
): WorkforceMaintenanceFormState {
  const messages: Record<WorkforceMaintenanceFailureKind, string> = {
    conflict: "This workforce change conflicts with current workforce data. Reload and try again.",
    denied: "You do not have current permission to make this workforce change.",
    dependency_unavailable: "A required workforce dependency is unavailable right now.",
    inactive: "Workforce Profile is not available right now.",
    not_found: "This workforce profile is no longer available.",
    operational_error: "We could not complete this workforce change. Try again.",
    validation: "Review the highlighted field and try again.",
  };
  const fieldErrors =
    field === "managerWorkerProfileId"
      ? { managerWorkerProfileId: "Enter the canonical Worker Profile UUID for the manager." }
      : field === "status"
        ? { status: "Choose an allowed next workforce status." }
        : {};
  return { fieldErrors, kind, message: messages[kind], status: "error" };
}

export function workforceMaintenanceFormStateForError(
  error: unknown,
): WorkforceMaintenanceFormState {
  return error instanceof WorkforceMaintenanceUiError
    ? fixedFormState(error.kind, error.field)
    : fixedFormState("operational_error");
}

export function statusForWorkforceMaintenanceError(error: unknown): number {
  return error instanceof WorkforceMaintenanceUiError && ERROR_STATUSES.has(error.httpStatus)
    ? error.httpStatus
    : 503;
}

function invalid(field?: WorkforceMaintenanceField): WorkforceMaintenanceValidation {
  return { ok: false, state: fixedFormState("validation", field) };
}

export function validateWorkforceMaintenanceAction(value: unknown): WorkforceMaintenanceValidation {
  if (!isRecord(value) || !["reporting", "status"].includes(String(value.operation))) {
    return invalid();
  }
  if (!positiveInteger(value.expectedVersion)) return invalid();
  let idempotencyKey: string;
  try {
    idempotencyKey = uuid(value.idempotencyKey);
  } catch {
    return invalid();
  }

  if (value.operation === "status") {
    if (
      !exactKeys(value, ["expectedVersion", "idempotencyKey", "operation", "status"]) ||
      !["active", "suspended", "terminated"].includes(String(value.status))
    ) {
      return invalid("status");
    }
    return {
      ok: true,
      value: {
        body: {
          expectedVersion: value.expectedVersion as number,
          status: value.status as HrWorkforceStatusTarget,
        },
        idempotencyKey,
        operation: "status",
      },
    };
  }

  if (
    !exactKeys(value, [
      "expectedVersion",
      "idempotencyKey",
      "managerWorkerProfileId",
      "operation",
    ]) ||
    (value.managerWorkerProfileId !== null && typeof value.managerWorkerProfileId !== "string")
  ) {
    return invalid("managerWorkerProfileId");
  }
  let managerWorkerProfileId: string | null = null;
  if (typeof value.managerWorkerProfileId === "string") {
    try {
      managerWorkerProfileId = uuid(value.managerWorkerProfileId, "managerWorkerProfileId");
    } catch {
      return invalid("managerWorkerProfileId");
    }
  }
  return {
    ok: true,
    value: {
      body: {
        expectedVersion: value.expectedVersion as number,
        managerWorkerProfileId,
        relationshipStatus: managerWorkerProfileId === null ? "unassigned" : "assigned",
      },
      idempotencyKey,
      operation: "reporting",
    },
  };
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function problemError(
  problem: ApiProblemDetails,
  action: WorkforceMaintenanceAction,
): WorkforceMaintenanceUiError {
  if (
    problem.status === 403 &&
    ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code)
  ) {
    return new WorkforceMaintenanceUiError("denied", 403);
  }
  if (problem.status === 404 && problem.code === "WORKFORCE_PROFILE_NOT_FOUND") {
    return action.operation === "reporting" && action.body.managerWorkerProfileId !== null
      ? new WorkforceMaintenanceUiError("conflict", 404)
      : new WorkforceMaintenanceUiError("not_found", 404);
  }
  if (
    problem.status === 409 &&
    ["IDEMPOTENCY_CONFLICT", "WORKFORCE_PROFILE_CONFLICT", "WORKFORCE_VERSION_CONFLICT"].includes(
      problem.code,
    )
  ) {
    return new WorkforceMaintenanceUiError("conflict", 409);
  }
  if (problem.status === 422 && problem.code === "WORKFORCE_PRINCIPAL_INELIGIBLE") {
    return new WorkforceMaintenanceUiError("conflict", 422);
  }
  if (
    problem.status === 400 &&
    ["REQUEST_VALIDATION_FAILED", "WORKFORCE_INPUT_INVALID"].includes(problem.code)
  ) {
    return new WorkforceMaintenanceUiError(
      "validation",
      400,
      action.operation === "status" ? "status" : "managerWorkerProfileId",
    );
  }
  if (problem.status === 503 && problem.code === "WORKFORCE_SERVICE_INACTIVE") {
    return new WorkforceMaintenanceUiError("inactive", 503);
  }
  if (problem.status === 503 && problem.code === "ACTIVATION_DEPENDENCY_BLOCKED") {
    return new WorkforceMaintenanceUiError("dependency_unavailable", 503);
  }
  return new WorkforceMaintenanceUiError("operational_error");
}

function resultForProfile(
  value: unknown,
  workerProfileId: string,
  action: Extract<WorkforceMaintenanceAction, { operation: "status" }>,
): WorkforceMaintenanceResult {
  const parsed = parseHrWorkforceProfile(value);
  if (
    parsed.workerProfileId !== workerProfileId ||
    parsed.version !== action.body.expectedVersion + 1 ||
    parsed.workforceStatus !== action.body.status
  ) {
    throw new TypeError("Unexpected Workforce Profile status response binding");
  }
  return {
    operation: "status",
    status: action.body.status,
    workerProfileId,
    workerProfileVersion: parsed.version,
  };
}

function resultForRelationship(
  value: unknown,
  workerProfileId: string,
  action: Extract<WorkforceMaintenanceAction, { operation: "reporting" }>,
): WorkforceMaintenanceResult {
  const parsed = parseHrReportingRelationship(value);
  if (
    parsed.workerProfileId !== workerProfileId ||
    parsed.workerProfileVersion !== action.body.expectedVersion + 1 ||
    parsed.relationshipStatus !== action.body.relationshipStatus ||
    parsed.managerWorkerProfileId !== action.body.managerWorkerProfileId
  ) {
    throw new TypeError("Unexpected Workforce Profile reporting response binding");
  }
  return {
    managerWorkerProfileId: parsed.managerWorkerProfileId,
    operation: "reporting",
    relationshipStatus: parsed.relationshipStatus,
    workerProfileId,
    workerProfileVersion: parsed.workerProfileVersion,
  };
}

export async function decodeWorkforceMaintenanceApiResponse(
  responsePromise: Promise<Response>,
  rawWorkerProfileId: string,
  action: WorkforceMaintenanceAction,
): Promise<WorkforceMaintenanceResult> {
  const workerProfileId = normalizeWorkforceMaintenanceTarget(rawWorkerProfileId);
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkforceMaintenanceUiError("operational_error");
  }
  const replay = response.headers.get("idempotent-replayed");
  const success =
    action.operation === "status"
      ? response.status === 200 && ["false", "true"].includes(replay ?? "")
      : (response.status === 201 && replay === "false") ||
        (response.status === 200 && replay === "true");
  if (success) {
    if (mediaType(response) !== "application/json") {
      throw new WorkforceMaintenanceUiError("operational_error");
    }
    try {
      const payload: unknown = await response.json();
      return action.operation === "status"
        ? resultForProfile(payload, workerProfileId, action)
        : resultForRelationship(payload, workerProfileId, action);
    } catch {
      throw new WorkforceMaintenanceUiError("operational_error");
    }
  }
  if (
    response.status < 400 ||
    replay !== null ||
    mediaType(response) !== "application/problem+json"
  ) {
    throw new WorkforceMaintenanceUiError("operational_error");
  }
  try {
    const problem = parseApiProblemDetails(await response.json());
    if (problem.status !== response.status) throw new TypeError("Problem status mismatch");
    throw problemError(problem, action);
  } catch (error) {
    if (error instanceof WorkforceMaintenanceUiError) throw error;
    throw new WorkforceMaintenanceUiError("operational_error");
  }
}

function parseFormState(value: unknown): WorkforceMaintenanceFormState {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["fieldErrors", "kind", "message", "status"]) ||
    value.status !== "error" ||
    ![
      "conflict",
      "denied",
      "dependency_unavailable",
      "inactive",
      "not_found",
      "operational_error",
      "validation",
    ].includes(String(value.kind)) ||
    !isRecord(value.fieldErrors)
  ) {
    throw new TypeError("Invalid maintenance state");
  }
  const fieldErrors = value.fieldErrors;
  const fields = Object.keys(fieldErrors);
  if (
    fields.length > 1 ||
    fields.some((field) => !["managerWorkerProfileId", "status"].includes(field)) ||
    typeof value.message !== "string"
  ) {
    throw new TypeError("Invalid maintenance field state");
  }
  const field = fields[0] as WorkforceMaintenanceField | undefined;
  const expected = fixedFormState(value.kind as WorkforceMaintenanceFailureKind, field);
  if (
    value.message !== expected.message ||
    !exactKeys(fieldErrors, Object.keys(expected.fieldErrors)) ||
    Object.entries(expected.fieldErrors).some(([key, message]) => fieldErrors[key] !== message)
  ) {
    throw new TypeError("Unsafe maintenance state");
  }
  return expected;
}

function parseTransportResult(
  value: unknown,
  rawWorkerProfileId: string,
  action: WorkforceMaintenanceAction,
): WorkforceMaintenanceResult {
  if (!isRecord(value)) throw new TypeError("Invalid maintenance result");
  const workerProfileId = normalizeWorkforceMaintenanceTarget(rawWorkerProfileId);
  const version = action.body.expectedVersion + 1;
  if (action.operation === "status") {
    if (
      !exactKeys(value, ["operation", "status", "workerProfileId", "workerProfileVersion"]) ||
      value.operation !== "status" ||
      value.status !== action.body.status ||
      value.workerProfileId !== workerProfileId ||
      value.workerProfileVersion !== version
    ) {
      throw new TypeError("Invalid status result binding");
    }
    return value as unknown as WorkforceMaintenanceResult;
  }
  if (
    !exactKeys(value, [
      "managerWorkerProfileId",
      "operation",
      "relationshipStatus",
      "workerProfileId",
      "workerProfileVersion",
    ]) ||
    value.operation !== "reporting" ||
    value.relationshipStatus !== action.body.relationshipStatus ||
    value.managerWorkerProfileId !== action.body.managerWorkerProfileId ||
    value.workerProfileId !== workerProfileId ||
    value.workerProfileVersion !== version
  ) {
    throw new TypeError("Invalid reporting result binding");
  }
  return value as unknown as WorkforceMaintenanceResult;
}

function routeFailureStatusMatches(status: number, state: WorkforceMaintenanceFormState): boolean {
  if (state.kind === "validation") return status === 400 || status === 415;
  if (state.kind === "conflict") return status === 404 || status === 409 || status === 422;
  const expected = { denied: 403, not_found: 404 } as const;
  return status === (state.kind in expected ? expected[state.kind as keyof typeof expected] : 503);
}

export async function decodeWorkforceMaintenanceTransport(
  responsePromise: Promise<Response>,
  workerProfileId: string,
  action: WorkforceMaintenanceAction,
): Promise<WorkforceMaintenanceTransport> {
  try {
    const response = await responsePromise;
    if (
      response.headers.get("idempotent-replayed") !== null ||
      mediaType(response) !== "application/json"
    ) {
      throw new TypeError("Invalid maintenance transport");
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.ok !== "boolean") {
      throw new TypeError("Invalid maintenance result envelope");
    }
    if (payload.ok) {
      if (response.status !== 200 || !exactKeys(payload, ["ok", "result"])) {
        throw new TypeError("Invalid maintenance success envelope");
      }
      return { ok: true, result: parseTransportResult(payload.result, workerProfileId, action) };
    }
    if (!exactKeys(payload, ["ok", "state"])) {
      throw new TypeError("Invalid maintenance failure envelope");
    }
    const state = parseFormState(payload.state);
    if (!routeFailureStatusMatches(response.status, state)) {
      throw new TypeError("Maintenance failure status mismatch");
    }
    return { ok: false, state };
  } catch {
    return { ok: false, state: fixedFormState("operational_error") };
  }
}
