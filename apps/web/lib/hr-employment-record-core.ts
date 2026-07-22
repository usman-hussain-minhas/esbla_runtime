import {
  type ApiProblemDetails,
  type HrEmploymentListResponse,
  type HrEmploymentRecord,
  type HrEmploymentRecordMutationResponse,
  parseApiProblemDetails,
  parseHrEmploymentListResponse,
  parseHrEmploymentRecord,
  parseHrEmploymentRecordMutationResponse,
} from "@esbla/contracts";
import {
  type HrServiceControl,
  type HrServiceMutationResponse,
  parseHrServiceControl,
  parseHrServiceMutationResponse,
} from "@esbla/contracts/hr-service-control-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_EMPLOYMENT_ACTIONS_HEADER_LENGTH = 256;

export const EMPLOYMENT_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "configure_service",
  "create_record",
  "create_version",
  "deactivate_service",
  "end_record",
  "list_authorized",
  "view_detail",
  "view_service_control",
] as const);

export type EmploymentAuthorizedAction = (typeof EMPLOYMENT_AUTHORIZED_ACTIONS)[number];
export type EmploymentAuthorizedActions = readonly EmploymentAuthorizedAction[];

export type EmploymentFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";

export type EmploymentOperation =
  | "activate_service"
  | "configure_service"
  | "create_record"
  | "create_version"
  | "deactivate_service"
  | "end_record";

export type EmploymentAction =
  | {
      readonly body: Readonly<{ expectedVersion: number | null }>;
      readonly idempotencyKey: string;
      readonly operation: "activate_service";
    }
  | {
      readonly body: Readonly<{
        expectedSettingsVersion: number;
        settings: Readonly<{
          effectiveRangeOverlapAllowed: false;
          employmentTypeCodes: string;
        }>;
      }>;
      readonly idempotencyKey: string;
      readonly operation: "configure_service";
    }
  | {
      readonly body: Readonly<{ workerProfileId: string }>;
      readonly idempotencyKey: string;
      readonly operation: "create_record";
    }
  | {
      readonly body: Readonly<{
        effectiveFrom: string;
        effectiveTo: string | null;
        employmentTypeCode: string | null;
        expectedCurrentVersion: number | null;
        expectedVersion: number;
        organizationReference: string | null;
        positionReference: string | null;
      }>;
      readonly employmentRecordId: string;
      readonly idempotencyKey: string;
      readonly operation: "create_version";
    }
  | {
      readonly body: Readonly<{ expectedVersion: number }>;
      readonly idempotencyKey: string;
      readonly operation: "deactivate_service";
    }
  | {
      readonly body: Readonly<{
        effectiveTo: string;
        expectedCurrentVersion: number;
        expectedVersion: number;
      }>;
      readonly employmentRecordId: string;
      readonly idempotencyKey: string;
      readonly operation: "end_record";
    };

export interface EmploymentFailureState {
  readonly kind: EmploymentFailureKind;
  readonly message: string;
  readonly status: "error";
  readonly title: string;
}

export type EmploymentActionValidation =
  | { readonly ok: false; readonly state: EmploymentFailureState }
  | { readonly ok: true; readonly value: EmploymentAction };

export class EmploymentUiError extends Error {
  constructor(
    readonly kind: EmploymentFailureKind,
    readonly httpStatus = 503,
  ) {
    super("Employment Record request failed");
    this.name = "EmploymentUiError";
  }
}

function fixedState(kind: EmploymentFailureKind): EmploymentFailureState {
  const content: Record<EmploymentFailureKind, readonly [string, string]> = {
    conflict: [
      "Employment record changed",
      "Reload the current record before trying again. Preserved history was not changed.",
    ],
    denied: [
      "Employment records unavailable",
      "Your current role does not permit this employment-record action.",
    ],
    dependency_unavailable: [
      "Employment dependency unavailable",
      "A required Workforce Profile or activation dependency is unavailable right now.",
    ],
    inactive: [
      "Employment Record inactive",
      "Employment facts and history are preserved, but this service is currently inactive.",
    ],
    not_found: ["Employment record not found", "This employment record is not available."],
    operational_error: [
      "Employment records unavailable",
      "We could not complete the employment-record request. Try again.",
    ],
    validation: [
      "Review the employment facts",
      "The submitted dates, versions, identifiers, or configured codes are invalid.",
    ],
  };
  const [title, message] = content[kind];
  return { kind, message, status: "error", title };
}

