import {
  type ApiProblemDetails,
  type HrAttendanceCorrection,
  type HrAttendanceCorrectionBody,
  type HrAttendanceCorrectionPage,
  type HrAttendanceListResponse,
  type HrAttendanceObservation,
  type HrAttendanceObservationResponse,
  type HrAttendanceRecordManualBody,
  type HrServiceControl,
  parseApiProblemDetails,
  parseHrAttendanceCorrection,
  parseHrAttendanceListResponse,
  parseHrAttendanceObservation,
  parseHrAttendanceObservationResponse,
  parseHrServiceControl,
} from "@esbla/contracts";
import type { HrAttendanceSettings } from "@esbla/contracts/hr-service-control-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INTEGER = 2_147_483_647;
type Search = Readonly<Record<string, string | string[] | undefined>>;

export const ATTENDANCE_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "configure_service",
  "correct",
  "deactivate_service",
  "list_own",
  "list_reports",
  "record_manual",
  "view_detail",
  "view_service_control",
] as const);
export type AttendanceAuthorizedAction = (typeof ATTENDANCE_AUTHORIZED_ACTIONS)[number];
export type AttendanceServiceControl = Extract<
  HrServiceControl,
  { readonly serviceKey: "attendance" }
>;
export type AttendanceDetail = HrAttendanceObservation & {
  readonly corrections: HrAttendanceCorrectionPage;
};
export type AttendanceFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export interface AttendanceFailureState {
  readonly kind: AttendanceFailureKind;
  readonly message: string;
  readonly status: "error";
  readonly title: string;
}
export type AttendanceOperation = "correct" | "record_manual";
export type AttendanceServiceOperation =
  | "activate_service"
  | "configure_service"
  | "deactivate_service";
export type AttendanceServiceAction =
  | Readonly<{
      body: Readonly<{ expectedVersion: number | null }>;
      idempotencyKey: string;
      operation: "activate_service";
    }>
  | Readonly<{
      body: Readonly<{
        expectedSettingsVersion: number;
        settings: HrAttendanceSettings;
      }>;
      idempotencyKey: string;
      operation: "configure_service";
    }>
  | Readonly<{
      body: Readonly<{ expectedVersion: number }>;
      idempotencyKey: string;
      operation: "deactivate_service";
    }>;
export type AttendanceAction =
  | Readonly<{
      body: HrAttendanceCorrectionBody;
      idempotencyKey: string;
      observationId: string;
      operation: "correct";
    }>
  | Readonly<{
      body: HrAttendanceRecordManualBody;
      idempotencyKey: string;
      operation: "record_manual";
    }>;
export type AttendanceMutationResult = HrAttendanceCorrection | HrAttendanceObservation;

export class AttendanceUiError extends Error {
  constructor(
    readonly kind: AttendanceFailureKind,
    readonly httpStatus = 503,
  ) {
    super("Attendance request failed");
    this.name = "AttendanceUiError";
  }
}

export function attendanceStateForError(error: unknown): AttendanceFailureState {
  const kind = error instanceof AttendanceUiError ? error.kind : "operational_error";
  const content: Record<AttendanceFailureKind, readonly [string, string]> = {
    conflict: ["Attendance changed", "Reload current values before trying again."],
    denied: ["Attendance unavailable", "Your current role does not permit this Attendance action."],
    dependency_unavailable: [
      "Attendance dependency unavailable",
      "Workforce Profile is unavailable right now.",
    ],
    inactive: ["Attendance inactive", "Existing Attendance facts are preserved while inactive."],
    not_found: ["Attendance not found", "This Attendance record is not available."],
    operational_error: ["Attendance unavailable", "The Attendance request could not be completed."],
    validation: [
      "Review Attendance details",
      "Dates, identifiers, or submitted values are invalid.",
    ],
  };
  return { kind, message: content[kind][1], status: "error", title: content[kind][0] };
}

export function parseAttendanceActions(response: Response): readonly AttendanceAuthorizedAction[] {
  const header = response.headers.get("x-esbla-attendance-actions");
  if (header === null || header.length > 256) throw new AttendanceUiError("operational_error");
  try {
    const parsed: unknown = JSON.parse(header);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw 0;
    const selected = new Set(parsed);
    const canonical = ATTENDANCE_AUTHORIZED_ACTIONS.filter((action) => selected.has(action));
    if (
      selected.size !== parsed.length ||
      canonical.length !== parsed.length ||
      JSON.stringify(canonical) !== header
    )
      throw 0;
    return Object.freeze(canonical);
  } catch (error) {
    if (error instanceof AttendanceUiError) throw error;
    throw new AttendanceUiError("operational_error");
  }
}

