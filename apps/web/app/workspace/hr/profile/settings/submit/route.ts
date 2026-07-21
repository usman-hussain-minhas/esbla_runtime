import { isSameOriginSubmission } from "../../../../../../lib/hr-leave-submit-core";
import { executeWorkforceControlCommand } from "../../../../../../lib/hr-workforce-profile-manage";
import {
  HrWorkforceManageError,
  validateWorkforceControlCommand,
  workforceManageMessage,
} from "../../../../../../lib/hr-workforce-profile-manage-core";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

function statusFor(error: unknown) {
  if (!(error instanceof HrWorkforceManageError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (error.kind === "invalid") return 400;
  return 503;
}

function response(body: unknown, status: number) {
  return Response.json(body, { headers, status });
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
    const error = new HrWorkforceManageError("forbidden");
    return response({ message: workforceManageMessage(error), ok: false }, 403);
  }
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    const error = new HrWorkforceManageError("invalid");
    return response({ message: workforceManageMessage(error), ok: false }, 415);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    const error = new HrWorkforceManageError("invalid");
    return response({ message: workforceManageMessage(error), ok: false }, 400);
  }
  const validation = validateWorkforceControlCommand(payload);
  if (!validation.ok) {
    return response(
      { message: workforceManageMessage(validation.error), ok: false },
      statusFor(validation.error),
    );
  }

  try {
    const control = await executeWorkforceControlCommand(validation.command);
    return response({ control, ok: true }, 200);
  } catch (error) {
    return response({ message: workforceManageMessage(error), ok: false }, statusFor(error));
  }
}