export function employmentStateForError(error: unknown): EmploymentFailureState {
  return fixedState(error instanceof EmploymentUiError ? error.kind : "operational_error");
}

export function parseEmploymentAuthorizedActions(response: Response): EmploymentAuthorizedActions {
  const header = response.headers.get("x-esbla-employment-actions");
  if (header === null || header.length > MAX_EMPLOYMENT_ACTIONS_HEADER_LENGTH) {
    throw new EmploymentUiError("operational_error");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    throw new EmploymentUiError("operational_error");
  }
  if (!Array.isArray(parsed) || parsed.some((action) => typeof action !== "string")) {
    throw new EmploymentUiError("operational_error");
  }
  const selected = new Set(parsed);
  const canonical = EMPLOYMENT_AUTHORIZED_ACTIONS.filter((action) => selected.has(action));
  if (
    selected.size !== parsed.length ||
    canonical.length !== parsed.length ||
    JSON.stringify(canonical) !== header
  ) {
    throw new EmploymentUiError("operational_error");
  }
  return Object.freeze([...canonical]);
}

export function hasEmploymentAction(
  actions: EmploymentAuthorizedActions,
  action: EmploymentAuthorizedAction,
): boolean {
  return actions.includes(action);
}

export function parseEmploymentWorkerSelection(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new EmploymentUiError("validation", 400);
  }
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function integer(value: unknown, nullable = false): number | null | undefined {
  if (nullable && value === "") return null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_POSTGRES_INTEGER ? parsed : undefined;
}

