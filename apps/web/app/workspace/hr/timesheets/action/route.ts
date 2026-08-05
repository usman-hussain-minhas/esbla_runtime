import {
  ASSIGNED_PROVIDER_MASTER_CURSOR_KEYS,
  parseAssignedProviderMasterCursorParameters,
} from "../../../../../lib/assigned-provider-core";
import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";
import {
  executeTimesheetAction,
  executeTimesheetServiceAction,
} from "../../../../../lib/hr-timesheet";
import {
  isTimesheetServiceOperation,
  parseOwnTimesheetCursor,
  TIMESHEET_CORRECTIONS_SURFACE_PATH,
  type TimesheetAction,
  timesheetStateForError,
  validateTimesheetAction,
  validateTimesheetServiceAction,
} from "../../../../../lib/hr-timesheet-core";
import {
  buildNestedRouteBackedWidgetHref,
  parseOptionalRouteBackedWidgetOrigin,
  type RouteBackedWidgetOrigin,
} from "../../../../../lib/route-backed-widget-navigation-core";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;
const ROUTE_BACKED_POST_RESPONSE_HEADER = "x-esbla-route-backed-post-response";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWN_CURSOR_KEYS = ["cursorPeriodStart", "cursorTimesheetId"] as const;
const OWN_CURSOR_OPERATIONS = new Set(["create", "edit_draft", "submit"]);

function destination(
  action: TimesheetAction,
  success: boolean,
  timesheetId?: string,
  masterCursorParameters: Readonly<Record<string, string>> = {},
  ownCursorParameters: Readonly<Record<string, string>> = {},
): string {
  const selectedId = timesheetId ?? ("timesheetId" in action ? action.timesheetId : undefined);
  if (action.operation === "create" || action.operation === "edit_draft") {
    const query = new URLSearchParams({
      result: success ? "current" : "operational_error",
      ...(selectedId ? { edit: selectedId } : {}),
      ...ownCursorParameters,
    });
    return `/workspace/hr/timesheets?${query}`;
  }
  if (action.operation === "submit") {
    return success && selectedId
      ? `/workspace/hr/timesheets/by-id/${selectedId}?${new URLSearchParams({
          returnTo: "own",
          result: "current",
          ...ownCursorParameters,
        })}`
      : `/workspace/hr/timesheets?${new URLSearchParams({
          edit: selectedId ?? "",
          result: "operational_error",
          ...ownCursorParameters,
        })}`;
  }
  if (action.operation === "create_correction") {
    return selectedId
      ? `/workspace/hr/timesheets/by-id/${selectedId}?returnTo=corrections&result=${
          success ? "current" : "operational_error"
        }`
      : `${TIMESHEET_CORRECTIONS_SURFACE_PATH}?result=operational_error`;
  }
  if (action.operation === "approve" || action.operation === "reject") {
    const query = new URLSearchParams({
      result: success ? "current" : "operational_error",
      ...(action.returnTo === "my-work"
        ? { returnContext: "my-work", ...masterCursorParameters }
        : { returnTo: action.returnTo }),
    });
    return selectedId
      ? `/workspace/hr/timesheets/by-id/${selectedId}?${query}`
      : "/workspace/my-work?result=operational_error";
  }
  return `/workspace/hr/timesheets?${new URLSearchParams({
    result: "operational_error",
    ...ownCursorParameters,
  })}`;
}

function failedDestination(
  value: Readonly<Record<string, string>>,
  kind: string,
  masterCursorParameters: Readonly<Record<string, string>> = {},
  ownCursorParameters: Readonly<Record<string, string>> = {},
): string {
  const rawTimesheetId = value.timesheetId;
  const selectedId =
    typeof rawTimesheetId === "string" && UUID.test(rawTimesheetId)
      ? rawTimesheetId.toLowerCase()
      : null;
  const query = new URLSearchParams({
    result: kind,
    ...(selectedId ? { edit: selectedId } : {}),
    ...ownCursorParameters,
  });
  if (
    selectedId &&
    (value.operation === "approve" || value.operation === "reject") &&
    value.returnTo === "my-work"
  ) {
    return `/workspace/hr/timesheets/by-id/${selectedId}?${new URLSearchParams({
      result: kind,
      returnContext: "my-work",
      ...masterCursorParameters,
    })}`;
  }
  if (selectedId && value.operation === "create_correction" && value.returnTo === "corrections") {
    return `/workspace/hr/timesheets/by-id/${selectedId}?${new URLSearchParams({
      result: kind,
      returnTo: "corrections",
    })}`;
  }
  return `/workspace/hr/timesheets?${query}`;
}

