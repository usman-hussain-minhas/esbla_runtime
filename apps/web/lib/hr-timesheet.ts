import "server-only";

import type {
  HrTimesheetListResponse,
  HrTimesheetResponse,
} from "@esbla/contracts/hr-timesheet-api";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildOwnTimesheetPath,
  buildTimesheetDetailPath,
  decodeTimesheetDetail,
  decodeTimesheetList,
  decodeTimesheetMutation,
  hasTimesheetAction,
  parseTimesheetActions,
  type TimesheetAction,
  type TimesheetAuthorizedAction,
  type TimesheetFailureState,
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

const NO_ACTIONS: readonly TimesheetAuthorizedAction[] = Object.freeze([]);

function actions(response: Response): readonly TimesheetAuthorizedAction[] {
  return parseTimesheetActions(response);
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
