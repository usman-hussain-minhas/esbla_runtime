import {
  type ApiProblemDetails,
  type HrServiceControl,
  type HrShiftAssignmentResponse,
  type HrShiftListResponse,
  type HrShiftRoster,
  parseApiProblemDetails,
  parseHrServiceControl,
  parseHrShiftAssignmentResponse,
  parseHrShiftListResponse,
  parseHrShiftRosterResponse,
} from "@esbla/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /[zZ]|[+-]\d\d:\d\d$/;

export const SHIFT_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "assign",
  "cancel",
  "configure_service",
  "create_roster",
  "deactivate_service",
  "list_roster",
  "publish",
  "view_detail",
  "view_service_control",
] as const);
export type ShiftAuthorizedAction = (typeof SHIFT_AUTHORIZED_ACTIONS)[number];
export type ShiftServiceControl = Extract<
  HrServiceControl,
  { readonly serviceKey: "shift_assignment" }
>;
export type ShiftFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export type ShiftOperation = "assign" | "cancel" | "create_roster" | "publish";
export type ShiftServiceOperation = "activate_service" | "configure_service" | "deactivate_service";
export type ShiftAction = Readonly<{
  body: Record<string, unknown>;
  id?: string;
  idempotencyKey: string;
  operation: ShiftOperation;
}>;
export type ShiftServiceAction =
  | Readonly<{
      body: Readonly<{ expectedVersion: number | null }>;
      idempotencyKey: string;
      operation: "activate_service";
    }>
  | Readonly<{
      body: Readonly<{
        expectedSettingsVersion: number;
        settings: Readonly<{ overlapAllowed: false; rosterHorizonDays: number }>;
      }>;
      idempotencyKey: string;
      operation: "configure_service";
    }>
  | Readonly<{
      body: Readonly<{ expectedVersion: number }>;
      idempotencyKey: string;
      operation: "deactivate_service";
    }>;
export type ShiftMutationResult = HrShiftAssignmentResponse | HrShiftRoster;
export interface ShiftFailureState {
  readonly kind: ShiftFailureKind;
  readonly message: string;
  readonly status: "error";
  readonly title: string;
}

export class ShiftUiError extends Error {
  constructor(
    readonly kind: ShiftFailureKind,
    readonly httpStatus = 503,
  ) {
    super("Shift Assignment request failed");
  }
}

export function shiftStateForError(error: unknown): ShiftFailureState {
  const kind = error instanceof ShiftUiError ? error.kind : "operational_error";
  const content: Record<ShiftFailureKind, readonly [string, string]> = {
    conflict: ["Shift data changed", "Reload current values before trying again."],
    denied: ["Shifts unavailable", "Your current role does not permit this Shift action."],
    dependency_unavailable: ["Shift dependency unavailable", "Workforce Profile is unavailable."],
    inactive: ["Shift Assignment inactive", "Existing shift facts are preserved while inactive."],
    not_found: ["Shift not found", "This Shift record is not available."],
    operational_error: ["Shifts unavailable", "The Shift request could not be completed."],
    validation: ["Review Shift details", "Dates, times, versions, or identifiers are invalid."],
  };
  return { kind, message: content[kind][1], status: "error", title: content[kind][0] };
}

export function parseShiftActions(response: Response): readonly ShiftAuthorizedAction[] {
  const header = response.headers.get("x-esbla-shift-actions");
  if (!header || header.length > 256) throw new ShiftUiError("operational_error");
  try {
    const parsed: unknown = JSON.parse(header);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw 0;
    const selected = new Set(parsed);
    const canonical = SHIFT_AUTHORIZED_ACTIONS.filter((action) => selected.has(action));
    if (
      selected.size !== parsed.length ||
      canonical.length !== parsed.length ||
      JSON.stringify(canonical) !== header
    ) {
      throw 0;
    }
    return Object.freeze(canonical);
  } catch (error) {
    if (error instanceof ShiftUiError) throw error;
    throw new ShiftUiError("operational_error");
  }
}

export function hasShiftAction(
  actions: readonly ShiftAuthorizedAction[],
  action: ShiftAuthorizedAction,
): boolean {
  return actions.includes(action);
}

export function isShiftServiceActionOnlyFallback(
  failureKind: ShiftFailureKind | undefined,
  hasAction: boolean,
): boolean {
  return hasAction && failureKind === "denied";
}

