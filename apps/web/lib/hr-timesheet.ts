import "server-only";

import type {
  HrTimesheetAssignedCursor,
  HrTimesheetListResponse,
  HrTimesheetResponse,
} from "@esbla/contracts/hr-timesheet-api";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildAssignedTimesheetListPath,
  decodeAssignedTimesheetListResponse,
} from "./hr-timesheet-assigned-list-core";
import {
  buildOwnTimesheetPath,
  buildTimesheetDetailPath,
  decodeTimesheetDetail,
  decodeTimesheetList,
  decodeTimesheetMutation,
  decodeTimesheetServiceControl,
  decodeTimesheetServiceMutation,
  hasTimesheetAction,
  parseTimesheetActions,
  type TimesheetAction,
  type TimesheetAuthorizedAction,
  type TimesheetFailureState,
  type TimesheetServiceAction,
  type TimesheetServiceControl,
  TimesheetUiError,
  timesheetStateForError,
} from "./hr-timesheet-core";

type Search = Readonly<Record<string, string | readonly string[] | undefined>>;
type Authority = Readonly<{ authorizedActions: readonly TimesheetAuthorizedAction[] }>;
type OwnTimesheetPage = Extract<HrTimesheetListResponse, { readonly kind: "own" }>;
export type TimesheetOwnListState = Authority &
  ({ readonly page: OwnTimesheetPage; readonly status: "success" } | TimesheetFailureState);
export type TimesheetDetailState = Authority &
  ({ readonly detail: HrTimesheetResponse; readonly status: "success" } | TimesheetFailureState);
export type TimesheetServiceControlState = Authority &
  (
    | { readonly control: TimesheetServiceControl; readonly status: "success" }
    | TimesheetFailureState
  );

const NO_ACTIONS: readonly TimesheetAuthorizedAction[] = Object.freeze([]);

function actions(response: Response): readonly TimesheetAuthorizedAction[] {
  return parseTimesheetActions(response);
}

export function getAssignedTimesheets(cursor?: HrTimesheetAssignedCursor) {
  return decodeAssignedTimesheetListResponse(
    fetchDevelopmentApi({ method: "GET", path: buildAssignedTimesheetListPath(cursor) }),
  );
}

export async function loadOwnTimesheets(search: Search = {}): Promise<TimesheetOwnListState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const path = buildOwnTimesheetPath(search);
    const response = await fetchDevelopmentApi({ method: "GET", path });
    authorizedActions = actions(response);
    if (response.status === 200 && !hasTimesheetAction(authorizedActions, "list_own"))
      throw new TimesheetUiError("operational_error");
    return {
      authorizedActions,
      page: (await decodeTimesheetList(response, "own")) as OwnTimesheetPage,
      status: "success",
    };
  } catch (error) {
    return { ...timesheetStateForError(error), authorizedActions };
  }
}

export async function loadTimesheetDetail(
  timesheetId: string,
  search: Search = {},
): Promise<TimesheetDetailState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const path = buildTimesheetDetailPath(timesheetId, search);
    const response = await fetchDevelopmentApi({ method: "GET", path });
    authorizedActions = actions(response);
    if (response.status === 200 && !hasTimesheetAction(authorizedActions, "view_detail"))
      throw new TimesheetUiError("operational_error");
    return {
      authorizedActions,
      detail: await decodeTimesheetDetail(response),
      status: "success",
    };
  } catch (error) {
    return { ...timesheetStateForError(error), authorizedActions };
  }
}

export async function loadTimesheetServiceControl(): Promise<TimesheetServiceControlState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: "/v1/hr/timesheets/service-control",
    });
    authorizedActions = actions(response);
    if (response.status === 200 && !hasTimesheetAction(authorizedActions, "view_service_control")) {
      throw new TimesheetUiError("operational_error");
    }
    return {
      authorizedActions,
      control: await decodeTimesheetServiceControl(response),
      status: "success",
    };
  } catch (error) {
    return { ...timesheetStateForError(error), authorizedActions };
  }
}

export async function executeTimesheetAction(
  action: TimesheetAction,
): Promise<HrTimesheetResponse> {
  const path =
    action.operation === "create"
      ? "/v1/hr/timesheets"
      : `/v1/hr/timesheets/${encodeURIComponent(action.timesheetId)}/${
          action.operation === "edit_draft" ? "draft" : action.operation
        }`;
  return await decodeTimesheetMutation(
    await fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: action.operation === "edit_draft" ? "PATCH" : "POST",
      path,
    }),
    action.operation,
  );
}

export async function executeTimesheetServiceAction(
  action: TimesheetServiceAction,
): Promise<TimesheetServiceControl> {
  const suffix =
    action.operation === "configure_service"
      ? "settings"
      : action.operation.replace("_service", "");
  return await decodeTimesheetServiceMutation(
    await fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: action.operation === "configure_service" ? "PATCH" : "POST",
      path: `/v1/hr/timesheets/service-control/${suffix}`,
    }),
    action,
  );
}
