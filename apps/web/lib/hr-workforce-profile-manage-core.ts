import {
  type HrWorkforceProfile,
  type HrWorkforceServiceControl,
  parseApiProblemDetails,
  parseHrWorkforceProfile,
  parseHrWorkforceServiceControl,
} from "@esbla/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HrWorkforceManageFailureKind =
  | "conflict"
  | "forbidden"
  | "inactive"
  | "invalid"
  | "not_found"
  | "principal_unavailable"
  | "unavailable";

export interface HrWorkforceApiCommand {
  readonly body: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly method: "POST";
  readonly path: string;
}

export type HrWorkforceManagementValidation =
  | { readonly error: HrWorkforceManageError; readonly ok: false }
  | { readonly command: HrWorkforceApiCommand; readonly ok: true };

export type HrWorkforceControlState =
  | { readonly control: HrWorkforceServiceControl; readonly status: "ready" }
  | { readonly status: "uninitialized" };

export type HrWorkforceManageTransport =
  | { readonly message: string; readonly ok: false }
  | { readonly ok: true; readonly profile: HrWorkforceProfile };

export type HrWorkforceControlTransport =
  | { readonly message: string; readonly ok: false }
  | { readonly control: HrWorkforceServiceControl; readonly ok: true };

export class HrWorkforceManageError extends Error {
  constructor(readonly kind: HrWorkforceManageFailureKind) {
    super("The workforce profile action could not be completed");
    this.name = "HrWorkforceManageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function invalid(): HrWorkforceManagementValidation {
  return { error: new HrWorkforceManageError("invalid"), ok: false };
}

export function validateWorkforceManagementCommand(
  value: unknown,
): HrWorkforceManagementValidation {
  if (!isRecord(value) || typeof value.action !== "string") return invalid();
  const idempotencyKey = value.idempotencyKey;
  if (!uuid(idempotencyKey)) return invalid();

  if (value.action === "create") {
    if (!hasExactKeys(value, ["action", "employeeNumber", "idempotencyKey"])) return invalid();
    if (typeof value.employeeNumber !== "string") return invalid();
    const employeeNumber = value.employeeNumber.trim();
    if (employeeNumber.length > 64) return invalid();
    return {
      command: {
        body: employeeNumber ? { employeeNumber } : {},
        idempotencyKey,
        method: "POST",
        path: "/v1/hr/workforce-profiles",
      },
      ok: true,
    };
  }

  if (value.action === "link") {
    if (
      !hasExactKeys(value, [
        "action",
        "expectedVersion",
        "idempotencyKey",
        "principalId",
        "workerProfileId",
      ]) ||
      !positiveInteger(value.expectedVersion) ||
      !uuid(value.principalId) ||
      !uuid(value.workerProfileId)
    ) {
      return invalid();
    }
    return {
      command: {
        body: { expectedVersion: value.expectedVersion, principalId: value.principalId },
        idempotencyKey,
        method: "POST",
        path: `/v1/hr/workforce-profiles/${value.workerProfileId}/principal-link`,
      },
      ok: true,
    };
  }

  if (value.action === "activate_profile") {
    if (
      !hasExactKeys(value, ["action", "expectedVersion", "idempotencyKey", "workerProfileId"]) ||
      !positiveInteger(value.expectedVersion) ||
      !uuid(value.workerProfileId)
    ) {
      return invalid();
    }
    return {
      command: {
        body: { expectedVersion: value.expectedVersion, targetStatus: "active" },
        idempotencyKey,
        method: "POST",
        path: `/v1/hr/workforce-profiles/${value.workerProfileId}/status`,
      },
      ok: true,
    };
  }

  return invalid();
}

export function validateWorkforceControlCommand(value: unknown): HrWorkforceManagementValidation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["action", "expectedVersion", "idempotencyKey"]) ||
    (value.action !== "activate" && value.action !== "deactivate") ||
    !uuid(value.idempotencyKey) ||
    !(value.expectedVersion === null || positiveInteger(value.expectedVersion)) ||
    (value.action === "deactivate" && value.expectedVersion === null)
  ) {
    return invalid();
  }
  return {
    command: {
      body: { expectedVersion: value.expectedVersion },
      idempotencyKey: value.idempotencyKey,
      method: "POST",
      path: `/v1/hr/workforce-profiles/service-control/${value.action}`,
    },
    ok: true,
  };
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function failureKind(code: string, status: number): HrWorkforceManageFailureKind {
  if (code === "WORKFORCE_PROFILE_SERVICE_INACTIVE") return "inactive";
  if (code === "POLICY_DENIED" || code === "ACTOR_NOT_ACTIVE_MEMBER" || status === 403) {
    return "forbidden";
  }
  if (code === "WORKFORCE_PROFILE_PRINCIPAL_UNAVAILABLE") return "principal_unavailable";
  if (code === "WORKFORCE_PROFILE_NOT_FOUND" || status === 404) return "not_found";
  if (
    code === "WORKFORCE_PROFILE_INPUT_INVALID" ||
    code === "REQUEST_VALIDATION_FAILED" ||
    status === 400
  ) {
    return "invalid";
  }
  if (
    code === "WORKFORCE_PROFILE_IDEMPOTENCY_CONFLICT" ||
    code === "WORKFORCE_PROFILE_STATE_CONFLICT" ||
    code === "WORKFORCE_PROFILE_VERSION_CONFLICT" ||
    code === "ACTIVATION_CONFLICT" ||
    status === 409
  ) {
    return "conflict";
  }
  return "unavailable";
}

