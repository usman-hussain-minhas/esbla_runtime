import { type ApiProblemDetails, parseApiProblemDetails } from "@esbla/contracts";
import type {
  HrTimesheetCreateBody,
  HrTimesheetEditDraftBody,
  HrTimesheetListResponse,
  HrTimesheetResponse,
  HrTimesheetSubmitBody,
} from "@esbla/contracts/hr-timesheet-api";
import {
  parseHrTimesheetListResponse,
  parseHrTimesheetResponse,
} from "@esbla/contracts/hr-timesheet-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_FIELD = /^(entryDate|entryDescription|entryId|entryMinutes|entryVersion)_(0|[1-9]\d?)$/;
const MAX_INTEGER = 2_147_483_647;
type Search = Readonly<Record<string, string | readonly string[] | undefined>>;

export const TIMESHEET_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "approve",
  "configure_service",
  "create",
  "create_correction",
  "deactivate_service",
  "edit_draft",
  "list_assigned",
  "list_own",
  "reject",
  "submit",
  "view_detail",
  "view_service_control",
] as const);
export type TimesheetAuthorizedAction = (typeof TIMESHEET_AUTHORIZED_ACTIONS)[number];
export type TimesheetFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export interface TimesheetFailureState {
  readonly kind: TimesheetFailureKind;
  readonly message: string;
  readonly status: "error";
  readonly title: string;
}
export type TimesheetAction =
  | Readonly<{
      body: HrTimesheetCreateBody;
      idempotencyKey: string;
      operation: "create";
    }>
  | Readonly<{
      body: HrTimesheetEditDraftBody;
      idempotencyKey: string;
      operation: "edit_draft";
      timesheetId: string;
    }>
  | Readonly<{
      body: HrTimesheetSubmitBody;
      idempotencyKey: string;
      operation: "submit";
      timesheetId: string;
    }>;
export type TimesheetActionValidation =
  | Readonly<{ ok: true; value: TimesheetAction }>
  | Readonly<{ ok: false; state: TimesheetFailureState }>;

export class TimesheetUiError extends Error {
  constructor(
    readonly kind: TimesheetFailureKind,
    readonly httpStatus = 503,
  ) {
    super("Timesheet request failed");
    this.name = "TimesheetUiError";
  }
}

export function timesheetStateForError(error: unknown): TimesheetFailureState {
  const kind = error instanceof TimesheetUiError ? error.kind : "operational_error";
  const copy: Record<TimesheetFailureKind, readonly [string, string]> = {
    conflict: ["Timesheet changed", "Reload current values before trying again."],
    denied: ["Timesheet unavailable", "Your current role does not permit this Timesheet action."],
    dependency_unavailable: [
      "Timesheet dependency unavailable",
      "Workforce Profile or assigned work is unavailable right now.",
    ],
    inactive: ["Timesheet inactive", "Existing Timesheet history is preserved while inactive."],
    not_found: ["Timesheet not found", "This Timesheet is not available."],
    operational_error: ["Timesheet unavailable", "The Timesheet request could not be completed."],
    validation: ["Review Timesheet details", "Dates, entries, or submitted values are invalid."],
  };
  return { kind, message: copy[kind][1], status: "error", title: copy[kind][0] };
}

export function hasTimesheetAction(
  actions: readonly TimesheetAuthorizedAction[],
  action: TimesheetAuthorizedAction,
): boolean {
  return actions.includes(action);
}

export function parseTimesheetActions(response: Response): readonly TimesheetAuthorizedAction[] {
  const header = response.headers.get("x-esbla-timesheet-actions");
  if (header === null || header.length > 384) throw new TimesheetUiError("operational_error");
  try {
    const parsed: unknown = JSON.parse(header);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw 0;
    const selected = new Set(parsed);
    const canonical = TIMESHEET_AUTHORIZED_ACTIONS.filter((action) => selected.has(action));
    if (
      selected.size !== parsed.length ||
      canonical.length !== parsed.length ||
      JSON.stringify(canonical) !== header
    )
      throw 0;
    return Object.freeze(canonical);
  } catch (error) {
    if (error instanceof TimesheetUiError) throw error;
    throw new TimesheetUiError("operational_error");
  }
}