export function hasAttendanceAction(
  actions: readonly AttendanceAuthorizedAction[],
  action: AttendanceAuthorizedAction,
): boolean {
  return actions.includes(action);
}

export function canRenderAttendanceAction(
  actions: readonly AttendanceAuthorizedAction[],
  status: "error" | "success",
  action: AttendanceAuthorizedAction,
): boolean {
  return status === "success" && hasAttendanceAction(actions, action);
}

export function isAttendanceServiceActionOnlyFallback(
  failureKind: AttendanceFailureKind | undefined,
  hasAction: boolean,
): boolean {
  return hasAction && failureKind === "denied";
}

function problemError(problem: ApiProblemDetails): AttendanceUiError {
  if (problem.status === 403 && ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code))
    return new AttendanceUiError("denied", 403);
  if (
    problem.status === 404 &&
    [
      "ATTENDANCE_OBSERVATION_NOT_FOUND",
      "ATTENDANCE_SERVICE_CONTROL_NOT_FOUND",
      "ATTENDANCE_WORKER_UNAVAILABLE",
    ].includes(problem.code)
  )
    return new AttendanceUiError("not_found", 404);
  if (problem.status === 503 && problem.code === "ATTENDANCE_SERVICE_INACTIVE")
    return new AttendanceUiError("inactive");
  if (
    problem.status === 503 &&
    ["ACTIVATION_DEPENDENCY_BLOCKED", "ATTENDANCE_DEPENDENCY_INACTIVE"].includes(problem.code)
  )
    return new AttendanceUiError("dependency_unavailable");
  if (
    problem.status === 400 &&
    ["ATTENDANCE_INPUT_INVALID", "REQUEST_VALIDATION_FAILED"].includes(problem.code)
  )
    return new AttendanceUiError("validation", 400);
  if (
    problem.status === 409 &&
    [
      "ACTIVATION_CONFLICT",
      "ATTENDANCE_CONFLICT",
      "ATTENDANCE_VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
    ].includes(problem.code)
  )
    return new AttendanceUiError("conflict", 409);
  return new AttendanceUiError("operational_error");
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function json(response: Response, valid: boolean): Promise<unknown> {
  if (valid && mediaType(response) === "application/json") {
    try {
      return await response.json();
    } catch {
      throw new AttendanceUiError("operational_error");
    }
  }
  if (response.status >= 400 && mediaType(response) === "application/problem+json") {
    try {
      const problem = parseApiProblemDetails(await response.json());
      if (problem.status !== response.status) throw 0;
      throw problemError(problem);
    } catch (error) {
      if (error instanceof AttendanceUiError) throw error;
    }
  }
  throw new AttendanceUiError("operational_error");
}

export async function decodeAttendanceRead(
  response: Response,
  kind: "detail" | "list",
): Promise<AttendanceDetail | HrAttendanceListResponse> {
  const value = await json(response, response.status === 200);
  try {
    if (kind === "list") return parseHrAttendanceListResponse(value);
    const detail = parseHrAttendanceObservationResponse(value) as HrAttendanceObservationResponse;
    if (!("corrections" in detail)) throw 0;
    return detail as AttendanceDetail;
  } catch {
    throw new AttendanceUiError("operational_error");
  }
}

export async function decodeAttendanceMutation(
  response: Response,
  operation: AttendanceOperation,
): Promise<AttendanceMutationResult> {
  const replay = response.headers.get("idempotent-replayed");
  const valid =
    (response.status === 201 && replay === "false") ||
    (response.status === 200 && replay === "true");
  const value = await json(response, valid);
  try {
    return operation === "correct"
      ? parseHrAttendanceCorrection(value)
      : parseHrAttendanceObservation(value);
  } catch {
    throw new AttendanceUiError("operational_error");
  }
}

export async function decodeAttendanceServiceControl(
  response: Response,
): Promise<AttendanceServiceControl> {
  const value = await json(response, response.status === 200);
  try {
    const control = parseHrServiceControl(value);
    if (
      control.serviceKey !== "attendance" ||
      control.version !== control.activationVersion + control.settingsVersion - 1
    )
      throw 0;
    return control as AttendanceServiceControl;
  } catch {
    throw new AttendanceUiError("operational_error");
  }
}

