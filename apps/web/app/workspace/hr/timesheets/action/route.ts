import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";
import {
  executeTimesheetAction,
  executeTimesheetServiceAction,
} from "../../../../../lib/hr-timesheet";
import {
  isTimesheetServiceOperation,
  type TimesheetAction,
  timesheetStateForError,
  validateTimesheetAction,
  validateTimesheetServiceAction,
} from "../../../../../lib/hr-timesheet-core";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function destination(action: TimesheetAction, success: boolean, timesheetId?: string): string {
  const selectedId = timesheetId ?? ("timesheetId" in action ? action.timesheetId : undefined);
  if (action.operation === "create" || action.operation === "edit_draft") {
    const query = new URLSearchParams({
      result: success ? "current" : "operational_error",
      ...(selectedId ? { edit: selectedId } : {}),
    });
    return `/workspace/hr/timesheets?${query}`;
  }
  if (action.operation === "submit") {
    return success && selectedId
      ? `/workspace/hr/timesheets/by-id/${selectedId}?returnTo=own&result=current`
      : `/workspace/hr/timesheets?edit=${selectedId ?? ""}&result=operational_error`;
  }
  if (action.operation === "approve" || action.operation === "reject") {
    const query = new URLSearchParams({
      result: success ? "current" : "operational_error",
      returnTo: action.returnTo,
    });
    return selectedId
      ? `/workspace/hr/timesheets/by-id/${selectedId}?${query}`
      : "/workspace/my-work?result=operational_error";
  }
  return "/workspace/hr/timesheets?result=operational_error";
}

function failedDestination(value: Readonly<Record<string, string>>, kind: string): string {
  const rawTimesheetId = value.timesheetId;
  const selectedId =
    typeof rawTimesheetId === "string" && UUID.test(rawTimesheetId)
      ? rawTimesheetId.toLowerCase()
      : null;
  const query = new URLSearchParams({
    result: kind,
    ...(selectedId ? { edit: selectedId } : {}),
  });
  if (
    selectedId &&
    (value.operation === "approve" || value.operation === "reject") &&
    value.returnTo === "my-work"
  ) {
    return `/workspace/hr/timesheets/by-id/${selectedId}?${new URLSearchParams({
      result: kind,
      returnTo: "my-work",
    })}`;
  }
  return `/workspace/hr/timesheets?${query}`;
}

function redirect(location: string): Response {
  const target = `${location}#timesheet-result`;
  return new Response(null, { headers: { ...headers, location: target }, status: 303 });
}

export async function POST(request: Request): Promise<Response> {
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
    return redirect("/workspace/hr/timesheets?result=validation");
  }
  if (isTimesheetServiceOperation(value.operation)) {
    const validation = validateTimesheetServiceAction(value);
    if (!validation.ok) {
      return redirect(`/workspace/hr/timesheets/settings?result=${validation.state.kind}`);
    }
    try {
      await executeTimesheetServiceAction(validation.value);
      return redirect("/workspace/hr/timesheets/settings?result=current");
    } catch (error) {
      return redirect(
        `/workspace/hr/timesheets/settings?result=${timesheetStateForError(error).kind}`,
      );
    }
  }
  const validation = validateTimesheetAction(value);
  if (!validation.ok) return redirect(failedDestination(value, validation.state.kind));
  try {
    const result = await executeTimesheetAction(validation.value);
    return redirect(destination(validation.value, true, result.timesheetId));
  } catch (error) {
    const state = timesheetStateForError(error);
    return redirect(destination(validation.value, false).replace("operational_error", state.kind));
  }
}
