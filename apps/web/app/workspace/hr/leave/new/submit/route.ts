import { submitOwnLeaveRequest } from "../../../../../../lib/hr-leave-submit";
import {
  HrLeaveSubmitError,
  isSameOriginSubmission,
  submitFormStateForError,
  validateHrLeaveSubmission,
} from "../../../../../../lib/hr-leave-submit-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function formResponse(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown) {
  if (!(error instanceof HrLeaveSubmitError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (
    error.kind === "identity_unavailable" ||
    error.kind === "service_inactive" ||
    error.kind === "unavailable"
  ) {
    return 503;
  }
  return 422;
}

export async function POST(request: Request) {
  if (
    !isSameOriginSubmission(
      request.url,
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
      request.headers.get("host"),
    )
  ) {
    const error = new HrLeaveSubmitError("forbidden");
    return formResponse({ ok: false, state: submitFormStateForError(error) }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return formResponse(
      { ok: false, state: submitFormStateForError(new HrLeaveSubmitError("invalid_input")) },
      415,
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return formResponse(
      { ok: false, state: submitFormStateForError(new HrLeaveSubmitError("invalid_input")) },
      400,
    );
  }
  const validation = validateHrLeaveSubmission(payload);
  if (!validation.ok) return formResponse({ ok: false, state: validation.state }, 400);

  try {
    await submitOwnLeaveRequest(validation.value);
    return formResponse({ ok: true }, 201);
  } catch (error) {
    return formResponse({ ok: false, state: submitFormStateForError(error) }, failureStatus(error));
  }
}
