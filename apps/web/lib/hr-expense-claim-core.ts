import { type ApiProblemDetails, parseApiProblemDetails } from "@esbla/contracts";
import type {
  HrExpenseClaimCreateBody,
  HrExpenseClaimEditDraftBody,
  HrExpenseClaimListResponse,
  HrExpenseClaimResponse,
  HrExpenseClaimSubmitBody,
} from "@esbla/contracts/hr-expense-claim-api";
import {
  parseHrExpenseClaimListResponse,
  parseHrExpenseClaimResponse,
} from "@esbla/contracts/hr-expense-claim-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const LINE_FIELD =
  /^(amountMinor|categoryCode|description|expenseDate|expenseLineId|lineVersion)_(0|[1-9]\d?)$/;
const MAX_INTEGER = 2_147_483_647;
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
type Search = Readonly<Record<string, string | readonly string[] | undefined>>;

export const EXPENSE_AUTHORIZED_ACTIONS = Object.freeze([
  "activate_service",
  "approve",
  "configure_service",
  "create",
  "create_correction",
  "deactivate_service",
  "edit_draft",
  "list_assigned",
  "list_own",
  "reject",
  "submit",
  "view_detail",
  "view_service_control",
] as const);
export type ExpenseAuthorizedAction = (typeof EXPENSE_AUTHORIZED_ACTIONS)[number];
export type ExpenseFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export interface ExpenseFailureState {
  readonly kind: ExpenseFailureKind;
  readonly message: string;
  readonly status: "error";
  readonly title: string;
}
type ExpectedBody = HrExpenseClaimSubmitBody;
export type ExpenseAction =
  | Readonly<{
      body: HrExpenseClaimCreateBody;
      idempotencyKey: string;
      operation: "create";
    }>
  | Readonly<{
      body: HrExpenseClaimEditDraftBody;
      expenseClaimId: string;
      idempotencyKey: string;
      operation: "edit_draft";
    }>
  | Readonly<{
      body: HrExpenseClaimSubmitBody;
      expenseClaimId: string;
      idempotencyKey: string;
      operation: "submit";
    }>;
export type ExpenseActionValidation =
  | Readonly<{ ok: true; value: ExpenseAction }>
  | Readonly<{ ok: false; state: ExpenseFailureState }>;

export class ExpenseUiError extends Error {
  constructor(
    readonly kind: ExpenseFailureKind,
    readonly httpStatus = 503,
  ) {
    super("Expense Claim request failed");
    this.name = "ExpenseUiError";
  }
}

export function expenseStateForError(error: unknown): ExpenseFailureState {
  const kind = error instanceof ExpenseUiError ? error.kind : "operational_error";
  const copy: Record<ExpenseFailureKind, readonly [string, string]> = {
    conflict: ["Expense Claim changed", "Reload current values before trying again."],
    denied: [
      "Expense Claim unavailable",
      "Your current role does not permit this Expense Claim action.",
    ],
    dependency_unavailable: [
      "Expense Claim dependency unavailable",
      "Workforce Profile or assigned work is unavailable right now.",
    ],
    inactive: [
      "Expense Claim inactive",
      "Existing Expense Claim history is preserved while inactive.",
    ],
    not_found: ["Expense Claim not found", "This Expense Claim is not available."],
    operational_error: [
      "Expense Claim unavailable",
      "The Expense Claim request could not be completed.",
    ],
    validation: [
      "Review Expense Claim details",
      "Currency, lines, dates, categories, or expected versions are invalid.",
    ],
  };
  return { kind, message: copy[kind][1], status: "error", title: copy[kind][0] };
}

export function hasExpenseAction(
  actions: readonly ExpenseAuthorizedAction[],
  action: ExpenseAuthorizedAction,
): boolean {
  return actions.includes(action);
}

export function parseExpenseActions(response: Response): readonly ExpenseAuthorizedAction[] {
  const header = response.headers.get("x-esbla-expense-actions");
  if (header === null || header.length > 384) throw new ExpenseUiError("operational_error");
  try {
    const parsed: unknown = JSON.parse(header);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw 0;
    const selected = new Set(parsed);
    const canonical = EXPENSE_AUTHORIZED_ACTIONS.filter((action) => selected.has(action));
    if (
      selected.size !== parsed.length ||
      canonical.length !== parsed.length ||
      JSON.stringify(canonical) !== header
    ) {
      throw 0;
    }
    return Object.freeze(canonical);
  } catch (error) {
    if (error instanceof ExpenseUiError) throw error;
    throw new ExpenseUiError("operational_error");
  }
}