export async function decodeAttendanceServiceMutation(
  response: Response,
  action: AttendanceServiceAction,
): Promise<AttendanceServiceControl> {
  const replay = response.headers.get("idempotent-replayed");
  if (response.status !== 200) return await decodeAttendanceServiceControl(response);
  if (!["false", "true"].includes(replay ?? "")) throw new AttendanceUiError("operational_error");
  const control = await decodeAttendanceServiceControl(response);
  const expectedActivationVersion =
    action.operation === "configure_service" ? null : (action.body.expectedVersion ?? 0) + 1;
  const valid =
    action.operation === "activate_service"
      ? control.activationState === "active" &&
        control.activationVersion === expectedActivationVersion &&
        (action.body.expectedVersion !== null ||
          (control.version === 1 && control.settingsVersion === 1))
      : action.operation === "deactivate_service"
        ? control.activationState === "inactive" &&
          control.activationVersion === expectedActivationVersion
        : control.activationState === "active" &&
          control.settingsVersion === action.body.expectedSettingsVersion + 1 &&
          control.settings.correctionNoteRequired === true &&
          control.settings.manualObservationKinds === action.body.settings.manualObservationKinds;
  if (!valid) throw new AttendanceUiError("operational_error");
  return control;
}

function one(search: Search, key: string): string | undefined {
  const value = search[key];
  if (Array.isArray(value)) throw new AttendanceUiError("validation", 400);
  return value;
}
function positive(value: string | undefined, maximum = MAX_INTEGER): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) && result <= maximum ? result : undefined;
}
function instant(value: string | undefined): value is string {
  return !!value && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function date(value: string | undefined): value is string {
  if (!value || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function defaultDates(now: Date): readonly [string, string] {
  if (!Number.isFinite(now.valueOf())) throw new AttendanceUiError("validation", 400);
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

export function buildAttendanceListQuery(search: Search, now = new Date()): URLSearchParams {
  const defaults = defaultDates(now);
  const from = one(search, "from") ?? defaults[0];
  const to = one(search, "to") ?? defaults[1];
  if (!date(from) || !date(to) || from > to) throw new AttendanceUiError("validation", 400);
  const end = new Date(`${to}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const query = new URLSearchParams({
    rangeStart: `${from}T00:00:00.000Z`,
    rangeEnd: end.toISOString(),
  });
  const sizeValue = one(search, "pageSize");
  if (sizeValue !== undefined) {
    const size = positive(sizeValue, 50);
    if (!size) throw new AttendanceUiError("validation", 400);
    query.set("pageSize", String(size));
  }
  const id = one(search, "cursorAttendanceObservationId");
  const observedAt = one(search, "cursorObservedAt");
  if (
    (id === undefined) !== (observedAt === undefined) ||
    (id && !UUID.test(id)) ||
    (observedAt && !instant(observedAt))
  )
    throw new AttendanceUiError("validation", 400);
  if (id && observedAt) {
    query.set("cursorAttendanceObservationId", id.toLowerCase());
    query.set("cursorObservedAt", observedAt);
  }
  return query;
}

export function buildAttendanceDetailQuery(search: Search): URLSearchParams {
  const query = new URLSearchParams();
  const sizeValue = one(search, "pageSize");
  if (sizeValue !== undefined) {
    const size = positive(sizeValue, 50);
    if (!size) throw new AttendanceUiError("validation", 400);
    query.set("pageSize", String(size));
  }
  const id = one(search, "cursorAttendanceCorrectionId");
  const versionValue = one(search, "cursorCorrectionVersion");
  const version = versionValue === undefined ? undefined : positive(versionValue);
  if (
    (id === undefined) !== (versionValue === undefined) ||
    (id && !UUID.test(id)) ||
    (versionValue && !version)
  )
    throw new AttendanceUiError("validation", 400);
  if (id && version) {
    query.set("cursorAttendanceCorrectionId", id.toLowerCase());
    query.set("cursorCorrectionVersion", String(version));
  }
  return query;
}

function exact(value: Record<string, string>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function invalidAction() {
  return {
    ok: false as const,
    state: attendanceStateForError(new AttendanceUiError("validation", 400)),
  };
}

export function isAttendanceServiceOperation(value: unknown): value is AttendanceServiceOperation {
  return ["activate_service", "configure_service", "deactivate_service"].includes(String(value));
}

export function validateAttendanceServiceAction(
  value: Record<string, string>,
): { ok: false; state: AttendanceFailureState } | { ok: true; value: AttendanceServiceAction } {
  const suppliedIdempotencyKey = value.idempotencyKey;
  if (!UUID.test(suppliedIdempotencyKey ?? "") || !isAttendanceServiceOperation(value.operation))
    return invalidAction();
  const idempotencyKey = (suppliedIdempotencyKey as string).toLowerCase();
  if (value.operation === "activate_service") {
    if (!exact(value, ["expectedVersion", "idempotencyKey", "operation"])) return invalidAction();
    const expectedVersion = value.expectedVersion === "" ? null : positive(value.expectedVersion);
    return expectedVersion === undefined
      ? invalidAction()
      : {
          ok: true,
          value: { body: { expectedVersion }, idempotencyKey, operation: value.operation },
        };
  }
  if (value.operation === "deactivate_service") {
    if (!exact(value, ["expectedVersion", "idempotencyKey", "operation"])) return invalidAction();
    const expectedVersion = positive(value.expectedVersion);
    return expectedVersion === undefined
      ? invalidAction()
      : {
          ok: true,
          value: { body: { expectedVersion }, idempotencyKey, operation: value.operation },
        };
  }
  if (
    !exact(value, [
      "correctionNoteRequired",
      "expectedSettingsVersion",
      "idempotencyKey",
      "manualObservationKinds",
      "operation",
    ]) ||
    value.correctionNoteRequired !== "true"
  )
    return invalidAction();
  const expectedSettingsVersion = positive(value.expectedSettingsVersion);
  const suppliedKinds = value.manualObservationKinds as string;
  const selected = suppliedKinds === "" ? [] : suppliedKinds.split(",");
  if (
    !expectedSettingsVersion ||
    selected.some((kind) => !["presence_start", "presence_end"].includes(kind)) ||
    new Set(selected).size !== selected.length
  )
    return invalidAction();
  const manualObservationKinds = (["presence_start", "presence_end"] as const)
    .filter((kind) => selected.includes(kind))
    .join(",") as HrAttendanceSettings["manualObservationKinds"];
  return {
    ok: true,
    value: {
      body: {
        expectedSettingsVersion,
        settings: { correctionNoteRequired: true, manualObservationKinds },
      },
      idempotencyKey,
      operation: value.operation,
    },
  };
}

export function validateAttendanceAction(
  value: Record<string, string>,
): { ok: false; state: AttendanceFailureState } | { ok: true; value: AttendanceAction } {
  const idempotencyKey = value.idempotencyKey;
  if (!idempotencyKey || !UUID.test(idempotencyKey)) return invalidAction();
  if (value.operation === "record_manual") {
    const keys = [
      "idempotencyKey",
      "observationKind",
      "observedAt",
      "operation",
      "workerProfileId",
    ];
    if (
      !exact(value, keys) ||
      !UUID.test(value.workerProfileId ?? "") ||
      !instant(value.observedAt) ||
      !["presence_start", "presence_end"].includes(value.observationKind ?? "")
    )
      return invalidAction();
    return {
      ok: true,
      value: {
        body: {
          observationKind: value.observationKind as HrAttendanceRecordManualBody["observationKind"],
          observedAt: value.observedAt as string,
          workerProfileId: (value.workerProfileId as string).toLowerCase(),
        },
        idempotencyKey: idempotencyKey.toLowerCase(),
        operation: "record_manual",
      },
    };
  }
  const keys = [
    "correctedObservationKind",
    "correctedObservedAt",
    "expectedCurrentCorrectionId",
    "expectedCurrentCorrectionVersion",
    "idempotencyKey",
    "observationId",
    "operation",
    "reason",
  ];
  const predecessorId = value.expectedCurrentCorrectionId;
  const predecessorVersion = value.expectedCurrentCorrectionVersion;
  const version = predecessorVersion === "" ? null : positive(predecessorVersion);
  if (
    value.operation !== "correct" ||
    !exact(value, keys) ||
    !UUID.test(value.observationId ?? "") ||
    !instant(value.correctedObservedAt) ||
    !["presence_start", "presence_end"].includes(value.correctedObservationKind ?? "") ||
    !value.reason ||
    value.reason !== value.reason.trim() ||
    value.reason.length > 2000 ||
    (predecessorId === "") !== (predecessorVersion === "") ||
    (predecessorId !== "" && (!UUID.test(predecessorId ?? "") || !version))
  )
    return invalidAction();
  return {
    ok: true,
    value: {
      body: {
        correctedObservationKind:
          value.correctedObservationKind as HrAttendanceCorrectionBody["correctedObservationKind"],
        correctedObservedAt: value.correctedObservedAt as string,
        expectedCurrentCorrectionId: predecessorId ? predecessorId.toLowerCase() : null,
        expectedCurrentCorrectionVersion: predecessorId ? (version as number) : null,
        reason: value.reason,
      },
      idempotencyKey: idempotencyKey.toLowerCase(),
      observationId: (value.observationId as string).toLowerCase(),
      operation: "correct",
    },
  };
}
