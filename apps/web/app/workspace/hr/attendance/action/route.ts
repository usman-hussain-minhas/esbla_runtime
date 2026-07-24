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
): Response {
  const location = result
    ? `${destination}?${new URLSearchParams({ result })}#attendance-result`
    : destination;
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
  const validation = validateAttendanceAction(value);
  const failureDestination =
    value.operation === "correct" && typeof value.observationId === "string"
      ? `/workspace/hr/attendance/by-id/${encodeURIComponent(value.observationId)}`
      : "/workspace/hr/attendance/reports";
  if (!validation.ok) return redirect(failureDestination, request.url, validation.state.kind);
  try {
    const result = await executeAttendanceAction(validation.value);
    const observationId =
      validation.value.operation === "record_manual"
        ? "attendanceObservationId" in result
          ? result.attendanceObservationId
          : null
        : validation.value.observationId;
    return observationId
      ? redirect(`/workspace/hr/attendance/by-id/${encodeURIComponent(observationId)}`, request.url)
      : redirect(failureDestination, request.url, "operational_error");
  } catch (error) {
    return redirect(failureDestination, request.url, attendanceStateForError(error).kind);
  }
}
