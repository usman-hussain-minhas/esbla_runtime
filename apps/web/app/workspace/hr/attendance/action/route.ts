import {
  ATTENDANCE_SERVICE_RECEIPT_COOKIE,
  ATTENDANCE_SERVICE_RECEIPT_MAX_AGE_SECONDS,
  executeAttendanceAction,
  executeAttendanceServiceAction,
  sealAttendanceServiceReceipt,
} from "../../../../../lib/hr-attendance";
import {
  attendanceStateForError,
  isAttendanceServiceOperation,
  validateAttendanceAction,
  validateAttendanceServiceAction,
} from "../../../../../lib/hr-attendance-core";
import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";
import {
  buildNestedRouteBackedWidgetHref,
  parseOptionalRouteBackedWidgetOrigin,
  type RouteBackedWidgetOrigin,
} from "../../../../../lib/route-backed-widget-navigation-core";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

function receiptCookie(requestUrl: string, sealed?: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return (
    `${ATTENDANCE_SERVICE_RECEIPT_COOKIE}=${sealed ?? ""}; ` +
    `Path=/workspace/hr/attendance; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${sealed ? ATTENDANCE_SERVICE_RECEIPT_MAX_AGE_SECONDS : 0}${secure}`
  );
}
function responseHeaders(requestUrl: string): Record<string, string> {
  return { ...headers, "set-cookie": receiptCookie(requestUrl) };
}
function redirect(
  destination: string,
  requestUrl: string,
  result?: string,
  sealed?: string,
  origin?: RouteBackedWidgetOrigin,
): Response {
  const target = result
    ? `${destination}${destination.includes("?") ? "&" : "?"}${new URLSearchParams({ result })}`
    : destination;
  const location = `${origin ? buildNestedRouteBackedWidgetHref(target, origin) : target}${
    result ? "#attendance-result" : ""
  }`;
  return new Response(null, {
    headers: { ...headers, location, "set-cookie": receiptCookie(requestUrl, sealed) },
    status: 303,
  });
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
      { headers: responseHeaders(request.url), status: 403 },
    );
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    return Response.json(
      { code: "REQUEST_VALIDATION_FAILED", detail: "The form encoding is invalid." },
      { headers: responseHeaders(request.url), status: 415 },
    );
  }
  let value: Record<string, string>;
  try {
    const form = await request.formData();
    value = {};
    for (const [key, entry] of form.entries()) {
      if (typeof entry !== "string" || key in value) throw 0;
      value[key] = entry;
    }
  } catch {
    return redirect("/workspace/hr/attendance/reports", request.url, "validation");
  }
  if (isAttendanceServiceOperation(value.operation)) {
    const validation = validateAttendanceServiceAction(value);
    if (!validation.ok)
      return redirect("/workspace/hr/attendance/settings", request.url, validation.state.kind);
    try {
      const result = await executeAttendanceServiceAction(validation.value);
      return redirect(
        "/workspace/hr/attendance/settings",
        request.url,
        "success",
        sealAttendanceServiceReceipt(validation.value, result),
      );
    } catch (error) {
      return redirect(
        "/workspace/hr/attendance/settings",
        request.url,
        attendanceStateForError(error).kind,
      );
    }
  }
  const presentationOrigin = parseOptionalRouteBackedWidgetOrigin(value, [
    "/workspace/hr/attendance",
    "/workspace/hr/attendance/reports",
  ]);
  const returnTo = value.returnTo === "own" || value.returnTo === "reports" ? value.returnTo : null;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(value.from ?? "") ? value.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(value.to ?? "") ? value.to : null;
  delete value.originFocusId;
  delete value.originWidgetDefinitionId;
  delete value.returnSurface;
  delete value.returnTo;
  delete value.from;
  delete value.to;
  const contextualDestination = (destination: string, detailReturnTo?: "own" | "reports") => {
    const parameters = new URLSearchParams();
    if (detailReturnTo) parameters.set("returnTo", detailReturnTo);
    if (from) parameters.set("from", from);
    if (to) parameters.set("to", to);
    return `${destination}${parameters.size > 0 ? `?${parameters}` : ""}`;
  };
  const validation = validateAttendanceAction(value);
  const failureDestination =
    value.operation === "correct" && typeof value.observationId === "string"
      ? contextualDestination(
          `/workspace/hr/attendance/by-id/${encodeURIComponent(value.observationId)}`,
          returnTo ?? undefined,
        )
      : contextualDestination("/workspace/hr/attendance/reports");
  if (!validation.ok)
    return redirect(
      failureDestination,
      request.url,
      validation.state.kind,
      undefined,
      presentationOrigin,
    );
  try {
    const result = await executeAttendanceAction(validation.value);
    const observationId =
      validation.value.operation === "record_manual"
        ? "attendanceObservationId" in result
          ? result.attendanceObservationId
          : null
        : validation.value.observationId;
    return observationId
      ? redirect(
          contextualDestination(
            `/workspace/hr/attendance/by-id/${encodeURIComponent(observationId)}`,
            validation.value.operation === "record_manual" ? "reports" : (returnTo ?? undefined),
          ),
          request.url,
          undefined,
          undefined,
          presentationOrigin,
        )
      : redirect(
          failureDestination,
          request.url,
          "operational_error",
          undefined,
          presentationOrigin,
        );
  } catch (error) {
    return redirect(
      failureDestination,
      request.url,
      attendanceStateForError(error).kind,
      undefined,
      presentationOrigin,
    );
  }
}