function date(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function nullableText(value: unknown): string | null | undefined {
  if (value === "") return null;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function invalid(): EmploymentActionValidation {
  return { ok: false, state: fixedState("validation") };
}

export function validateEmploymentAction(value: unknown): EmploymentActionValidation {
  if (!isRecord(value) || typeof value.operation !== "string") return invalid();
  if (typeof value.idempotencyKey !== "string" || !UUID.test(value.idempotencyKey)) {
    return invalid();
  }
  const idempotencyKey = value.idempotencyKey.toLowerCase();

  if (value.operation === "activate_service") {
    if (!exactKeys(value, ["expectedVersion", "idempotencyKey", "operation"])) return invalid();
    const expectedVersion = integer(value.expectedVersion, true);
    return expectedVersion === undefined
      ? invalid()
      : {
          ok: true,
          value: { body: { expectedVersion }, idempotencyKey, operation: value.operation },
        };
  }
  if (value.operation === "deactivate_service") {
    if (!exactKeys(value, ["expectedVersion", "idempotencyKey", "operation"])) return invalid();
    const expectedVersion = integer(value.expectedVersion);
    return expectedVersion === undefined || expectedVersion === null
      ? invalid()
      : {
          ok: true,
          value: { body: { expectedVersion }, idempotencyKey, operation: value.operation },
        };
  }
  if (value.operation === "configure_service") {
    if (
      !exactKeys(value, [
        "effectiveRangeOverlapAllowed",
        "employmentTypeCodes",
        "expectedSettingsVersion",
        "idempotencyKey",
        "operation",
      ]) ||
      value.effectiveRangeOverlapAllowed !== "false" ||
      typeof value.employmentTypeCodes !== "string" ||
      value.employmentTypeCodes.length === 0 ||
      value.employmentTypeCodes.split(",").some((code) => code.trim() !== code || !code)
    ) {
      return invalid();
    }
    const expectedSettingsVersion = integer(value.expectedSettingsVersion);
    return expectedSettingsVersion === undefined || expectedSettingsVersion === null
      ? invalid()
      : {
          ok: true,
          value: {
            body: {
              expectedSettingsVersion,
              settings: {
                effectiveRangeOverlapAllowed: false,
                employmentTypeCodes: value.employmentTypeCodes,
              },
            },
            idempotencyKey,
            operation: value.operation,
          },
        };
  }
  if (value.operation === "create_record") {
    if (
      !exactKeys(value, ["idempotencyKey", "operation", "workerProfileId"]) ||
      typeof value.workerProfileId !== "string" ||
      !UUID.test(value.workerProfileId)
    ) {
      return invalid();
    }
    return {
      ok: true,
      value: {
        body: { workerProfileId: value.workerProfileId.toLowerCase() },
        idempotencyKey,
        operation: value.operation,
      },
    };
  }
  if (value.operation === "create_version") {
    if (
      !exactKeys(value, [
        "effectiveFrom",
        "effectiveTo",
        "employmentRecordId",
        "employmentTypeCode",
        "expectedCurrentVersion",
        "expectedVersion",
        "idempotencyKey",
        "operation",
        "organizationReference",
        "positionReference",
      ]) ||
      typeof value.employmentRecordId !== "string" ||
      !UUID.test(value.employmentRecordId) ||
      !date(value.effectiveFrom) ||
      (value.effectiveTo !== "" && !date(value.effectiveTo))
    ) {
      return invalid();
    }
    const expectedVersion = integer(value.expectedVersion);
    const expectedCurrentVersion = integer(value.expectedCurrentVersion, true);
    const employmentTypeCode = nullableText(value.employmentTypeCode);
    const organizationReference = nullableText(value.organizationReference);
    const positionReference = nullableText(value.positionReference);
    if (
      expectedVersion === undefined ||
      expectedVersion === null ||
      expectedCurrentVersion === undefined ||
      employmentTypeCode === undefined ||
      organizationReference === undefined ||
      positionReference === undefined
    ) {
      return invalid();
    }
    return {
      ok: true,
      value: {
        body: {
          effectiveFrom: value.effectiveFrom,
          effectiveTo: value.effectiveTo === "" ? null : value.effectiveTo,
          employmentTypeCode,
          expectedCurrentVersion,
          expectedVersion,
          organizationReference,
          positionReference,
        },
        employmentRecordId: value.employmentRecordId.toLowerCase(),
        idempotencyKey,
        operation: value.operation,
      },
    };
  }
  if (value.operation === "end_record") {
    if (
      !exactKeys(value, [
        "effectiveTo",
        "employmentRecordId",
        "expectedCurrentVersion",
        "expectedVersion",
        "idempotencyKey",
        "operation",
      ]) ||
      typeof value.employmentRecordId !== "string" ||
      !UUID.test(value.employmentRecordId) ||
      !date(value.effectiveTo)
    ) {
      return invalid();
    }
    const expectedVersion = integer(value.expectedVersion);
    const expectedCurrentVersion = integer(value.expectedCurrentVersion);
    if (
      expectedVersion === undefined ||
      expectedVersion === null ||
      expectedCurrentVersion === undefined ||
      expectedCurrentVersion === null
    ) {
      return invalid();
    }
    return {
      ok: true,
      value: {
        body: { effectiveTo: value.effectiveTo, expectedCurrentVersion, expectedVersion },
        employmentRecordId: value.employmentRecordId.toLowerCase(),
        idempotencyKey,
        operation: value.operation,
      },
    };
  }
  return invalid();
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function problemError(problem: ApiProblemDetails): EmploymentUiError {
  if (
    problem.status === 403 &&
    ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code)
  ) {
    return new EmploymentUiError("denied", 403);
  }
  if (
    problem.status === 404 &&
    ["EMPLOYMENT_NOT_FOUND", "EMPLOYMENT_SERVICE_CONTROL_NOT_FOUND"].includes(problem.code)
  ) {
    return new EmploymentUiError("not_found", 404);
  }
  if (problem.status === 503 && problem.code === "EMPLOYMENT_SERVICE_INACTIVE") {
    return new EmploymentUiError("inactive", 503);
  }
  if (
    problem.status === 503 &&
    ["ACTIVATION_DEPENDENCY_BLOCKED", "EMPLOYMENT_DEPENDENCY_INACTIVE"].includes(problem.code)
  ) {
    return new EmploymentUiError("dependency_unavailable", 503);
  }
  if (
    problem.status === 400 &&
    ["EMPLOYMENT_INPUT_INVALID", "REQUEST_VALIDATION_FAILED"].includes(problem.code)
  ) {
    return new EmploymentUiError("validation", 400);
  }
  if (
    problem.status === 409 &&
    [
      "ACTIVATION_CONFLICT",
      "EMPLOYMENT_CONFLICT",
      "EMPLOYMENT_VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
    ].includes(problem.code)
  ) {
    return new EmploymentUiError("conflict", 409);
  }
  return new EmploymentUiError("operational_error");
}

async function responseJson(responsePromise: Promise<Response>): Promise<unknown> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new EmploymentUiError("operational_error");
  }
  if (response.status === 200 && mediaType(response) === "application/json") {
    try {
      return await response.json();
    } catch {
      throw new EmploymentUiError("operational_error");
    }
  }
  if (response.status >= 400 && mediaType(response) === "application/problem+json") {
    try {
      const problem = parseApiProblemDetails(await response.json());
      if (problem.status !== response.status) throw new TypeError("Problem status mismatch");
      throw problemError(problem);
    } catch (error) {
      if (error instanceof EmploymentUiError) throw error;
    }
  }
  throw new EmploymentUiError("operational_error");
}