function redirect(request: Request, location: string, origin?: RouteBackedWidgetOrigin): Response {
  const destination = origin ? buildNestedRouteBackedWidgetHref(location, origin) : location;
  const target = `${destination}#timesheet-result`;
  if (request.headers.get(ROUTE_BACKED_POST_RESPONSE_HEADER) === "json") {
    return Response.json({ location: target }, { headers, status: 200 });
  }
  return new Response(null, { headers: { ...headers, location: target }, status: 303 });
}

export async function POST(request: Request): Promise<Response> {
  const respond = (location: string, origin?: RouteBackedWidgetOrigin) =>
    redirect(request, location, origin);
  if (
    !isSameOriginSubmission(
      request.url,
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
      request.headers.get("host"),
    )
  ) {
    return Response.json(
      { code: "POLICY_DENIED", detail: "The submission origin is not allowed." },
      { headers, status: 403 },
    );
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    return Response.json(
      { code: "REQUEST_VALIDATION_FAILED", detail: "The form encoding is invalid." },
      { headers, status: 415 },
    );
  }
  let value: Record<string, string>;
  try {
    const form = await request.formData();
    value = Object.create(null) as Record<string, string>;
    for (const [key, entry] of form.entries()) {
      if (typeof entry !== "string" || Object.hasOwn(value, key)) throw 0;
      value[key] = entry;
    }
  } catch {
    return respond("/workspace/hr/timesheets?result=validation");
  }
  const presentationOrigin = parseOptionalRouteBackedWidgetOrigin(value, [
    "/workspace/hr/timesheets",
    "/workspace/hr/timesheets/admin/corrections",
    "/workspace/my-work",
  ]);
  delete value.originFocusId;
  delete value.originWidgetDefinitionId;
  delete value.returnSurface;
  let masterCursorParameters: Readonly<Record<string, string>> = {};
  let ownCursorParameters: Readonly<Record<string, string>> = {};
  if (
    (value.operation === "approve" || value.operation === "reject") &&
    value.returnTo === "my-work"
  ) {
    try {
      masterCursorParameters = parseAssignedProviderMasterCursorParameters(value);
    } catch {
      for (const key of ASSIGNED_PROVIDER_MASTER_CURSOR_KEYS) delete value[key];
      return respond(failedDestination(value, "validation"), presentationOrigin);
    }
    for (const key of ASSIGNED_PROVIDER_MASTER_CURSOR_KEYS) delete value[key];
  }
  if (OWN_CURSOR_KEYS.some((key) => Object.hasOwn(value, key))) {
    if (!OWN_CURSOR_OPERATIONS.has(value.operation ?? "")) {
      return respond(failedDestination(value, "validation"), presentationOrigin);
    }
    try {
      const cursor = parseOwnTimesheetCursor(value);
      if (!cursor) throw 0;
      ownCursorParameters = {
        cursorPeriodStart: cursor.periodStart,
        cursorTimesheetId: cursor.timesheetId,
      };
    } catch {
      for (const key of OWN_CURSOR_KEYS) delete value[key];
      return respond(failedDestination(value, "validation"), presentationOrigin);
    }
    for (const key of OWN_CURSOR_KEYS) delete value[key];
  }
  if (isTimesheetServiceOperation(value.operation)) {
    const validation = validateTimesheetServiceAction(value);
    if (!validation.ok) {
      return respond(`/workspace/hr/timesheets/settings?result=${validation.state.kind}`);
    }
    try {
      await executeTimesheetServiceAction(validation.value);
      return respond("/workspace/hr/timesheets/settings?result=current");
    } catch (error) {
      return respond(
        `/workspace/hr/timesheets/settings?result=${timesheetStateForError(error).kind}`,
      );
    }
  }
  const validation = validateTimesheetAction(value);
  if (!validation.ok)
    return respond(
      failedDestination(value, validation.state.kind, masterCursorParameters, ownCursorParameters),
      presentationOrigin,
    );
  try {
    const result = await executeTimesheetAction(validation.value);
    return respond(
      destination(
        validation.value,
        true,
        result.timesheetId,
        masterCursorParameters,
        ownCursorParameters,
      ),
      presentationOrigin,
    );
  } catch (error) {
    const state = timesheetStateForError(error);
    return respond(
      destination(
        validation.value,
        false,
        undefined,
        masterCursorParameters,
        ownCursorParameters,
      ).replace("operational_error", state.kind),
      presentationOrigin,
    );
  }
}
