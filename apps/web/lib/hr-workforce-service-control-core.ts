import { type ApiProblemDetails, parseApiProblemDetails } from "@esbla/contracts";
import {
  type HrServiceControl,
  type HrWorkforceProfileSettings,
  parseHrServiceControl,
} from "@esbla/contracts/hr-service-control-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type WorkforceServiceControlOperation = "activate" | "configure" | "deactivate";
export type WorkforceServiceControlFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export type WorkforceServiceControlField = "managerVisibility" | "settings";

export type WorkforceServiceControlAction =
  | {
      readonly body: Readonly<{ expectedVersion: number | null }>;
      readonly idempotencyKey: string;
      readonly operation: "activate";
    }
  | {
      readonly body: Readonly<{
        expectedSettingsVersion: number;
        settings: HrWorkforceProfileSettings;
      }>;
      readonly idempotencyKey: string;
      readonly operation: "configure";
    }
  | {
      readonly body: Readonly<{ expectedVersion: number }>;
      readonly idempotencyKey: string;
      readonly operation: "deactivate";
    };

export interface WorkforceServiceControlFormState {
  readonly fieldErrors: Readonly<Partial<Record<WorkforceServiceControlField, string>>>;
  readonly kind: WorkforceServiceControlFailureKind;
  readonly message: string;
  readonly status: "error";
}

export type WorkforceServiceControlValidation =
  | { readonly ok: false; readonly state: WorkforceServiceControlFormState }
  | { readonly ok: true; readonly value: WorkforceServiceControlAction };

export type WorkforceServiceControlTransport =
  | { readonly control: HrServiceControl; readonly ok: true }
  | { readonly ok: false; readonly state: WorkforceServiceControlFormState };

export type WorkforceServiceControlApiExpectation =
  | { readonly operation: "view" }
  | {
      readonly action: WorkforceServiceControlAction;
      readonly before: HrServiceControl | null;
      readonly operation: "mutate";
    };

export class WorkforceServiceControlUiError extends Error {
  constructor(
    readonly kind: WorkforceServiceControlFailureKind,
    readonly httpStatus = 503,
    readonly field?: WorkforceServiceControlField,
  ) {
    super("Workforce Profile service-control request failed");
    this.name = "WorkforceServiceControlUiError";
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

function boundedVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= MAX_POSTGRES_INTEGER
  );
}

function fixedState(
  kind: WorkforceServiceControlFailureKind,
  field?: WorkforceServiceControlField,
): WorkforceServiceControlFormState {
  const messages: Record<WorkforceServiceControlFailureKind, string> = {
    conflict: "This service control changed. Reload the current state before trying again.",
    denied: "You do not have permission to manage Workforce Profile service controls.",
    dependency_unavailable:
      "A required Workforce Profile activation dependency is unavailable right now.",
    inactive: "Activate Workforce Profile before changing its settings.",
    not_found: "Workforce Profile is ready for its first governed activation.",
    operational_error: "We could not load or update Workforce Profile service controls. Try again.",
    validation: "Review the Workforce Profile settings and try again.",
  };
  const fieldErrors =
    field === "managerVisibility"
      ? { managerVisibility: "Choose minimized manager visibility or no manager visibility." }
      : field === "settings"
        ? { settings: "The submitted Workforce Profile settings are invalid." }
        : {};
  return { fieldErrors, kind, message: messages[kind], status: "error" };
}

export function workforceServiceControlStateForError(
  error: unknown,
): WorkforceServiceControlFormState {
  return error instanceof WorkforceServiceControlUiError
    ? fixedState(error.kind, error.field)
    : fixedState("operational_error");
}

function invalid(field?: WorkforceServiceControlField): WorkforceServiceControlValidation {
  return { ok: false, state: fixedState("validation", field) };
}

