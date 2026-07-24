import { executeAttendanceAction } from "../../../../../lib/hr-attendance";
import {
  attendanceStateForError,
  validateAttendanceAction,
} from "../../../../../lib/hr-attendance-core";
import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

function redirect(destination: string, result?: string): Response {
  const location = result
    ? `${destination}?${new URLSearchParams({ result })}#attendance-result`
    : destination;
  return new Response(null, { headers: { ...headers, location }, status: 303 });
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
    value = {};
    for (const [key, entry] of form.entries()) {
      if (typeof entry !== "string" || key in value) throw 0;
      value[key] = entry;
    }
  } catch {
    return redirect("/workspace/hr/attendance/reports", "validation");
  }
  const validation = validateAttendanceAction(value);
  const failureDestination =
    value.operation === "correct" && typeof value.observationId === "string"
      ? `/workspace/hr/attendance/by-id/${encodeURIComponent(value.observationId)}`
      : "/workspace/hr/attendance/reports";
  if (!validation.ok) return redirect(failureDestination, validation.state.kind);
  try {
    const result = await executeAttendanceAction(validation.value);
    const observationId =
      validation.value.operation === "record_manual"
        ? "attendanceObservationId" in result
          ? result.attendanceObservationId
          : null
        : validation.value.observationId;
    return observationId
      ? redirect(`/workspace/hr/attendance/by-id/${encodeURIComponent(observationId)}`)
      : redirect(failureDestination, "operational_error");
  } catch (error) {
    return redirect(failureDestination, attendanceStateForError(error).kind);
  }
}