function problemError(problem: ApiProblemDetails): ExpenseUiError {
  if (
    problem.status === 403 &&
    ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code)
  ) {
    return new ExpenseUiError("denied", 403);
  }
  if (
    problem.status === 404 &&
    ["EXPENSE_NOT_FOUND", "EXPENSE_SERVICE_CONTROL_NOT_FOUND"].includes(problem.code)
  ) {
    return new ExpenseUiError("not_found", 404);
  }
  if (problem.status === 503 && problem.code === "EXPENSE_SERVICE_INACTIVE") {
    return new ExpenseUiError("inactive");
  }
  if (
    problem.status === 503 &&
    ["ACTIVATION_DEPENDENCY_BLOCKED", "EXPENSE_DEPENDENCY_INACTIVE"].includes(problem.code)
  ) {
    return new ExpenseUiError("dependency_unavailable");
  }
  if (
    problem.status === 400 &&
    ["REQUEST_VALIDATION_FAILED", "EXPENSE_INPUT_INVALID"].includes(problem.code)
  ) {
    return new ExpenseUiError("validation", 400);
  }
  if (
    problem.status === 409 &&
    [
      "ACTIVATION_CONFLICT",
      "EXPENSE_CONFLICT",
      "EXPENSE_VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
    ].includes(problem.code)
  ) {
    return new ExpenseUiError("conflict", 409);
  }
  return new ExpenseUiError("operational_error");
}

function mediaTypeEssence(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return null;
  let escaped = false;
  let quoted = false;
  for (const character of contentType) {
    if (escaped) escaped = false;
    else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") return null;
  }
  if (quoted || escaped) return null;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

async function body(response: Response, valid: boolean): Promise<unknown> {
  if (valid && mediaTypeEssence(response) === "application/json") {
    try {
      return await response.json();
    } catch {
      throw new ExpenseUiError("operational_error");
    }
  }
  if (response.status >= 400 && mediaTypeEssence(response) === "application/problem+json") {
    try {
      const problem = parseApiProblemDetails(await response.json());
      if (problem.status !== response.status) throw 0;
      throw problemError(problem);
    } catch (error) {
      if (error instanceof ExpenseUiError) throw error;
    }
  }
  throw new ExpenseUiError("operational_error");
}

export async function decodeExpenseList(
  response: Response,
  expectedKind: "assigned" | "own",
): Promise<HrExpenseClaimListResponse> {
  const value = await body(response, response.status === 200);
  try {
    const page = parseHrExpenseClaimListResponse(value);
    if (page.kind !== expectedKind) throw 0;
    return page;
  } catch {
    throw new ExpenseUiError("operational_error");
  }
}

export async function decodeExpenseDetail(response: Response): Promise<HrExpenseClaimResponse> {
  const value = await body(response, response.status === 200);
  try {
    const detail = parseHrExpenseClaimResponse(value);
    if (!detail.accessScope || !detail.history) throw 0;
    return detail;
  } catch {
    throw new ExpenseUiError("operational_error");
  }
}

export async function decodeExpenseMutation(
  response: Response,
  operation: ExpenseAction["operation"],
): Promise<HrExpenseClaimResponse> {
  const replay = response.headers.get("idempotent-replayed");
  const valid =
    operation === "create"
      ? (response.status === 201 && replay === "false") ||
        (response.status === 200 && replay === "true")
      : response.status === 200 && (replay === "false" || replay === "true");
  const value = await body(response, valid);
  try {
    const result = parseHrExpenseClaimResponse(value);
    if (result.accessScope !== undefined || result.history !== undefined) throw 0;
    return result;
  } catch {
    throw new ExpenseUiError("operational_error");
  }
}

function date(value: unknown): string {
  if (typeof value !== "string" || !DATE.test(value)) throw 0;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw 0;
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string") throw 0;
  const match = RFC3339.exec(value);
  if (!match || date(`${match[1]}-${match[2]}-${match[3]}`) === "") throw 0;
  if (!Number.isFinite(Date.parse(value))) throw 0;
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw 0;
  return value.toLowerCase();
}
function positive(value: unknown, maximum = MAX_INTEGER): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) throw 0;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected > maximum) throw 0;
  return selected;
}
function exact(value: Readonly<Record<string, string>>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw 0;
}
function expected(value: Readonly<Record<string, string>>): ExpectedBody {
  return {
    expectedExpenseClaimVersionId: uuid(value.expectedExpenseClaimVersionId),
    expectedRootVersion: positive(value.expectedRootVersion),
    expectedVersion: positive(value.expectedVersion),
  };
}
function note(value: unknown, maximum: number): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") throw 0;
  const selected = value.trim();
  if (selected.length < 1) return null;
  if (selected.length > maximum) throw 0;
  return selected;
}
function failure(): ExpenseActionValidation {
  return { ok: false, state: expenseStateForError(new ExpenseUiError("validation", 400)) };
}