export function validateWorkforceServiceControlAction(
  value: unknown,
): WorkforceServiceControlValidation {
  if (
    !isRecord(value) ||
    !["activate", "configure", "deactivate"].includes(String(value.operation))
  ) {
    return invalid();
  }
  if (typeof value.idempotencyKey !== "string" || !UUID.test(value.idempotencyKey)) {
    return invalid();
  }
  if (value.operation === "activate") {
    if (!exactKeys(value, ["expectedVersion", "idempotencyKey", "operation"])) return invalid();
    if (value.expectedVersion !== null && !boundedVersion(value.expectedVersion)) return invalid();
    return {
      ok: true,
      value: {
        body: { expectedVersion: value.expectedVersion as number | null },
        idempotencyKey: value.idempotencyKey,
        operation: "activate",
      },
    };
  }
  if (value.operation === "deactivate") {
    if (
      !exactKeys(value, ["expectedVersion", "idempotencyKey", "operation"]) ||
      !boundedVersion(value.expectedVersion)
    ) {
      return invalid();
    }
    return {
      ok: true,
      value: {
        body: { expectedVersion: value.expectedVersion },
        idempotencyKey: value.idempotencyKey,
        operation: "deactivate",
      },
    };
  }
  if (
    !exactKeys(value, [
      "employeeNumberRequired",
      "expectedSettingsVersion",
      "idempotencyKey",
      "managerVisibility",
      "operation",
      "unlinkedWorkerCreationAllowed",
    ]) ||
    !boundedVersion(value.expectedSettingsVersion) ||
    typeof value.employeeNumberRequired !== "boolean" ||
    typeof value.unlinkedWorkerCreationAllowed !== "boolean"
  ) {
    return invalid("settings");
  }
  if (value.managerVisibility !== "minimized" && value.managerVisibility !== "none") {
    return invalid("managerVisibility");
  }
  return {
    ok: true,
    value: {
      body: {
        expectedSettingsVersion: value.expectedSettingsVersion,
        settings: {
          employeeNumberRequired: value.employeeNumberRequired,
          managerVisibility: value.managerVisibility,
          unlinkedWorkerCreationAllowed: value.unlinkedWorkerCreationAllowed,
        },
      },
      idempotencyKey: value.idempotencyKey,
      operation: "configure",
    },
  };
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function problemError(
  problem: ApiProblemDetails,
  operation: WorkforceServiceControlApiExpectation["operation"],
): WorkforceServiceControlUiError {
  if (
    problem.status === 403 &&
    (problem.code === "ACTOR_NOT_ACTIVE_MEMBER" || problem.code === "POLICY_DENIED")
  ) {
    return new WorkforceServiceControlUiError("denied", 403);
  }
  if (problem.status === 404 && problem.code === "WORKFORCE_SERVICE_CONTROL_NOT_FOUND") {
    return new WorkforceServiceControlUiError("not_found", 404);
  }
  if (problem.status === 503 && problem.code === "ACTIVATION_DEPENDENCY_BLOCKED") {
    return new WorkforceServiceControlUiError("dependency_unavailable", 503);
  }
  if (problem.status === 503 && problem.code === "WORKFORCE_SERVICE_INACTIVE") {
    return new WorkforceServiceControlUiError("inactive", 503);
  }
  if (
    problem.status === 409 &&
    (problem.code === "ACTIVATION_CONFLICT" || problem.code === "IDEMPOTENCY_CONFLICT")
  ) {
    return new WorkforceServiceControlUiError("conflict", 409);
  }
  if (
    operation === "mutate" &&
    problem.status === 400 &&
    (problem.code === "REQUEST_VALIDATION_FAILED" || problem.code === "WORKFORCE_INPUT_INVALID")
  ) {
    return new WorkforceServiceControlUiError("validation", 400, "settings");
  }
  return new WorkforceServiceControlUiError("operational_error");
}

function sameSettings(left: HrServiceControl, right: HrServiceControl): boolean {
  if (left.serviceKey !== "workforce_profile" || right.serviceKey !== "workforce_profile") {
    return false;
  }
  return (
    left.settings.employeeNumberRequired === right.settings.employeeNumberRequired &&
    left.settings.managerVisibility === right.settings.managerVisibility &&
    left.settings.unlinkedWorkerCreationAllowed === right.settings.unlinkedWorkerCreationAllowed
  );
}

function sameControl(left: HrServiceControl, right: HrServiceControl): boolean {
  return (
    left.serviceKey === right.serviceKey &&
    left.activationState === right.activationState &&
    left.activationVersion === right.activationVersion &&
    left.settingsVersion === right.settingsVersion &&
    left.updatedAt === right.updatedAt &&
    left.version === right.version &&
    sameSettings(left, right)
  );
}

function alreadyAppliedReplayMatches(
  control: HrServiceControl,
  expectation: Extract<WorkforceServiceControlApiExpectation, { operation: "mutate" }>,
): boolean {
  const { action, before } = expectation;
  if (
    control.serviceKey !== "workforce_profile" ||
    before?.serviceKey !== "workforce_profile" ||
    !sameControl(control, before)
  ) {
    return false;
  }
  if (action.operation === "configure") {
    return (
      control.activationState === "active" &&
      control.settingsVersion === action.body.expectedSettingsVersion + 1 &&
      control.settings.employeeNumberRequired === action.body.settings.employeeNumberRequired &&
      control.settings.managerVisibility === action.body.settings.managerVisibility &&
      control.settings.unlinkedWorkerCreationAllowed ===
        action.body.settings.unlinkedWorkerCreationAllowed
    );
  }
  if (action.operation === "activate" && action.body.expectedVersion === null) {
    return (
      control.activationState === "active" &&
      control.activationVersion === 1 &&
      control.settingsVersion === 1 &&
      control.version === 1 &&
      control.settings.employeeNumberRequired === false &&
      control.settings.managerVisibility === "minimized" &&
      control.settings.unlinkedWorkerCreationAllowed === true
    );
  }
  const target = action.operation === "activate" ? "active" : "inactive";
  return (
    action.body.expectedVersion !== null &&
    control.activationState === target &&
    control.activationVersion === action.body.expectedVersion + 1
  );
}

function mutationMatches(
  control: HrServiceControl,
  expectation: Extract<WorkforceServiceControlApiExpectation, { operation: "mutate" }>,
): boolean {
  if (control.serviceKey !== "workforce_profile") return false;
  const { action, before } = expectation;
  if (action.operation === "activate" && before === null) {
    return (
      action.body.expectedVersion === null &&
      control.activationState === "active" &&
      control.activationVersion === 1 &&
      control.settingsVersion === 1 &&
      control.version === 1 &&
      control.settings.employeeNumberRequired === false &&
      control.settings.managerVisibility === "minimized" &&
      control.settings.unlinkedWorkerCreationAllowed === true
    );
  }
  if (before?.serviceKey !== "workforce_profile") return false;
  if (control.version !== before.version + 1) return false;
  if (action.operation === "configure") {
    return (
      before.activationState === "active" &&
      action.body.expectedSettingsVersion === before.settingsVersion &&
      control.activationState === before.activationState &&
      control.activationVersion === before.activationVersion &&
      control.settingsVersion === before.settingsVersion + 1 &&
      control.settings.employeeNumberRequired === action.body.settings.employeeNumberRequired &&
      control.settings.managerVisibility === action.body.settings.managerVisibility &&
      control.settings.unlinkedWorkerCreationAllowed ===
        action.body.settings.unlinkedWorkerCreationAllowed
    );
  }
  const target = action.operation === "activate" ? "active" : "inactive";
  return (
    action.body.expectedVersion === before.activationVersion &&
    control.activationState === target &&
    control.activationVersion === before.activationVersion + 1 &&
    control.settingsVersion === before.settingsVersion &&
    sameSettings(control, before)
  );
}

function parseExpectedControl(
  value: unknown,
  expectation: Extract<WorkforceServiceControlApiExpectation, { operation: "mutate" }>,
  replayed = false,
): HrServiceControl {
  const control = parseHrServiceControl(value);
  if (
    !mutationMatches(control, expectation) &&
    !(replayed && alreadyAppliedReplayMatches(control, expectation))
  ) {
    throw new TypeError("Unexpected Workforce Profile service-control response binding");
  }
  return control;
}

export async function decodeWorkforceServiceControlApiResponse(
  responsePromise: Promise<Response>,
  expectation: WorkforceServiceControlApiExpectation,
): Promise<HrServiceControl> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkforceServiceControlUiError("operational_error");
  }
  const replay = response.headers.get("idempotent-replayed");
  const success =
    response.status === 200 &&
    (expectation.operation === "view" ? replay === null : replay === "false" || replay === "true");
  if (success) {
    if (mediaType(response) !== "application/json") {
      throw new WorkforceServiceControlUiError("operational_error");
    }
    try {
      const payload: unknown = await response.json();
      const parsed =
        expectation.operation === "view"
          ? parseHrServiceControl(payload)
          : parseExpectedControl(payload, expectation, replay === "true");
      if (parsed.serviceKey !== "workforce_profile") throw new TypeError("Wrong service control");
      return parsed;
    } catch {
      throw new WorkforceServiceControlUiError("operational_error");
    }
  }
  if (
    response.status < 400 ||
    replay !== null ||
    mediaType(response) !== "application/problem+json"
  ) {
    throw new WorkforceServiceControlUiError("operational_error");
  }
  try {
    const problem = parseApiProblemDetails(await response.json());
    if (problem.status !== response.status) throw new TypeError("Problem status mismatch");
    throw problemError(problem, expectation.operation);
  } catch (error) {
    if (error instanceof WorkforceServiceControlUiError) throw error;
    throw new WorkforceServiceControlUiError("operational_error");
  }
}