async function responsePayload(responsePromise: Promise<Response>) {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrWorkforceManageError("unavailable");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HrWorkforceManageError("unavailable");
  }
  return { payload, response };
}

function throwProblem(response: Response, payload: unknown): never {
  if (mediaType(response) !== "application/problem+json") {
    throw new HrWorkforceManageError("unavailable");
  }
  try {
    const problem = parseApiProblemDetails(payload);
    if (problem.status !== response.status) throw new HrWorkforceManageError("unavailable");
    throw new HrWorkforceManageError(failureKind(problem.code, problem.status));
  } catch (error) {
    if (error instanceof HrWorkforceManageError) throw error;
    throw new HrWorkforceManageError("unavailable");
  }
}

export async function decodeWorkforceProfileMutationResponse(
  responsePromise: Promise<Response>,
): Promise<HrWorkforceProfile> {
  const { payload, response } = await responsePayload(responsePromise);
  if (
    (response.status === 200 || response.status === 201) &&
    mediaType(response) === "application/json"
  ) {
    try {
      return parseHrWorkforceProfile(payload);
    } catch {
      throw new HrWorkforceManageError("unavailable");
    }
  }
  throwProblem(response, payload);
}

export async function decodeWorkforceControlResponse(
  responsePromise: Promise<Response>,
): Promise<HrWorkforceServiceControl> {
  const { payload, response } = await responsePayload(responsePromise);
  if (response.status === 200 && mediaType(response) === "application/json") {
    try {
      return parseHrWorkforceServiceControl(payload);
    } catch {
      throw new HrWorkforceManageError("unavailable");
    }
  }
  throwProblem(response, payload);
}

export async function decodeWorkforceControlState(
  responsePromise: Promise<Response>,
): Promise<HrWorkforceControlState> {
  try {
    return { control: await decodeWorkforceControlResponse(responsePromise), status: "ready" };
  } catch (error) {
    if (error instanceof HrWorkforceManageError && error.kind === "not_found") {
      return { status: "uninitialized" };
    }
    throw error;
  }
}

export function workforceManageMessage(error: unknown): string {
  const kind = error instanceof HrWorkforceManageError ? error.kind : "unavailable";
  const messages: Record<HrWorkforceManageFailureKind, string> = {
    conflict: "The workforce profile changed. Refresh and try again.",
    forbidden: "You do not have permission to complete this workforce action.",
    inactive: "Workforce profiles are not active for this tenant.",
    invalid: "Review the workforce profile details and try again.",
    not_found: "The workforce profile could not be found.",
    principal_unavailable: "That principal is not available for this workforce profile.",
    unavailable: "The workforce profile action is unavailable. Try again.",
  };
  return messages[kind];
}

function exactTransportRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new TypeError("Workforce transport is invalid");
  }
  return value;
}

export function parseWorkforceManageTransport(value: unknown): HrWorkforceManageTransport {
  const record = exactTransportRecord(value);
  if (record.ok) {
    if (!hasExactKeys(record, ["ok", "profile"]))
      throw new TypeError("Workforce transport is invalid");
    return { ok: true, profile: parseHrWorkforceProfile(record.profile) };
  }
  if (!hasExactKeys(record, ["message", "ok"]) || typeof record.message !== "string") {
    throw new TypeError("Workforce transport is invalid");
  }
  return { message: record.message, ok: false };
}

export function parseWorkforceControlTransport(value: unknown): HrWorkforceControlTransport {
  const record = exactTransportRecord(value);
  if (record.ok) {
    if (!hasExactKeys(record, ["control", "ok"]))
      throw new TypeError("Workforce control transport is invalid");
    return { control: parseHrWorkforceServiceControl(record.control), ok: true };
  }
  if (!hasExactKeys(record, ["message", "ok"]) || typeof record.message !== "string") {
    throw new TypeError("Workforce control transport is invalid");
  }
  return { message: record.message, ok: false };
}
