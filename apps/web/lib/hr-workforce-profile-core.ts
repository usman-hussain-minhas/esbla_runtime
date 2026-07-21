import {
  type ApiProblemDetails,
  type HrWorkforceProfile,
  parseApiProblemDetails,
  parseHrWorkforceProfile,
} from "@esbla/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_STATUSES = new Set([400, 403, 404, 409, 415, 422, 503]);

export type WorkforceActionOperation = "activate" | "create" | "link";
export type WorkforceIdempotencyKeys = Readonly<Record<WorkforceActionOperation, string>>;
export type WorkforceFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export type WorkforceField = "employeeNumber" | "principalId";

export type WorkforceAction =
  | {
      readonly body: Readonly<{ employeeNumber?: string }>;
      readonly idempotencyKey: string;
      readonly operation: "create";
    }
  | {
      readonly body: Readonly<{ expectedVersion: number; principalId: string }>;
      readonly idempotencyKey: string;
      readonly operation: "link";
      readonly workerProfileId: string;
    }
  | {
      readonly body: Readonly<{ expectedVersion: number; status: "active" }>;
      readonly idempotencyKey: string;
      readonly operation: "activate";
      readonly workerProfileId: string;
    };

export interface WorkforceFormState {
  readonly fieldErrors: Readonly<Partial<Record<WorkforceField, string>>>;
  readonly kind: WorkforceFailureKind;
  readonly message: string;
  readonly status: "error";
}

export type WorkforceActionValidation =
  | { readonly ok: false; readonly state: WorkforceFormState }
  | { readonly ok: true; readonly value: WorkforceAction };

export type WorkforceActionTransport =
  | { readonly ok: false; readonly state: WorkforceFormState }
  | { readonly ok: true; readonly profile: HrWorkforceProfile };

export interface WorkforceOnboardingProgress {
  readonly principalLinked: boolean;
  readonly version: number;
  readonly workerProfileId: string;
  readonly workforceStatus: "active" | "draft";
}

export interface WorkforceOnboardingSnapshot {
  readonly idempotencyKeys: WorkforceIdempotencyKeys;
  readonly progress: WorkforceOnboardingProgress | null;
  readonly schemaVersion: 1;
}

export type WorkforceApiExpectation =
  | { readonly employeeNumber: string | null; readonly operation: "create" }
  | { readonly operation: "own" }
  | {
      readonly expectedVersion: number;
      readonly operation: "activate" | "link";
      readonly workerProfileId: string;
    };

export type OwnWorkforceProfileState =
  | { readonly profile: HrWorkforceProfile; readonly status: "success" }
  | {
      readonly message: string;
      readonly status:
        | "denied"
        | "dependency_unavailable"
        | "empty"
        | "inactive"
        | "operational_error";
      readonly title: string;
    };

export class WorkforceProfileUiError extends Error {
  constructor(
    readonly kind: WorkforceFailureKind,
    readonly httpStatus = 503,
    readonly field?: WorkforceField,
  ) {
    super("Workforce Profile request failed");
    this.name = "WorkforceProfileUiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function fixedFormState(kind: WorkforceFailureKind, field?: WorkforceField): WorkforceFormState {
  const messages: Record<WorkforceFailureKind, string> = {
    conflict:
      "This onboarding changed or was already used differently. Completed steps remain recorded.",
    denied: "You do not have permission to complete this onboarding step.",
    dependency_unavailable: "A required workforce dependency is unavailable right now.",
    inactive: "Workforce Profile is not available right now.",
    not_found: "This workforce profile is no longer available.",
    operational_error: "We could not complete this onboarding step. Try again.",
    validation: "Review the highlighted field and try again.",
  };
  const fieldErrors =
    field === "employeeNumber"
      ? { employeeNumber: "Enter an employee number accepted by current workforce settings." }
      : field === "principalId"
        ? { principalId: "Enter an eligible canonical Principal ID." }
        : {};
  return { fieldErrors, kind, message: messages[kind], status: "error" };
}

export function workforceFormStateForError(error: unknown): WorkforceFormState {
  return error instanceof WorkforceProfileUiError
    ? fixedFormState(error.kind, error.field)
    : fixedFormState("operational_error");
}

function invalid(field?: WorkforceField): WorkforceActionValidation {
  return { ok: false, state: fixedFormState("validation", field) };
}

export function validateWorkforceAction(value: unknown): WorkforceActionValidation {
  if (!isRecord(value) || !["activate", "create", "link"].includes(String(value.operation))) {
    return invalid();
  }
  const idempotencyKey = value.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) return invalid();

