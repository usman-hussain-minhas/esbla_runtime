import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";
import {
  executeShiftAction,
  executeShiftServiceAction,
  SHIFT_MUTATION_RECEIPT_COOKIE,
  SHIFT_MUTATION_RECEIPT_MAX_AGE_SECONDS,
  sealShiftMutationReceipt,
  sealShiftServiceReceipt,
} from "../../../../../lib/hr-shift-assignment";
import {
  isShiftServiceOperation,
  shiftStateForError,
  validateShiftAction,
  validateShiftServiceAction,
} from "../../../../../lib/hr-shift-assignment-core";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;

function receiptCookie(requestUrl: string, sealed?: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return (
    `${SHIFT_MUTATION_RECEIPT_COOKIE}=${sealed ?? ""}; Path=/workspace/hr/shifts; ` +
    `HttpOnly; SameSite=Strict; Max-Age=${sealed ? SHIFT_MUTATION_RECEIPT_MAX_AGE_SECONDS : 0}${secure}`
  );
}
function responseHeaders(requestUrl: string): Record<string, string> {
  return { ...headers, "set-cookie": receiptCookie(requestUrl) };
}
function redirect(
  result: string,
  requestUrl: string,
  extra: Record<string, string> = {},
  sealed?: string,
  destination = "/workspace/hr/shifts/reports",
): Response {
  const query = new URLSearchParams({ ...extra, result });
  return new Response(null, {
    headers: {
      ...headers,
      location: `${destination}?${query}#shift-result`,
      "set-cookie": receiptCookie(requestUrl, sealed),
    },
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
    return redirect("validation", request.url);
  }
  if (isShiftServiceOperation(value.operation)) {
    const validation = validateShiftServiceAction(value);
    if (!validation.ok)
      return redirect(
        validation.state.kind,
        request.url,
        {},
        undefined,
        "/workspace/hr/shifts/settings",
      );
    try {
      const result = await executeShiftServiceAction(validation.value);
      return redirect(
        "success",
        request.url,
        {},
        sealShiftServiceReceipt(validation.value, result),
        "/workspace/hr/shifts/settings",
      );
    } catch (error) {
      return redirect(
        shiftStateForError(error).kind,
        request.url,
        {},
        undefined,
        "/workspace/hr/shifts/settings",
      );
    }
  }
  const validation = validateShiftAction(value);
  if (!validation.ok) return redirect(validation.state.kind, request.url);
  try {
    const result = await executeShiftAction(validation.value);
    const extra =
      "assignment" in result
        ? {
            rosterVersionId: result.assignment.rosterVersionId,
            status: result.assignment.status,
          }
        : {
            rosterVersion: String(result.version),
            rosterVersionId: result.rosterVersionId,
            status: "active",
          };
    return redirect(
      "success",
      request.url,
      extra,
      sealShiftMutationReceipt(validation.value, result),
    );
  } catch (error) {
    return redirect(shiftStateForError(error).kind, request.url);
  }
}
