import { isSameOriginSubmission } from "../../../../../../lib/hr-leave-submit-core";
import {
  executeWorkforceProfileServiceControl,
  loadWorkforceProfileServiceControl,
} from "../../../../../../lib/hr-workforce-profile-service-control";
import {
  validateWorkforceServiceControlAction,
  type WorkforceServiceControlFormState,
  WorkforceServiceControlUiError,
  workforceServiceControlStateForError,
} from "../../../../../../lib/hr-workforce-service-control-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function statusForState(state: WorkforceServiceControlFormState): number {
  if (state.kind === "validation") return 400;
  if (state.kind === "denied") return 403;
  if (state.kind === "not_found") return 404;
  if (state.kind === "conflict") return 409;
  return 503;
}

function result(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
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
    const state = workforceServiceControlStateForError(
      new WorkforceServiceControlUiError("denied", 403),
    );
    return result({ ok: false, state }, 403);
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    const state = workforceServiceControlStateForError(
      new WorkforceServiceControlUiError("validation", 415),
    );
    return result({ ok: false, state }, 415);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const state = workforceServiceControlStateForError(
      new WorkforceServiceControlUiError("validation", 400),
    );
    return result({ ok: false, state }, 400);
  }
  const validation = validateWorkforceServiceControlAction(payload);
  if (!validation.ok) return result({ ok: false, state: validation.state }, 400);

  const loaded = await loadWorkforceProfileServiceControl();
  const before = loaded.status === "success" ? loaded.control : null;
  if (loaded.status === "error" && loaded.kind !== "not_found") {
    return result({ ok: false, state: loaded }, statusForState(loaded));
  }
  if (before === null && validation.value.operation !== "activate") {
    const state = workforceServiceControlStateForError(
      new WorkforceServiceControlUiError("not_found", 404),
    );
    return result({ ok: false, state }, 404);
  }

  try {
    const control = await executeWorkforceProfileServiceControl(before, validation.value);
    return result({ control, ok: true }, 200);
  } catch (error) {
    const state = workforceServiceControlStateForError(error);
    return result({ ok: false, state }, statusForState(state));
  }
}