function problemError(problem: ApiProblemDetails): ShiftUiError {
  if (problem.status === 403 && ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code))
    return new ShiftUiError("denied", 403);
  if (
    problem.status === 404 &&
    ["SHIFT_NOT_FOUND", "SHIFT_SERVICE_CONTROL_NOT_FOUND"].includes(problem.code)
  )
    return new ShiftUiError("not_found", 404);
  if (problem.status === 503 && problem.code === "SHIFT_SERVICE_INACTIVE")
    return new ShiftUiError("inactive");
  if (
    problem.status === 503 &&
    ["ACTIVATION_DEPENDENCY_BLOCKED", "SHIFT_DEPENDENCY_INACTIVE"].includes(problem.code)
  )
    return new ShiftUiError("dependency_unavailable");
  if (
    problem.status === 400 &&
    ["REQUEST_VALIDATION_FAILED", "SHIFT_INPUT_INVALID"].includes(problem.code)
  )
    return new ShiftUiError("validation", 400);
  if (
    problem.status === 409 &&
    [
      "ACTIVATION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "SHIFT_CONFLICT",
      "SHIFT_VERSION_CONFLICT",
    ].includes(problem.code)
  )
    return new ShiftUiError("conflict", 409);
  return new ShiftUiError("operational_error");
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function json(response: Response, valid: boolean): Promise<unknown> {
  if (valid && mediaType(response) === "application/json") {
    try {
      return await response.json();
    } catch {
      throw new ShiftUiError("operational_error");
    }
  }
  if (response.status >= 400 && mediaType(response) === "application/problem+json") {
    try {
      const problem = parseApiProblemDetails(await response.json());
      if (problem.status !== response.status) throw 0;
      throw problemError(problem);
    } catch (error) {
      if (error instanceof ShiftUiError) throw error;
    }
  }
  throw new ShiftUiError("operational_error");
}

export async function decodeShiftRead(
  response: Response,
  kind: "detail" | "list",
): Promise<HrShiftAssignmentResponse | HrShiftListResponse> {
  const value = await json(response, response.status === 200);
  try {
    if (kind === "list") return parseHrShiftListResponse(value);
    return parseHrShiftAssignmentResponse(value);
  } catch {
    throw new ShiftUiError("operational_error");
  }
}

export async function decodeShiftMutation(
  response: Response,
  operation: ShiftOperation,
): Promise<ShiftMutationResult> {
  const replay = response.headers.get("idempotent-replayed");
  const created = operation === "assign" || operation === "create_roster";
  const valid = created
    ? (response.status === 201 && replay === "false") ||
      (response.status === 200 && replay === "true")
    : response.status === 200 && (replay === "false" || replay === "true");
  const value = await json(response, valid);
  try {
    if (operation === "assign" || operation === "cancel")
      return parseHrShiftAssignmentResponse(value);
    return parseHrShiftRosterResponse(value);
  } catch {
    throw new ShiftUiError("operational_error");
  }
}

export async function decodeShiftServiceControl(
  response: Response,
  mutation = false,
): Promise<ShiftServiceControl> {
  const replay = response.headers.get("idempotent-replayed");
  const valid = response.status === 200 && (!mutation || replay === "false" || replay === "true");
  const value = await json(response, valid);
  try {
    const control = parseHrServiceControl(value);
    if (control.serviceKey !== "shift_assignment") throw 0;
    return control as ShiftServiceControl;
  } catch {
    throw new ShiftUiError("operational_error");
  }
}

