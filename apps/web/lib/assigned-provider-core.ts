import type {
  HrExpenseClaimAssignedCursor,
  HrExpenseClaimListResponse,
} from "@esbla/contracts/hr-expense-claim-api";
import type {
  HrAssignedLeaveRequestPage,
  HrLeaveRequestCursor,
} from "@esbla/contracts/hr-leave-api";
import type {
  HrTimesheetAssignedCursor,
  HrTimesheetListResponse,
} from "@esbla/contracts/hr-timesheet-api";
import type {
  AssignedWorkspaceTaskPage,
  WorkspaceTaskCursor,
} from "@esbla/contracts/workspace-task-api";

type AssignedTimesheetPage = Extract<HrTimesheetListResponse, { readonly kind: "assigned" }>;
type AssignedExpensePage = Extract<HrExpenseClaimListResponse, { readonly kind: "assigned" }>;

export type AssignedProvider =
  | "hr_expense_assigned"
  | "hr_leave_assigned"
  | "hr_timesheet_assigned"
  | "workspace_task_assigned";
export type AssignedProviderUnavailableReason = "inactive" | "ineligible";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export class AssignedProviderUnavailableError extends Error {
  readonly provider: AssignedProvider;
  readonly reason: AssignedProviderUnavailableReason;

  constructor(provider: AssignedProvider, reason: AssignedProviderUnavailableReason) {
    if (
      ![
        "hr_expense_assigned",
        "hr_leave_assigned",
        "hr_timesheet_assigned",
        "workspace_task_assigned",
      ].includes(provider) ||
      (reason !== "inactive" && reason !== "ineligible") ||
      (provider === "workspace_task_assigned" && reason !== "inactive")
    ) {
      throw new TypeError("Assigned-work unavailability is invalid");
    }
    super("The assigned-work section is unavailable");
    this.name = "AssignedProviderUnavailableError";
    this.provider = provider;
    this.reason = reason;
  }
}

export class AssignedProviderCursorError extends Error {
  readonly provider: AssignedProvider;

  constructor(provider: AssignedProvider) {
    super("The assigned-work cursor is invalid");
    this.name = "AssignedProviderCursorError";
    this.provider = provider;
  }
}

export type AssignedProviderSearchParams = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

export interface AssignedProviderCursors {
  readonly expense: HrExpenseClaimAssignedCursor | undefined;
  readonly hr: HrLeaveRequestCursor | undefined;
  readonly timesheet: HrTimesheetAssignedCursor | undefined;
  readonly workspace: WorkspaceTaskCursor | undefined;
}

export type AssignedProviderState<Page> =
  | { readonly empty: boolean; readonly page: Page; readonly unavailable: false }
  | { readonly unavailable: true };

export interface AssignedProviderViewModel {
  readonly expense: AssignedProviderState<AssignedExpensePage>;
  readonly hr: AssignedProviderState<HrAssignedLeaveRequestPage>;
  readonly nextApprovalsHref: string | null;
  readonly nextExpensesHref: string | null;
  readonly nextTasksHref: string | null;
  readonly nextTimesheetsHref: string | null;
  readonly queuesClear: boolean;
  readonly startOverHref: string | null;
  readonly timesheet: AssignedProviderState<AssignedTimesheetPage>;
  readonly totalShown: number;
  readonly workspace: AssignedProviderState<AssignedWorkspaceTaskPage>;
}