export function validateExpenseAction(
  value: Readonly<Record<string, string>>,
): ExpenseActionValidation {
  try {
    const operation = value.operation;
    const idempotencyKey = uuid(value.idempotencyKey);
    if (operation === "create") {
      exact(value, new Set(["currencyCode", "idempotencyKey", "operation"]));
      const currencyCode = value.currencyCode;
      if (typeof currencyCode !== "string" || !CURRENCIES.has(currencyCode)) throw 0;
      return {
        ok: true,
        value: { body: { currencyCode }, idempotencyKey, operation },
      };
    }
    if (operation !== "edit_draft" && operation !== "submit") {
      return failure();
    }
    const expenseClaimId = uuid(value.expenseClaimId);
    const common = new Set([
      "expenseClaimId",
      "expectedExpenseClaimVersionId",
      "expectedRootVersion",
      "expectedVersion",
      "idempotencyKey",
      "operation",
    ]);
    const expectedBody = expected(value);
    if (operation === "edit_draft") {
      const indexes = new Set<number>();
      for (const key of Object.keys(value)) {
        if (common.has(key)) continue;
        const match = LINE_FIELD.exec(key);
        if (!match || Number(match[2]) > 49) throw 0;
        indexes.add(Number(match[2]));
      }
      const lineKeys = Object.keys(value).filter((key) => LINE_FIELD.test(key));
      exact(value, new Set([...common, ...lineKeys]));
      const lines = [...indexes]
        .sort((left, right) => left - right)
        .flatMap((index) => {
          const expenseDate = value[`expenseDate_${index}`]?.trim() ?? "";
          const categoryCode = value[`categoryCode_${index}`]?.trim() ?? "";
          const amountMinor = value[`amountMinor_${index}`]?.trim() ?? "";
          const description = value[`description_${index}`]?.trim() ?? "";
          if (!expenseDate && !categoryCode && !amountMinor && !description) return [];
          if (!/^[^\s,]{1,64}$/.test(categoryCode)) throw 0;
          const expenseLineId = value[`expenseLineId_${index}`]?.trim() ?? "";
          const lineVersion = value[`lineVersion_${index}`]?.trim() ?? "";
          if (!expenseLineId !== !lineVersion) throw 0;
          return [
            {
              amountMinor: positive(amountMinor),
              categoryCode,
              description: note(description, 500),
              expenseDate: date(expenseDate),
              ...(expenseLineId
                ? { expectedVersion: positive(lineVersion), expenseLineId: uuid(expenseLineId) }
                : {}),
            },
          ];
        });
      return {
        ok: true,
        value: {
          body: { ...expectedBody, lines },
          expenseClaimId,
          idempotencyKey,
          operation,
        },
      };
    }
    exact(value, common);
    return {
      ok: true,
      value: { body: expectedBody, expenseClaimId, idempotencyKey, operation },
    };
  } catch {
    return failure();
  }
}

export function buildOwnExpensePath(search: Search): string {
  try {
    const query = new URLSearchParams();
    const createdAtPresent = Object.hasOwn(search, "cursorCreatedAt");
    const expenseClaimIdPresent = Object.hasOwn(search, "cursorExpenseClaimId");
    if (createdAtPresent !== expenseClaimIdPresent) throw 0;
    if (createdAtPresent) {
      query.set("cursorCreatedAt", timestamp(search.cursorCreatedAt));
      query.set("cursorExpenseClaimId", uuid(search.cursorExpenseClaimId));
    }
    return `/v1/hr/expense-claims/own${query.size ? `?${query}` : ""}`;
  } catch {
    throw new ExpenseUiError("validation", 400);
  }
}

export function buildExpenseDetailPath(expenseClaimId: string, search: Search): string {
  try {
    const query = new URLSearchParams();
    const versionIdPresent = Object.hasOwn(search, "cursorExpenseClaimVersionId");
    const versionPresent = Object.hasOwn(search, "cursorVersion");
    if (versionIdPresent !== versionPresent) throw 0;
    if (versionIdPresent) {
      query.set("cursorExpenseClaimVersionId", uuid(search.cursorExpenseClaimVersionId));
      query.set("cursorVersion", String(positive(search.cursorVersion)));
    }
    return `/v1/hr/expense-claims/by-id/${uuid(expenseClaimId)}${query.size ? `?${query}` : ""}`;
  } catch {
    throw new ExpenseUiError("validation", 400);
  }
}
