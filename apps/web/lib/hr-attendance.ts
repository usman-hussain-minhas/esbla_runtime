import "server-only";

import type { HrAttendanceListResponse } from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import {
  type AttendanceAction,
  type AttendanceAuthorizedAction,
  type AttendanceDetail,
  type AttendanceFailureState,
  type AttendanceMutationResult,
  AttendanceUiError,
  attendanceStateForError,
  buildAttendanceDetailQuery,
  buildAttendanceListQuery,
  decodeAttendanceMutation,
  decodeAttendanceRead,
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

const NO_ACTIONS: readonly AttendanceAuthorizedAction[] = Object.freeze([]);

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