export interface LoadAssignedProviderViewOptions {
  readonly loadExpense: (
    cursor: HrExpenseClaimAssignedCursor | undefined,
  ) => Promise<AssignedExpensePage>;
  readonly loadHr: (
    cursor: HrLeaveRequestCursor | undefined,
  ) => Promise<HrAssignedLeaveRequestPage>;
  readonly loadTimesheet: (
    cursor: HrTimesheetAssignedCursor | undefined,
  ) => Promise<AssignedTimesheetPage>;
  readonly loadWorkspace: (
    cursor: WorkspaceTaskCursor | undefined,
  ) => Promise<AssignedWorkspaceTaskPage>;
  readonly searchParams: AssignedProviderSearchParams;
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isGregorianDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function isStrictTimestamp(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  if (!isGregorianDate(Number(match[1]), Number(match[2]), Number(match[3]))) return false;
  return Number.isFinite(Date.parse(value));
}

function validateHrCursor(value: unknown): HrLeaveRequestCursor {
  if (
    typeof value !== "object" ||
    value === null ||
    !("leaveRequestId" in value) ||
    !("submittedAt" in value) ||
    typeof value.leaveRequestId !== "string" ||
    typeof value.submittedAt !== "string" ||
    !UUID_PATTERN.test(value.leaveRequestId) ||
    !isStrictTimestamp(value.submittedAt)
  ) {
    throw new AssignedProviderCursorError("hr_leave_assigned");
  }
  return { leaveRequestId: value.leaveRequestId, submittedAt: value.submittedAt };
}

function validateWorkspaceCursor(value: unknown): WorkspaceTaskCursor {
  if (
    typeof value !== "object" ||
    value === null ||
    !("taskId" in value) ||
    !("createdAt" in value) ||
    typeof value.taskId !== "string" ||
    typeof value.createdAt !== "string" ||
    !UUID_PATTERN.test(value.taskId) ||
    !isStrictTimestamp(value.createdAt)
  ) {
    throw new AssignedProviderCursorError("workspace_task_assigned");
  }
  return { createdAt: value.createdAt, taskId: value.taskId };
}

function validateTimesheetCursor(value: unknown): HrTimesheetAssignedCursor {
  if (
    typeof value !== "object" ||
    value === null ||
    !("submittedAt" in value) ||
    !("timesheetVersionId" in value) ||
    typeof value.submittedAt !== "string" ||
    typeof value.timesheetVersionId !== "string" ||
    !isStrictTimestamp(value.submittedAt) ||
    !UUID_PATTERN.test(value.timesheetVersionId)
  ) {
    throw new AssignedProviderCursorError("hr_timesheet_assigned");
  }
  return {
    submittedAt: value.submittedAt,
    timesheetVersionId: value.timesheetVersionId,
  };
}

function validateExpenseCursor(value: unknown): HrExpenseClaimAssignedCursor {
  if (
    typeof value !== "object" ||
    value === null ||
    !("expenseClaimVersionId" in value) ||
    !("submittedAt" in value) ||
    typeof value.expenseClaimVersionId !== "string" ||
    typeof value.submittedAt !== "string" ||
    !UUID_PATTERN.test(value.expenseClaimVersionId) ||
    !isStrictTimestamp(value.submittedAt)
  ) {
    throw new AssignedProviderCursorError("hr_expense_assigned");
  }
  return {
    expenseClaimVersionId: value.expenseClaimVersionId,
    submittedAt: value.submittedAt,
  };
}

function parseHrCursor(
  searchParams: AssignedProviderSearchParams,
): HrLeaveRequestCursor | undefined {
  const idPresent = hasOwn(searchParams, "cursorLeaveRequestId");
  const timestampPresent = hasOwn(searchParams, "cursorSubmittedAt");
  if (!idPresent && !timestampPresent) return undefined;
  if (!idPresent || !timestampPresent) {
    throw new AssignedProviderCursorError("hr_leave_assigned");
  }
  return validateHrCursor({
    leaveRequestId: searchParams.cursorLeaveRequestId,
    submittedAt: searchParams.cursorSubmittedAt,
  });
}

function parseWorkspaceCursor(
  searchParams: AssignedProviderSearchParams,
): WorkspaceTaskCursor | undefined {
  const idPresent = hasOwn(searchParams, "cursorTaskId");
  const timestampPresent = hasOwn(searchParams, "cursorCreatedAt");
  if (!idPresent && !timestampPresent) return undefined;
  if (!idPresent || !timestampPresent) {
    throw new AssignedProviderCursorError("workspace_task_assigned");
  }
  return validateWorkspaceCursor({
    createdAt: searchParams.cursorCreatedAt,
    taskId: searchParams.cursorTaskId,
  });
}

function parseTimesheetCursor(
  searchParams: AssignedProviderSearchParams,
): HrTimesheetAssignedCursor | undefined {
  const idPresent = hasOwn(searchParams, "cursorTimesheetVersionId");
  const timestampPresent = hasOwn(searchParams, "cursorTimesheetSubmittedAt");
  if (!idPresent && !timestampPresent) return undefined;
  if (!idPresent || !timestampPresent) {
    throw new AssignedProviderCursorError("hr_timesheet_assigned");
  }
  return validateTimesheetCursor({
    submittedAt: searchParams.cursorTimesheetSubmittedAt,
    timesheetVersionId: searchParams.cursorTimesheetVersionId,
  });
}

function parseExpenseCursor(
  searchParams: AssignedProviderSearchParams,
): HrExpenseClaimAssignedCursor | undefined {
  const idPresent = hasOwn(searchParams, "cursorExpenseClaimVersionId");
  const timestampPresent = hasOwn(searchParams, "cursorExpenseSubmittedAt");
  if (!idPresent && !timestampPresent) return undefined;
  if (!idPresent || !timestampPresent) {
    throw new AssignedProviderCursorError("hr_expense_assigned");
  }
  return validateExpenseCursor({
    expenseClaimVersionId: searchParams.cursorExpenseClaimVersionId,
    submittedAt: searchParams.cursorExpenseSubmittedAt,
  });
}

export function parseAssignedProviderCursors(
  searchParams: AssignedProviderSearchParams,
): AssignedProviderCursors {
  let expense: HrExpenseClaimAssignedCursor | undefined;
  let hr: HrLeaveRequestCursor | undefined;
  let timesheet: HrTimesheetAssignedCursor | undefined;
  let workspace: WorkspaceTaskCursor | undefined;
  let expenseError: unknown;
  let hrError: unknown;
  let timesheetError: unknown;
  let workspaceError: unknown;

  try {
    hr = parseHrCursor(searchParams);
  } catch (error) {
    hrError = error;
  }
  try {
    workspace = parseWorkspaceCursor(searchParams);
  } catch (error) {
    workspaceError = error;
  }
  try {
    timesheet = parseTimesheetCursor(searchParams);
  } catch (error) {
    timesheetError = error;
  }
  try {
    expense = parseExpenseCursor(searchParams);
  } catch (error) {
    expenseError = error;
  }

  if (hrError !== undefined) throw hrError;
  if (workspaceError !== undefined) throw workspaceError;
  if (timesheetError !== undefined) throw timesheetError;
  if (expenseError !== undefined) throw expenseError;
  return Object.freeze({ expense, hr, timesheet, workspace });
}

type Settlement<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly reason: unknown; readonly status: "rejected" };