function exact(value: Record<string, string>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function version(value: string | undefined, nullable = false): number | null | undefined {
  if (nullable && value === "") return null;
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const result = Number(value);
  return result <= 2_147_483_647 ? result : undefined;
}
function validInstant(value: string | undefined): value is string {
  return !!value && INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

export function validateShiftAction(
  value: Record<string, string>,
): { ok: false; state: ShiftFailureState } | { ok: true; value: ShiftAction } {
  const invalid = () => ({
    ok: false as const,
    state: shiftStateForError(new ShiftUiError("validation", 400)),
  });
  const operation = value.operation as ShiftOperation;
  const key = value.idempotencyKey;
  if (!key || !UUID.test(key)) return invalid();
  const base = { idempotencyKey: key, operation };
  if (operation === "create_roster") {
    if (
      !exact(value, ["idempotencyKey", "operation", "periodEnd", "periodStart"]) ||
      !DATE.test(value.periodStart ?? "") ||
      !DATE.test(value.periodEnd ?? "")
    )
      return invalid();
    return {
      ok: true,
      value: {
        ...base,
        body: {
          periodEnd: value.periodEnd as string,
          periodStart: value.periodStart as string,
        },
      },
    };
  }
  if (operation === "assign") {
    const keys = [
      "endsAt",
      "ianaTimezone",
      "idempotencyKey",
      "operation",
      "rosterVersionId",
      "startsAt",
      "workerProfileId",
    ];
    const rosterVersionId = value.rosterVersionId;
    const workerProfileId = value.workerProfileId;
    if (
      !exact(value, keys) ||
      !rosterVersionId ||
      !UUID.test(rosterVersionId) ||
      !workerProfileId ||
      !UUID.test(workerProfileId) ||
      !validInstant(value.startsAt) ||
      !validInstant(value.endsAt) ||
      !value.ianaTimezone?.trim()
    )
      return invalid();
    return {
      ok: true,
      value: {
        ...base,
        body: {
          endsAt: value.endsAt,
          ianaTimezone: value.ianaTimezone,
          startsAt: value.startsAt,
          workerProfileId: workerProfileId.toLowerCase(),
        },
        id: rosterVersionId.toLowerCase(),
      },
    };
  }
  if (operation === "publish" || operation === "cancel") {
    const idName = operation === "publish" ? "rosterVersionId" : "shiftAssignmentId";
    const keys = ["expectedVersion", idName, "idempotencyKey", "operation"];
    const expectedVersion = version(value.expectedVersion);
    if (
      !exact(value, keys) ||
      expectedVersion === undefined ||
      expectedVersion === null ||
      !UUID.test(value[idName] ?? "")
    )
      return invalid();
    return {
      ok: true,
      value: {
        ...base,
        body: { expectedVersion },
        id: (value[idName] as string).toLowerCase(),
      },
    };
  }
  return invalid();
}

export function isShiftServiceOperation(value: unknown): value is ShiftServiceOperation {
  return ["activate_service", "configure_service", "deactivate_service"].includes(String(value));
}

export function validateShiftServiceAction(
  value: Record<string, string>,
): { ok: false; state: ShiftFailureState } | { ok: true; value: ShiftServiceAction } {
  const invalid = () => ({
    ok: false as const,
    state: shiftStateForError(new ShiftUiError("validation", 400)),
  });
  if (!UUID.test(value.idempotencyKey ?? "") || !isShiftServiceOperation(value.operation))
    return invalid();
  const idempotencyKey = value.idempotencyKey as string;
  if (value.operation === "activate_service") {
    if (!exact(value, ["expectedVersion", "idempotencyKey", "operation"])) return invalid();
    const expectedVersion = version(value.expectedVersion, true);
    return expectedVersion === undefined
      ? invalid()
      : {
          ok: true,
          value: { body: { expectedVersion }, idempotencyKey, operation: value.operation },
        };
  }
  if (value.operation === "deactivate_service") {
    if (!exact(value, ["expectedVersion", "idempotencyKey", "operation"])) return invalid();
    const expectedVersion = version(value.expectedVersion);
    return expectedVersion === undefined || expectedVersion === null
      ? invalid()
      : {
          ok: true,
          value: { body: { expectedVersion }, idempotencyKey, operation: value.operation },
        };
  }
  if (
    !exact(value, [
      "expectedSettingsVersion",
      "idempotencyKey",
      "operation",
      "overlapAllowed",
      "rosterHorizonDays",
    ]) ||
    value.overlapAllowed !== "false"
  )
    return invalid();
  const expectedSettingsVersion = version(value.expectedSettingsVersion);
  const rosterHorizonDays = version(value.rosterHorizonDays);
  return expectedSettingsVersion === undefined ||
    expectedSettingsVersion === null ||
    rosterHorizonDays === undefined ||
    rosterHorizonDays === null ||
    rosterHorizonDays > 31
    ? invalid()
    : {
        ok: true,
        value: {
          body: {
            expectedSettingsVersion,
            settings: { overlapAllowed: false, rosterHorizonDays },
          },
          idempotencyKey,
          operation: value.operation,
        },
      };
}
