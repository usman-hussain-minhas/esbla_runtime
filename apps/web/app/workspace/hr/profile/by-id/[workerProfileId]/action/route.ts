import { isSameOriginSubmission } from "../../../../../../../lib/hr-leave-submit-core";
import { executeWorkforceMaintenance } from "../../../../../../../lib/hr-workforce-profile-maintenance";
import {
  normalizeWorkforceMaintenanceTarget,
  statusForWorkforceMaintenanceError,
  validateWorkforceMaintenanceAction,
  WorkforceMaintenanceUiError,
  workforceMaintenanceFormStateForError,
} from "../../../../../../../lib/hr-workforce-profile-maintenance-core";

export const dynamic = "force-dynamic";

interface WorkforceMaintenanceRouteContext {
  readonly params: Promise<{ workerProfileId: string }>;
}

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function formResponse(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

export async function POST(request: Request, context: WorkforceMaintenanceRouteContext) {
  if (
    !isSameOriginSubmission(
      request.url,
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
      request.headers.get("host"),
    )
  ) {
    const error = new WorkforceMaintenanceUiError("denied", 403);
    return formResponse({ ok: false, state: workforceMaintenanceFormStateForError(error) }, 403);
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    const error = new WorkforceMaintenanceUiError("validation", 415);
    return formResponse({ ok: false, state: workforceMaintenanceFormStateForError(error) }, 415);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const error = new WorkforceMaintenanceUiError("validation", 400);
    return formResponse({ ok: false, state: workforceMaintenanceFormStateForError(error) }, 400);
  }
  const validation = validateWorkforceMaintenanceAction(payload);
  if (!validation.ok) return formResponse({ ok: false, state: validation.state }, 400);

  const { workerProfileId } = await context.params;
  try {
    const target = normalizeWorkforceMaintenanceTarget(workerProfileId);
    const result = await executeWorkforceMaintenance(target, validation.value);
    return formResponse({ ok: true, result }, 200);
  } catch (error) {
    return formResponse(
      { ok: false, state: workforceMaintenanceFormStateForError(error) },
      statusForWorkforceMaintenanceError(error),
    );
  }
}