  if (value.operation === "create") {
    if (!exactKeys(value, ["employeeNumber", "idempotencyKey", "operation"])) return invalid();
    if (typeof value.employeeNumber !== "string") return invalid("employeeNumber");
    if (value.employeeNumber !== "" && value.employeeNumber.trim() === "") {
      return invalid("employeeNumber");
    }
    return {
      ok: true,
      value: {
        body: value.employeeNumber === "" ? {} : { employeeNumber: value.employeeNumber },
        idempotencyKey,
        operation: "create",
      },
    };
  }

  const expected = ["expectedVersion", "idempotencyKey", "operation", "workerProfileId"];
  if (value.operation === "link") expected.push("principalId");
  if (!exactKeys(value, expected) || !positiveInteger(value.expectedVersion)) return invalid();
  if (typeof value.workerProfileId !== "string" || !UUID.test(value.workerProfileId)) {
    return invalid();
  }
  if (value.operation === "link") {
    if (typeof value.principalId !== "string" || !UUID.test(value.principalId)) {
      return invalid("principalId");
    }
    return {
      ok: true,
      value: {
        body: { expectedVersion: value.expectedVersion as number, principalId: value.principalId },
        idempotencyKey,
        operation: "link",
        workerProfileId: value.workerProfileId,
      },
    };
  }
  return {
    ok: true,
    value: {
      body: { expectedVersion: value.expectedVersion as number, status: "active" },
      idempotencyKey,
      operation: "activate",
      workerProfileId: value.workerProfileId,
    },
  };
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function problemError(
  problem: ApiProblemDetails,
  operation: WorkforceApiExpectation["operation"],
): WorkforceProfileUiError {
  if (
    problem.status === 403 &&
    ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code)
  ) {
    return new WorkforceProfileUiError("denied", 403);
  }
  if (problem.status === 404 && problem.code === "WORKFORCE_PROFILE_NOT_FOUND") {
    return new WorkforceProfileUiError("not_found", 404);
  }
  if (problem.status === 503 && problem.code === "WORKFORCE_SERVICE_INACTIVE") {
    return new WorkforceProfileUiError("inactive", 503);
  }
  if (problem.status === 503 && problem.code === "ACTIVATION_DEPENDENCY_BLOCKED") {
    return new WorkforceProfileUiError("dependency_unavailable", 503);
  }
  if (problem.status === 422 && problem.code === "WORKFORCE_PRINCIPAL_INELIGIBLE") {
    return new WorkforceProfileUiError("validation", 422, "principalId");
  }
  if (problem.status === 400 && problem.code === "WORKFORCE_INPUT_INVALID") {
    return new WorkforceProfileUiError(
      "validation",
      400,
      operation === "create" ? "employeeNumber" : undefined,
    );
  }
  if (problem.status === 400 && problem.code === "REQUEST_VALIDATION_FAILED") {
    return new WorkforceProfileUiError("validation", 400);
  }
  if (
    problem.status === 409 &&
    ["IDEMPOTENCY_CONFLICT", "WORKFORCE_PROFILE_CONFLICT", "WORKFORCE_VERSION_CONFLICT"].includes(
      problem.code,
    )
  ) {
    return new WorkforceProfileUiError("conflict", 409);
  }
  return new WorkforceProfileUiError("operational_error", 503);
}

