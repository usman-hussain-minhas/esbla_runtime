import {
  EMPLOYMENT_MUTATION_RECEIPT_COOKIE,
  EMPLOYMENT_MUTATION_RECEIPT_MAX_AGE_SECONDS,
  executeEmploymentAction,
  sealEmploymentMutationReceipt,
} from "../../../../../lib/hr-employment-record";
import {
  employmentStateForError,
  validateEmploymentAction,
} from "../../../../../lib/hr-employment-record-core";
import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";

export const dynamic = "force-dynamic";

const baseResponseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function receiptCookie(requestUrl: string, sealedReceipt?: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return (
    `${EMPLOYMENT_MUTATION_RECEIPT_COOKIE}=${sealedReceipt ?? ""}; ` +
    `Path=/workspace/hr/employment; HttpOnly; SameSite=Strict; ` +
    `Max-Age=${sealedReceipt ? EMPLOYMENT_MUTATION_RECEIPT_MAX_AGE_SECONDS : 0}${secure}`
  );
}

function responseHeaders(requestUrl: string): Record<string, string> {
  return { ...baseResponseHeaders, "set-cookie": receiptCookie(requestUrl) };
}

function destination(
  operation: unknown,
): "/workspace/hr/employment/admin" | "/workspace/hr/employment/settings" {
  return ["activate_service", "configure_service", "deactivate_service"].includes(String(operation))
    ? "/workspace/hr/employment/settings"
    : "/workspace/hr/employment/admin";
}

function redirect(
  path: string,
  result: string,
  requestUrl: string,
  sealedReceipt?: string,
): Response {
  const query = new URLSearchParams({ result });
  const location = `${path}?${query}#employment-result`;
  const headers: Record<string, string> = {
    ...baseResponseHeaders,
    location,
    "set-cookie": receiptCookie(requestUrl, sealedReceipt),
  };
  return new Response(null, {
    headers,
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
      if (typeof entry !== "string" || key in value) throw new TypeError("Invalid form value");
      value[key] = entry;
    }
  } catch {
    return redirect("/workspace/hr/employment", "validation", request.url);
  }

  const path = destination(value.operation);
  const validation = validateEmploymentAction(value);
  if (!validation.ok) return redirect(path, validation.state.kind, request.url);
  try {
    const result = await executeEmploymentAction(validation.value);
    return redirect(
      path,
      "success",
      request.url,
      sealEmploymentMutationReceipt(validation.value, result),
    );
  } catch (error) {
    return redirect(path, employmentStateForError(error).kind, request.url);
  }
}
