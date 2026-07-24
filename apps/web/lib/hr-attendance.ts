import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HrAttendanceListResponse } from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import { readDevelopmentSessionConfig } from "./development-session-core";
import {
  type AttendanceAction,
  type AttendanceAuthorizedAction,
  type AttendanceDetail,
  type AttendanceFailureState,
  type AttendanceMutationResult,
  type AttendanceServiceAction,
  type AttendanceServiceControl,
  type AttendanceServiceOperation,
  AttendanceUiError,
  attendanceStateForError,
  buildAttendanceDetailQuery,
  buildAttendanceListQuery,
  decodeAttendanceMutation,
  decodeAttendanceRead,
  decodeAttendanceServiceControl,
  decodeAttendanceServiceMutation,
  hasAttendanceAction,
  parseAttendanceActions,
} from "./hr-attendance-core";

type Search = Readonly<Record<string, string | string[] | undefined>>;
type Authority = Readonly<{ authorizedActions: readonly AttendanceAuthorizedAction[] }>;
export type AttendanceListState = Authority &
  (
    | { readonly page: HrAttendanceListResponse; readonly status: "success" }
    | AttendanceFailureState
  );
export type AttendanceDetailState = Authority &
  ({ readonly detail: AttendanceDetail; readonly status: "success" } | AttendanceFailureState);
export type AttendanceServiceControlState = Authority &
  (
    | { readonly control: AttendanceServiceControl; readonly status: "success" }
    | AttendanceFailureState
  );

const NO_ACTIONS: readonly AttendanceAuthorizedAction[] = Object.freeze([]);
const SERVICE_RECEIPT_DOMAIN = "esbla-attendance-service-control-receipt-v1\0";
const RECEIPT_TTL_MS = 5 * 60 * 1_000;
const RECEIPT_CLOCK_SKEW_MS = 5_000;
export const ATTENDANCE_SERVICE_RECEIPT_COOKIE = "esbla_attendance_service_control_receipt";
export const ATTENDANCE_SERVICE_RECEIPT_MAX_AGE_SECONDS = RECEIPT_TTL_MS / 1_000;
export interface AttendanceServiceReceipt {
  readonly activationState: "active" | "inactive";
  readonly activationVersion: number;
  readonly controlVersion: number;
  readonly operation: AttendanceServiceOperation;
  readonly settingsVersion: number;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}
function sign(body: string): string {
  const session = readDevelopmentSessionConfig(process.env);
  return createHmac("sha256", session.secret)
    .update(SERVICE_RECEIPT_DOMAIN)
    .update(session.tenantId)
    .update("\0")
    .update(session.principalId)
    .update("\0")
    .update(body)
    .digest("base64url");
}

function actionsForResponse(response: Response): readonly AttendanceAuthorizedAction[] {
  return response.headers.has("x-esbla-attendance-actions")
    ? parseAttendanceActions(response)
    : NO_ACTIONS;
}

async function loadList(
  path: string,
  requiredAction: AttendanceAuthorizedAction,
): Promise<AttendanceListState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const response = await fetchDevelopmentApi({ method: "GET", path });
    authorizedActions = actionsForResponse(response);
    if (response.status === 200 && !hasAttendanceAction(authorizedActions, requiredAction)) {
      throw new AttendanceUiError("operational_error");
    }
    return {
      authorizedActions,
      page: (await decodeAttendanceRead(response, "list")) as HrAttendanceListResponse,
      status: "success",
    };
  } catch (error) {
    return { ...attendanceStateForError(error), authorizedActions };
  }
}

export async function loadOwnAttendance(search: Search = {}): Promise<AttendanceListState> {
  try {
    const query = buildAttendanceListQuery(search);
    return await loadList(`/v1/hr/attendance-observations/own?${query}`, "list_own");
  } catch (error) {
    return { ...attendanceStateForError(error), authorizedActions: NO_ACTIONS };
  }
}

export async function loadReportAttendance(search: Search = {}): Promise<AttendanceListState> {
  try {
    const query = buildAttendanceListQuery(search);
    return await loadList(`/v1/hr/attendance-observations/reports?${query}`, "list_reports");
  } catch (error) {
    return { ...attendanceStateForError(error), authorizedActions: NO_ACTIONS };
  }
}

export async function loadAttendanceDetail(
  observationId: string,
  search: Search = {},
): Promise<AttendanceDetailState> {
  let authorizedActions = NO_ACTIONS;
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        observationId,
      )
    ) {
      throw new AttendanceUiError("validation", 400);
    }
    const query = buildAttendanceDetailQuery(search);
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: `/v1/hr/attendance-observations/by-id/${encodeURIComponent(
        observationId.toLowerCase(),
      )}${query.size > 0 ? `?${query}` : ""}`,
    });
    authorizedActions = actionsForResponse(response);
    if (response.status === 200 && !hasAttendanceAction(authorizedActions, "view_detail")) {
      throw new AttendanceUiError("operational_error");
    }
    return {
      authorizedActions,
      detail: (await decodeAttendanceRead(response, "detail")) as AttendanceDetail,
      status: "success",
    };
  } catch (error) {
    return { ...attendanceStateForError(error), authorizedActions };
  }
}

