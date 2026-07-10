import { rejectAssignedLeaveRequest } from "../../../../../../lib/hr-leave-reject";
import {
  HrLeaveRejectError,
  rejectFormStateForError,
  validateHrLeaveRejection,
} from "../../../../../../lib/hr-leave-reject-core";
import { isSameOriginSubmission } from "../../../../../../lib/hr-leave-submit-core";

export const dynamic = "force-dynamic";

interface RejectionRouteContext {
  readonly params: Promise<{ leaveRequestId: string }>;
}

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function formResponse(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown) {
  if (!(error instanceof HrLeaveRejectError)) return 503;
  if (error.kind === "invalid_input" || error.kind === "note_required") return 400;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "not_found") return 404;
  if (error.kind === "conflict") return 409;
  return 503;
}

export async function POST(request: Request, context: RejectionRouteContext) {
  if (
    !isSameOriginSubmission(
      request.url,
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
      request.headers.get("host"),
    )
  ) {
    const error = new HrLeaveRejectError("forbidden");
    return formResponse({ ok: false, state: rejectFormStateForError(error) }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    const error = new HrLeaveRejectError("invalid_input");
    return formResponse({ ok: false, state: rejectFormStateForError(error) }, 415);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const error = new HrLeaveRejectError("invalid_input");
    return formResponse({ ok: false, state: rejectFormStateForError(error) }, 400);
  }
  const validation = validateHrLeaveRejection(payload);
  if (!validation.ok) return formResponse({ ok: false, state: validation.state }, 400);

  const { leaveRequestId } = await context.params;
  try {
    const rejected = await rejectAssignedLeaveRequest(leaveRequestId, validation.value);
    return formResponse({ leaveRequestId: rejected.leaveRequestId, ok: true }, 200);
  } catch (error) {
    return formResponse({ ok: false, state: rejectFormStateForError(error) }, failureStatus(error));
  }
}