function settle<Value>(loader: () => Promise<Value>): Promise<Settlement<Value>> {
  return Promise.resolve()
    .then(loader)
    .then(
      (value) => ({ status: "fulfilled", value }) as const,
      (reason: unknown) => ({ reason, status: "rejected" }) as const,
    );
}

function classifySettlement<Page extends { readonly items: readonly unknown[] }>(
  settlement: Settlement<Page>,
  provider: AssignedProvider,
  validatePage: (page: Page) => void,
): AssignedProviderState<Page> {
  if (settlement.status === "fulfilled") {
    validatePage(settlement.value);
    return Object.freeze({
      empty: settlement.value.items.length === 0,
      page: settlement.value,
      unavailable: false,
    });
  }
  if (
    settlement.reason instanceof AssignedProviderUnavailableError &&
    settlement.reason.provider === provider
  ) {
    return Object.freeze({ unavailable: true });
  }
  throw settlement.reason;
}

function validateHrPage(page: HrAssignedLeaveRequestPage): void {
  if (page.nextCursor !== null) validateHrCursor(page.nextCursor);
}

function validateWorkspacePage(page: AssignedWorkspaceTaskPage): void {
  if (page.nextCursor !== null) validateWorkspaceCursor(page.nextCursor);
}

function validateTimesheetPage(page: AssignedTimesheetPage): void {
  if (page.nextCursor !== null) validateTimesheetCursor(page.nextCursor);
}

function validateExpensePage(page: AssignedExpensePage): void {
  if (page.nextCursor !== null) validateExpenseCursor(page.nextCursor);
}

function myWorkHref(
  hr: HrLeaveRequestCursor | undefined,
  timesheet: HrTimesheetAssignedCursor | undefined,
  expense: HrExpenseClaimAssignedCursor | undefined,
  workspace: WorkspaceTaskCursor | undefined,
): string {
  const parameters = new URLSearchParams();
  if (hr) {
    parameters.set("cursorLeaveRequestId", hr.leaveRequestId);
    parameters.set("cursorSubmittedAt", hr.submittedAt);
  }
  if (workspace) {
    parameters.set("cursorCreatedAt", workspace.createdAt);
    parameters.set("cursorTaskId", workspace.taskId);
  }
  if (timesheet) {
    parameters.set("cursorTimesheetSubmittedAt", timesheet.submittedAt);
    parameters.set("cursorTimesheetVersionId", timesheet.timesheetVersionId);
  }
  if (expense) {
    parameters.set("cursorExpenseClaimVersionId", expense.expenseClaimVersionId);
    parameters.set("cursorExpenseSubmittedAt", expense.submittedAt);
  }
  return `/workspace/my-work?${parameters.toString()}`;
}