export async function loadAttendanceServiceControl(): Promise<AttendanceServiceControlState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: "/v1/hr/attendance-observations/service-control",
    });
    authorizedActions = actionsForResponse(response);
    if (response.status === 200 && !hasAttendanceAction(authorizedActions, "view_service_control"))
      throw new AttendanceUiError("operational_error");
    return {
      authorizedActions,
      control: await decodeAttendanceServiceControl(response),
      status: "success",
    };
  } catch (error) {
    return { ...attendanceStateForError(error), authorizedActions };
  }
}

export async function executeAttendanceAction(
  action: AttendanceAction,
): Promise<AttendanceMutationResult> {
  const path =
    action.operation === "record_manual"
      ? "/v1/hr/attendance-observations"
      : `/v1/hr/attendance-observations/${encodeURIComponent(action.observationId)}/corrections`;
  return await decodeAttendanceMutation(
    await fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: "POST",
      path,
    }),
    action.operation,
  );
}

export async function executeAttendanceServiceAction(
  action: AttendanceServiceAction,
): Promise<AttendanceServiceControl> {
  const operation = action.operation.replace("_service", "");
  return await decodeAttendanceServiceMutation(
    await fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: action.operation === "configure_service" ? "PATCH" : "POST",
      path: `/v1/hr/attendance-observations/service-control/${
        operation === "configure" ? "settings" : operation
      }`,
    }),
    action,
  );
}

function receiptFor(
  action: AttendanceServiceAction,
  control: AttendanceServiceControl,
): AttendanceServiceReceipt {
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
  if (
    control.serviceKey !== "attendance" ||
    !valid ||
    control.version !== control.activationVersion + control.settingsVersion - 1
  )
    throw new AttendanceUiError("operational_error");
  return {
    activationState: control.activationState,
    activationVersion: control.activationVersion,
    controlVersion: control.version,
    operation: action.operation,
    settingsVersion: control.settingsVersion,
  };
}

export function sealAttendanceServiceReceipt(
  action: AttendanceServiceAction,
  control: AttendanceServiceControl,
  now = Date.now(),
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - RECEIPT_TTL_MS)
    throw new AttendanceUiError("operational_error");
  const receipt = receiptFor(action, control);
  const body = Buffer.from(
    JSON.stringify([
      1,
      now,
      now + RECEIPT_TTL_MS,
      receipt.operation,
      receipt.activationState,
      receipt.activationVersion,
      receipt.settingsVersion,
      receipt.controlVersion,
    ]),
    "utf8",
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readAttendanceServiceReceipt(
  sealed: string | undefined,
  now = Date.now(),
): AttendanceServiceReceipt | null {
  try {
    if (!sealed || sealed.length > 768 || !Number.isSafeInteger(now) || now < 0) return null;
    const parts = sealed.split(".");
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    )
      return null;
    const body = Buffer.from(parts[0], "base64url");
    const actual = Buffer.from(parts[1], "base64url");
    const expected = Buffer.from(sign(parts[0]), "base64url");
    if (
      body.toString("base64url") !== parts[0] ||
      actual.toString("base64url") !== parts[1] ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return null;
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 8 ||
      value[0] !== 1 ||
      !Number.isSafeInteger(value[1]) ||
      !Number.isSafeInteger(value[2]) ||
      (value[1] as number) < 0 ||
      (value[1] as number) > now + RECEIPT_CLOCK_SKEW_MS ||
      value[2] !== (value[1] as number) + RECEIPT_TTL_MS ||
      (value[2] as number) <= now ||
      !["activate_service", "configure_service", "deactivate_service"].includes(String(value[3])) ||
      !["active", "inactive"].includes(String(value[4])) ||
      !positive(value[5]) ||
      !positive(value[6]) ||
      !positive(value[7]) ||
      value[7] !== (value[5] as number) + (value[6] as number) - 1 ||
      (value[3] === "deactivate_service" ? value[4] !== "inactive" : value[4] !== "active")
    )
      return null;
    return {
      activationState: value[4] as AttendanceServiceReceipt["activationState"],
      activationVersion: value[5],
      controlVersion: value[7],
      operation: value[3] as AttendanceServiceOperation,
      settingsVersion: value[6],
    };
  } catch {
    return null;
  }
}
