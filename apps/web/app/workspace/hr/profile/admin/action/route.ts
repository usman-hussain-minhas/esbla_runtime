import { isSameOriginSubmission } from "../../../../../../lib/hr-leave-submit-core";
import { executeWorkforceAction } from "../../../../../../lib/hr-workforce-profile";
import {
  statusForWorkforceError,
  validateWorkforceAction,
  WorkforceProfileUiError,
  workforceFormStateForError,
} from "../../../../../../lib/hr-workforce-profile-core";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;
const result = (body: unknown, status: number) => Response.json(body, { headers, status });

export async function POST(request: Request) {
  if (
    !isSameOriginSubmission(
      request.url,
      request.headers.get("origin"),
      request.headers.get("sec-fetch-site"),
      request.headers.get("host"),
    )
  ) {
    const error = new WorkforceProfileUiError("denied", 403);
    return result({ ok: false, state: workforceFormStateForError(error) }, 403);
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    const error = new WorkforceProfileUiError("validation", 415);
    return result({ ok: false, state: workforceFormStateForError(error) }, 415);
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const error = new WorkforceProfileUiError("validation", 400);
    return result({ ok: false, state: workforceFormStateForError(error) }, 400);
  }
  const validation = validateWorkforceAction(payload);
  if (!validation.ok) return result({ ok: false, state: validation.state }, 400);
  try {
    return result({ ok: true, profile: await executeWorkforceAction(validation.value) }, 200);
  } catch (error) {
    return result(
      { ok: false, state: workforceFormStateForError(error) },
      statusForWorkforceError(error),
    );
  }
}