export async function loadAssignedProviderView(
  options: LoadAssignedProviderViewOptions,
): Promise<AssignedProviderViewModel> {
  const cursors = parseAssignedProviderCursors(options.searchParams);
  const hrSettlementPromise = settle(() => options.loadHr(cursors.hr));
  const workspaceSettlementPromise = settle(() => options.loadWorkspace(cursors.workspace));
  const timesheetSettlementPromise = settle(() => options.loadTimesheet(cursors.timesheet));
  const expenseSettlementPromise = settle(() => options.loadExpense(cursors.expense));
  const [hrSettlement, workspaceSettlement, timesheetSettlement, expenseSettlement] =
    await Promise.all([
      hrSettlementPromise,
      workspaceSettlementPromise,
      timesheetSettlementPromise,
      expenseSettlementPromise,
    ]);

  const hr = classifySettlement(hrSettlement, "hr_leave_assigned", validateHrPage);
  const workspace = classifySettlement(
    workspaceSettlement,
    "workspace_task_assigned",
    validateWorkspacePage,
  );
  const timesheet = classifySettlement(
    timesheetSettlement,
    "hr_timesheet_assigned",
    validateTimesheetPage,
  );
  const expense = classifySettlement(expenseSettlement, "hr_expense_assigned", validateExpensePage);

  const expenseCount = expense.unavailable ? 0 : expense.page.items.length;
  const hrCount = hr.unavailable ? 0 : hr.page.items.length;
  const workspaceCount = workspace.unavailable ? 0 : workspace.page.items.length;
  const timesheetCount = timesheet.unavailable ? 0 : timesheet.page.items.length;
  const nextApprovalsHref =
    !hr.unavailable && hr.page.nextCursor
      ? myWorkHref(
          hr.page.nextCursor,
          timesheet.unavailable ? undefined : cursors.timesheet,
          expense.unavailable ? undefined : cursors.expense,
          workspace.unavailable ? undefined : cursors.workspace,
        )
      : null;
  const nextTasksHref =
    !workspace.unavailable && workspace.page.nextCursor
      ? myWorkHref(
          hr.unavailable ? undefined : cursors.hr,
          timesheet.unavailable ? undefined : cursors.timesheet,
          expense.unavailable ? undefined : cursors.expense,
          workspace.page.nextCursor,
        )
      : null;
  const nextTimesheetsHref =
    !timesheet.unavailable && timesheet.page.nextCursor
      ? myWorkHref(
          hr.unavailable ? undefined : cursors.hr,
          timesheet.page.nextCursor,
          expense.unavailable ? undefined : cursors.expense,
          workspace.unavailable ? undefined : cursors.workspace,
        )
      : null;
  const nextExpensesHref =
    !expense.unavailable && expense.page.nextCursor
      ? myWorkHref(
          hr.unavailable ? undefined : cursors.hr,
          timesheet.unavailable ? undefined : cursors.timesheet,
          expense.page.nextCursor,
          workspace.unavailable ? undefined : cursors.workspace,
        )
      : null;
  const hasAvailableCurrentCursor =
    (!hr.unavailable && cursors.hr !== undefined) ||
    (!workspace.unavailable && cursors.workspace !== undefined) ||
    (!timesheet.unavailable && cursors.timesheet !== undefined) ||
    (!expense.unavailable && cursors.expense !== undefined);

  return Object.freeze({
    expense,
    hr,
    nextApprovalsHref,
    nextExpensesHref,
    nextTasksHref,
    nextTimesheetsHref,
    queuesClear:
      !hr.unavailable &&
      !workspace.unavailable &&
      !timesheet.unavailable &&
      !expense.unavailable &&
      hrCount === 0 &&
      workspaceCount === 0 &&
      timesheetCount === 0 &&
      expenseCount === 0 &&
      cursors.hr === undefined &&
      cursors.workspace === undefined &&
      cursors.timesheet === undefined &&
      cursors.expense === undefined &&
      hr.page.nextCursor === null &&
      workspace.page.nextCursor === null &&
      timesheet.page.nextCursor === null &&
      expense.page.nextCursor === null,
    startOverHref: hasAvailableCurrentCursor ? "/workspace/my-work" : null,
    timesheet,
    totalShown: hrCount + workspaceCount + timesheetCount + expenseCount,
    workspace,
  });
}