export async function decodeEmploymentList(
  responsePromise: Promise<Response>,
): Promise<HrEmploymentListResponse> {
  return parseHrEmploymentListResponse(await responseJson(responsePromise));
}

export async function decodeEmploymentRecord(
  responsePromise: Promise<Response>,
): Promise<HrEmploymentRecord> {
  return parseHrEmploymentRecord(await responseJson(responsePromise));
}

export async function decodeEmploymentServiceControl(
  responsePromise: Promise<Response>,
): Promise<HrServiceControl> {
  const control = parseHrServiceControl(await responseJson(responsePromise));
  if (control.serviceKey !== "employment_record") {
    throw new EmploymentUiError("operational_error");
  }
  return control;
}

export async function decodeEmploymentMutation(
  responsePromise: Promise<Response>,
  expected: EmploymentOperation,
): Promise<HrEmploymentRecordMutationResponse | HrServiceMutationResponse> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new EmploymentUiError("operational_error");
  }
  const replay = response.headers.get("idempotent-replayed");
  const validSuccess =
    expected === "create_record" || expected === "create_version"
      ? (response.status === 201 && replay === "false") ||
        (response.status === 200 && replay === "true")
      : response.status === 200 && (replay === "true" || replay === "false");
  if (validSuccess && mediaType(response) === "application/json") {
    try {
      if (
        expected === "create_record" ||
        expected === "create_version" ||
        expected === "end_record"
      ) {
        const result = parseHrEmploymentRecordMutationResponse(await response.json());
        if (result.operation !== expected) throw new TypeError("Wrong record mutation operation");
        return result;
      }
      const result = parseHrServiceMutationResponse(await response.json());
      if (result.serviceKey !== "employment_record" || result.operation !== expected) {
        throw new TypeError("Wrong service mutation operation");
      }
      return result;
    } catch {
      throw new EmploymentUiError("operational_error");
    }
  }
  if (response.status >= 400 && mediaType(response) === "application/problem+json") {
    try {
      const problem = parseApiProblemDetails(await response.json());
      if (problem.status !== response.status) throw new TypeError("Problem status mismatch");
      throw problemError(problem);
    } catch (error) {
      if (error instanceof EmploymentUiError) throw error;
    }
  }
  throw new EmploymentUiError("operational_error");
}
