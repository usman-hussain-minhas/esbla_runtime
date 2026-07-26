import {
  executeExpenseAction,
  executeExpenseServiceAction,
} from "../../../../../lib/hr-expense-claim";
import {
  type ExpenseAction,
  expenseStateForError,
  isExpenseServiceOperation,
  validateExpenseAction,
  validateExpenseServiceAction,
} from "../../../../../lib/hr-expense-claim-core";
import { isSameOriginSubmission } from "../../../../../lib/hr-leave-submit-core";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function destination(action: ExpenseAction, success: boolean, expenseClaimId?: string): string {
  const selectedId =
    expenseClaimId ?? ("expenseClaimId" in action ? action.expenseClaimId : undefined);
  const result = success ? "current" : "operational_error";
  if (action.operation === "create" || action.operation === "edit_draft") {
    const query = new URLSearchParams({
      result,
      ...(selectedId ? { edit: selectedId } : {}),
    });
    return `/workspace/hr/expenses?${query}`;
  }
  if (action.operation === "submit") {
    return success && selectedId
      ? `/workspace/hr/expenses/by-id/${selectedId}?returnTo=own&result=current`
      : `/workspace/hr/expenses?edit=${selectedId ?? ""}&result=operational_error`;
  }
  if (action.operation === "create_correction") {
    return selectedId
      ? `/workspace/hr/expenses/by-id/${selectedId}?returnTo=own&result=${
          success ? "current" : "operational_error"
        }`
      : "/workspace/hr/expenses?result=operational_error";
  }
  if (action.operation === "approve" || action.operation === "reject") {
    const query = new URLSearchParams({
      result: success ? "current" : "operational_error",
      returnTo: action.returnTo,
    });
    return selectedId
      ? `/workspace/hr/expenses/by-id/${selectedId}?${query}`
      : "/workspace/my-work?result=operational_error";
  }
  return "/workspace/hr/expenses?result=operational_error";
}

function failedDestination(value: Readonly<Record<string, string>>, kind: string): string {
  const selectedId =
    typeof value.expenseClaimId === "string" && UUID.test(value.expenseClaimId)
      ? value.expenseClaimId.toLowerCase()
      : null;
  if (
    selectedId &&
    (value.operation === "approve" || value.operation === "reject") &&
    (value.returnTo === "detail" || value.returnTo === "my-work")
  ) {
    return `/workspace/hr/expenses/by-id/${selectedId}?${new URLSearchParams({
      result: kind,
      returnTo: value.returnTo,
    })}`;
  }
  if (selectedId && value.operation === "create_correction" && value.returnTo === "own") {
    return `/workspace/hr/expenses/by-id/${selectedId}?${new URLSearchParams({
      result: kind,
      returnTo: "own",
    })}`;
  }
  return `/workspace/hr/expenses?${new URLSearchParams({
    result: kind,
    ...(selectedId ? { edit: selectedId } : {}),
  })}`;
}

function redirect(location: string): Response {
  return new Response(null, {
    headers: { ...headers, location: `${location}#expense-result` },
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
    value = Object.create(null) as Record<string, string>;
    for (const [key, entry] of form.entries()) {
      if (typeof entry !== "string" || Object.hasOwn(value, key)) throw 0;
      value[key] = entry;
    }
  } catch {
    return redirect("/workspace/hr/expenses?result=validation");
  }
  if (isExpenseServiceOperation(value.operation)) {
    const validation = validateExpenseServiceAction(value);
    if (!validation.ok) {
      return redirect(`/workspace/hr/expenses/settings?result=${validation.state.kind}`);
    }
    try {
      await executeExpenseServiceAction(validation.value);
      return redirect("/workspace/hr/expenses/settings?result=current");
    } catch (error) {
      return redirect(`/workspace/hr/expenses/settings?result=${expenseStateForError(error).kind}`);
    }
  }
  const validation = validateExpenseAction(value);
  if (!validation.ok) return redirect(failedDestination(value, validation.state.kind));
  try {
    const result = await executeExpenseAction(validation.value);
    return redirect(destination(validation.value, true, result.expenseClaimId));
  } catch (error) {
    const state = expenseStateForError(error);
    return redirect(destination(validation.value, false).replace("operational_error", state.kind));
  }
}