function problemError(problem: ApiProblemDetails): TimesheetUiError {
  if (problem.status === 403 && ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code))
    return new TimesheetUiError("denied", 403);
  if (
    problem.status === 404 &&
    ["TIMESHEET_NOT_FOUND", "TIMESHEET_SERVICE_CONTROL_NOT_FOUND"].includes(problem.code)
  )
    return new TimesheetUiError("not_found", 404);
  if (problem.status === 503 && problem.code === "TIMESHEET_SERVICE_INACTIVE")
    return new TimesheetUiError("inactive");
  if (
    problem.status === 503 &&
    ["ACTIVATION_DEPENDENCY_BLOCKED", "TIMESHEET_DEPENDENCY_INACTIVE"].includes(problem.code)
  )
    return new TimesheetUiError("dependency_unavailable");
  if (
    problem.status === 400 &&
    ["REQUEST_VALIDATION_FAILED", "TIMESHEET_INPUT_INVALID"].includes(problem.code)
  )
    return new TimesheetUiError("validation", 400);
  if (
    problem.status === 409 &&
    [
      "ACTIVATION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "TIMESHEET_CONFLICT",
      "TIMESHEET_VERSION_CONFLICT",
    ].includes(problem.code)
  )
    return new TimesheetUiError("conflict", 409);
  return new TimesheetUiError("operational_error");
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

async function body(response: Response, valid: boolean): Promise<unknown> {
  if (valid && mediaType(response) === "application/json") {
    try {
      return await response.json();
    } catch {
      throw new TimesheetUiError("operational_error");
    }
  }
  if (response.status >= 400 && mediaType(response) === "application/problem+json") {
    try {
      const problem = parseApiProblemDetails(await response.json());
      if (problem.status !== response.status) throw 0;
      throw problemError(problem);
    } catch (error) {
      if (error instanceof TimesheetUiError) throw error;
    }
  }
  throw new TimesheetUiError("operational_error");
}

export async function decodeTimesheetList(
  response: Response,
  expectedKind: "assigned" | "own",
): Promise<HrTimesheetListResponse> {
  const value = await body(response, response.status === 200);
  try {
    const page = parseHrTimesheetListResponse(value);
    if (page.kind !== expectedKind) throw 0;
    return page;
  } catch {
    throw new TimesheetUiError("operational_error");
  }
}

export async function decodeTimesheetDetail(response: Response): Promise<HrTimesheetResponse> {
  const value = await body(response, response.status === 200);
  try {
    const detail = parseHrTimesheetResponse(value);
    if (!detail.accessScope) throw 0;
    return detail;
  } catch {
    throw new TimesheetUiError("operational_error");
  }
}

export async function decodeTimesheetMutation(
  response: Response,
  operation: TimesheetAction["operation"],
): Promise<HrTimesheetResponse> {
  const replay = response.headers.get("idempotent-replayed");
  const valid =
    operation === "create"
      ? (response.status === 201 && replay === "false") ||
        (response.status === 200 && replay === "true")
      : response.status === 200 && (replay === "false" || replay === "true");
  const value = await body(response, valid);
  try {
    const result = parseHrTimesheetResponse(value);
    if (result.accessScope !== undefined) throw 0;
    return result;
  } catch {
    throw new TimesheetUiError("operational_error");
  }
}

function scalar(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !DATE.test(value)) throw 0;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw 0;
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw 0;
  return value.toLowerCase();
}
function positive(value: unknown, maximum = MAX_INTEGER): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw 0;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected > maximum) throw 0;
  return selected;
}
function exact(value: Readonly<Record<string, string>>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw 0;
}
function expected(value: Readonly<Record<string, string>>) {
  return {
    expectedRootVersion: positive(value.expectedRootVersion),
    expectedTimesheetVersionId: uuid(value.expectedTimesheetVersionId),
    expectedVersion: positive(value.expectedVersion),
  };
}
function failure(): TimesheetActionValidation {
  return { ok: false, state: timesheetStateForError(new TimesheetUiError("validation", 400)) };
}