function profileMatches(expectation: WorkforceApiExpectation, profile: HrWorkforceProfile) {
  if (expectation.operation === "create") {
    return (
      profile.employeeNumber === expectation.employeeNumber &&
      profile.version === 1 &&
      profile.workforceStatus === "draft" &&
      !profile.principalLinked
    );
  }
  if (expectation.operation === "link") {
    return (
      profile.workerProfileId === expectation.workerProfileId &&
      profile.version === expectation.expectedVersion + 1 &&
      profile.workforceStatus === "draft" &&
      profile.principalLinked
    );
  }
  if (expectation.operation === "activate") {
    return (
      profile.workerProfileId === expectation.workerProfileId &&
      profile.version === expectation.expectedVersion + 1 &&
      profile.workforceStatus === "active" &&
      profile.principalLinked
    );
  }
  if (expectation.operation === "own") {
    return profile.workforceStatus === "active" && profile.principalLinked;
  }
  return false;
}

export async function decodeWorkforceApiResponse(
  responsePromise: Promise<Response>,
  expectation: WorkforceApiExpectation,
): Promise<HrWorkforceProfile> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkforceProfileUiError("operational_error");
  }
  const operation = expectation.operation;
  const success =
    operation === "create"
      ? (response.status === 201 && response.headers.get("idempotent-replayed") === "false") ||
        (response.status === 200 && response.headers.get("idempotent-replayed") === "true")
      : operation === "own"
        ? response.status === 200 && response.headers.get("idempotent-replayed") === null
        : response.status === 200 &&
          ["false", "true"].includes(response.headers.get("idempotent-replayed") ?? "");
  if (success) {
    if (mediaType(response) !== "application/json") {
      throw new WorkforceProfileUiError("operational_error");
    }
    try {
      const profile = parseHrWorkforceProfile(await response.json());
      if (!profileMatches(expectation, profile)) throw new TypeError("Unexpected response binding");
      return profile;
    } catch {
      throw new WorkforceProfileUiError("operational_error");
    }
  }
  if (response.status < 400 || mediaType(response) !== "application/problem+json") {
    throw new WorkforceProfileUiError("operational_error");
  }
  try {
    const problem = parseApiProblemDetails(await response.json());
    if (problem.status !== response.status) throw new TypeError("Problem status mismatch");
    throw problemError(problem, operation);
  } catch (error) {
    if (error instanceof WorkforceProfileUiError) throw error;
    throw new WorkforceProfileUiError("operational_error");
  }
}

function parseIdempotencyKeys(value: unknown): WorkforceIdempotencyKeys {
  if (!isRecord(value) || !exactKeys(value, ["activate", "create", "link"])) {
    throw new TypeError("Invalid onboarding keys");
  }
  for (const operation of ["activate", "create", "link"] as const) {
    if (typeof value[operation] !== "string" || !UUID.test(value[operation])) {
      throw new TypeError("Invalid onboarding key");
    }
  }
  return {
    activate: value.activate as string,
    create: value.create as string,
    link: value.link as string,
  };
}

function parseOnboardingProgress(value: unknown): WorkforceOnboardingProgress | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["principalLinked", "version", "workerProfileId", "workforceStatus"]) ||
    typeof value.principalLinked !== "boolean" ||
    !positiveInteger(value.version) ||
    typeof value.workerProfileId !== "string" ||
    !UUID.test(value.workerProfileId) ||
    !["active", "draft"].includes(String(value.workforceStatus)) ||
    (value.workforceStatus === "active" && !value.principalLinked)
  ) {
    throw new TypeError("Invalid onboarding progress");
  }
  return {
    principalLinked: value.principalLinked,
    version: value.version,
    workerProfileId: value.workerProfileId,
    workforceStatus: value.workforceStatus as "active" | "draft",
  };
}