function parseFormState(value: unknown): WorkforceServiceControlFormState {
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
    throw new TypeError("Invalid service-control state");
  }
  const fieldErrors = value.fieldErrors;
  const fields = Object.keys(fieldErrors);
  if (
    fields.length > 1 ||
    fields.some((field) => !["managerVisibility", "settings"].includes(field)) ||
    typeof value.message !== "string"
  ) {
    throw new TypeError("Invalid service-control field state");
  }
  const field = fields[0] as WorkforceServiceControlField | undefined;
  const expected = fixedState(value.kind as WorkforceServiceControlFailureKind, field);
  if (
    value.message !== expected.message ||
    !exactKeys(fieldErrors, Object.keys(expected.fieldErrors)) ||
    Object.entries(expected.fieldErrors).some(([key, message]) => fieldErrors[key] !== message)
  ) {
    throw new TypeError("Unsafe service-control state");
  }
  return expected;
}

function failureStatusMatches(status: number, state: WorkforceServiceControlFormState): boolean {
  if (state.kind === "validation") return status === 400 || status === 415;
  if (state.kind === "denied") return status === 403;
  if (state.kind === "not_found") return status === 404;
  if (state.kind === "conflict") return status === 409;
  return status === 503;
}

export async function decodeWorkforceServiceControlTransport(
  responsePromise: Promise<Response>,
  before: HrServiceControl | null,
  action: WorkforceServiceControlAction,
): Promise<WorkforceServiceControlTransport> {
  try {
    const response = await responsePromise;
    if (
      response.headers.get("idempotent-replayed") !== null ||
      mediaType(response) !== "application/json"
    ) {
      throw new TypeError("Invalid service-control transport");
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.ok !== "boolean") {
      throw new TypeError("Invalid service-control envelope");
    }
    if (payload.ok) {
      if (response.status !== 200 || !exactKeys(payload, ["control", "ok"])) {
        throw new TypeError("Invalid service-control success envelope");
      }
      return {
        control: parseExpectedControl(payload.control, { action, before, operation: "mutate" }),
        ok: true,
      };
    }
    if (!exactKeys(payload, ["ok", "state"])) throw new TypeError("Invalid failure envelope");
    const state = parseFormState(payload.state);
    if (!failureStatusMatches(response.status, state)) throw new TypeError("Status mismatch");
    return { ok: false, state };
  } catch {
    return { ok: false, state: fixedState("operational_error") };
  }
}