export function validateTimesheetAction(
  value: Readonly<Record<string, string>>,
): TimesheetActionValidation {
  try {
    const operation = value.operation;
    const idempotencyKey = uuid(value.idempotencyKey);
    if (operation === "create") {
      exact(value, new Set(["idempotencyKey", "operation", "periodEnd", "periodStart"]));
      const periodStart = date(value.periodStart);
      const periodEnd = date(value.periodEnd);
      if (
        Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`) !==
        6 * 86_400_000
      )
        throw 0;
      return { ok: true, value: { body: { periodEnd, periodStart }, idempotencyKey, operation } };
    }
    if (operation !== "edit_draft" && operation !== "submit") {
      return failure();
    }
    const timesheetId = uuid(value.timesheetId);
    const common = new Set([
      "expectedRootVersion",
      "expectedTimesheetVersionId",
      "expectedVersion",
      "idempotencyKey",
      "operation",
      "timesheetId",
    ]);
    const expectedBody = expected(value);
    if (operation === "edit_draft") {
      const indexes = new Set<number>();
      for (const key of Object.keys(value)) {
        if (common.has(key)) continue;
        const match = ENTRY_FIELD.exec(key);
        if (!match || Number(match[2]) > 49) throw 0;
        indexes.add(Number(match[2]));
      }
      exact(
        value,
        new Set([...common, ...Object.keys(value).filter((key) => ENTRY_FIELD.test(key))]),
      );
      const entries = [...indexes]
        .sort((left, right) => left - right)
        .flatMap((index) => {
          const entryDate = scalar(value[`entryDate_${index}`])?.trim() ?? "";
          const entryMinutes = scalar(value[`entryMinutes_${index}`])?.trim() ?? "";
          const description = scalar(value[`entryDescription_${index}`])?.trim() ?? "";
          if (!entryDate && !entryMinutes && !description) return [];
          if (description.length > 500) throw 0;
          const entryId = scalar(value[`entryId_${index}`])?.trim() ?? "";
          const entryVersion = scalar(value[`entryVersion_${index}`])?.trim() ?? "";
          if (!entryId !== !entryVersion) throw 0;
          return [
            {
              ...(description ? { description } : { description: null }),
              entryDate: date(entryDate),
              ...(entryId
                ? {
                    expectedVersion: positive(entryVersion),
                    timesheetEntryId: uuid(entryId),
                  }
                : {}),
              minutes: positive(entryMinutes, 1440),
            },
          ];
        });
      return {
        ok: true,
        value: {
          body: { ...expectedBody, entries },
          idempotencyKey,
          operation,
          timesheetId,
        },
      };
    }
    exact(value, common);
    return {
      ok: true,
      value: { body: expectedBody, idempotencyKey, operation, timesheetId },
    };
  } catch {
    return failure();
  }
}

export function buildOwnTimesheetPath(search: Search): string {
  try {
    const query = new URLSearchParams();
    const periodStartPresent = Object.hasOwn(search, "cursorPeriodStart");
    const timesheetIdPresent = Object.hasOwn(search, "cursorTimesheetId");
    if (periodStartPresent !== timesheetIdPresent) throw 0;
    if (periodStartPresent) {
      query.set("cursorPeriodStart", date(search.cursorPeriodStart));
      query.set("cursorTimesheetId", uuid(search.cursorTimesheetId));
    }
    return `/v1/hr/timesheets/own${query.size ? `?${query}` : ""}`;
  } catch {
    throw new TimesheetUiError("validation", 400);
  }
}

export function buildTimesheetDetailPath(timesheetId: string, search: Search): string {
  try {
    const query = new URLSearchParams();
    const versionIdPresent = Object.hasOwn(search, "cursorTimesheetVersionId");
    const versionPresent = Object.hasOwn(search, "cursorVersion");
    if (versionIdPresent !== versionPresent) throw 0;
    if (versionIdPresent) {
      query.set("cursorTimesheetVersionId", uuid(search.cursorTimesheetVersionId));
      query.set("cursorVersion", String(positive(search.cursorVersion)));
    }
    return `/v1/hr/timesheets/by-id/${uuid(timesheetId)}${query.size ? `?${query}` : ""}`;
  } catch {
    throw new TimesheetUiError("validation", 400);
  }
}