export function parseWorkforceOnboardingSnapshot(value: unknown): WorkforceOnboardingSnapshot {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["idempotencyKeys", "progress", "schemaVersion"]) ||
    value.schemaVersion !== 1
  ) {
    throw new TypeError("Invalid onboarding snapshot");
  }
  return {
    idempotencyKeys: parseIdempotencyKeys(value.idempotencyKeys),
    progress: parseOnboardingProgress(value.progress),
    schemaVersion: 1,
  };
}

export function workforceOnboardingSnapshot(
  idempotencyKeys: WorkforceIdempotencyKeys,
  profile?: HrWorkforceProfile,
): WorkforceOnboardingSnapshot {
  return parseWorkforceOnboardingSnapshot({
    idempotencyKeys,
    progress: profile
      ? {
          principalLinked: profile.principalLinked,
          version: profile.version,
          workerProfileId: profile.workerProfileId,
          workforceStatus: profile.workforceStatus,
        }
      : null,
    schemaVersion: 1,
  });
}

export function ownWorkforceProfileStateForError(error: unknown): OwnWorkforceProfileState {
  const kind = error instanceof WorkforceProfileUiError ? error.kind : "operational_error";
  if (kind === "not_found") {
    return {
      message: "No active Workforce Profile is connected to your current membership.",
      status: "empty",
      title: "No active profile",
    };
  }
  const states = {
    denied: ["Profile unavailable", "You do not have permission to view this profile."],
    dependency_unavailable: [
      "Profile dependency unavailable",
      "A required workforce dependency is unavailable right now.",
    ],
    inactive: ["Workforce Profile inactive", "Workforce Profile is not available right now."],
    operational_error: ["Profile unavailable", "We could not load your workforce profile."],
  } as const;
  const state = Object.hasOwn(states, kind)
    ? states[kind as keyof typeof states]
    : states.operational_error;
  return {
    message: state[1],
    status: kind in states ? (kind as keyof typeof states) : "operational_error",
    title: state[0],
  };
}

function parseFormState(value: unknown): WorkforceFormState {
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
    throw new TypeError("Invalid form state");
  }
  const fieldErrors = value.fieldErrors;
  const fields = Object.keys(fieldErrors);
  if (fields.some((field) => !["employeeNumber", "principalId"].includes(field))) {
    throw new TypeError("Invalid form field");
  }
  const field = fields.length === 1 ? (fields[0] as WorkforceField) : undefined;
  if (fields.length > 1 || typeof value.message !== "string")
    throw new TypeError("Invalid form state");
  const expected = fixedFormState(value.kind as WorkforceFailureKind, field);
  if (
    value.message !== expected.message ||
    !exactKeys(fieldErrors, Object.keys(expected.fieldErrors)) ||
    Object.entries(expected.fieldErrors).some(([key, message]) => fieldErrors[key] !== message)
  ) {
    throw new TypeError("Unsafe form state");
  }
  return expected;
}

export async function decodeWorkforceActionTransport(
  responsePromise: Promise<Response>,
): Promise<WorkforceActionTransport> {
  try {
    const response = await responsePromise;
    if (mediaType(response) !== "application/json") throw new TypeError("Invalid media type");
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.ok !== "boolean")
      throw new TypeError("Invalid result");
    if (payload.ok) {
      if (response.status !== 200 || !exactKeys(payload, ["ok", "profile"])) {
        throw new TypeError("Invalid success");
      }
      return { ok: true, profile: parseHrWorkforceProfile(payload.profile) };
    }
    if (!ERROR_STATUSES.has(response.status) || !exactKeys(payload, ["ok", "state"])) {
      throw new TypeError("Invalid failure");
    }
    return { ok: false, state: parseFormState(payload.state) };
  } catch {
    return { ok: false, state: fixedFormState("operational_error") };
  }
}

export function statusForWorkforceError(error: unknown): number {
  return error instanceof WorkforceProfileUiError && ERROR_STATUSES.has(error.httpStatus)
    ? error.httpStatus
    : 503;
}
