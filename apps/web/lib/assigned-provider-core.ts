import type {
  HrAssignedLeaveRequestPage,
  HrLeaveRequestCursor,
} from "@esbla/contracts/hr-leave-api";
import type {
  AssignedWorkspaceTaskPage,
  WorkspaceTaskCursor,
} from "@esbla/contracts/workspace-task-api";

export type AssignedProvider = "hr_leave_assigned" | "workspace_task_assigned";
export type AssignedProviderUnavailableReason = "inactive" | "ineligible";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export class AssignedProviderUnavailableError extends Error {
  readonly provider: AssignedProvider;
  readonly reason: AssignedProviderUnavailableReason;

  constructor(provider: AssignedProvider, reason: AssignedProviderUnavailableReason) {
    if (
      (provider !== "hr_leave_assigned" && provider !== "workspace_task_assigned") ||
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
  readonly hr: HrLeaveRequestCursor | undefined;
  readonly workspace: WorkspaceTaskCursor | undefined;
}

export type AssignedProviderState<Page> =
  | { readonly empty: boolean; readonly page: Page; readonly unavailable: false }
  | { readonly unavailable: true };

export interface AssignedProviderViewModel {
  readonly hr: AssignedProviderState<HrAssignedLeaveRequestPage>;
  readonly nextApprovalsHref: string | null;
  readonly nextTasksHref: string | null;
  readonly queuesClear: boolean;
  readonly startOverHref: string | null;
  readonly totalShown: number;
  readonly workspace: AssignedProviderState<AssignedWorkspaceTaskPage>;
}

export interface LoadAssignedProviderViewOptions {
  readonly loadHr: (
    cursor: HrLeaveRequestCursor | undefined,
  ) => Promise<HrAssignedLeaveRequestPage>;
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

export function parseAssignedProviderCursors(
  searchParams: AssignedProviderSearchParams,
): AssignedProviderCursors {
  let hr: HrLeaveRequestCursor | undefined;
  let workspace: WorkspaceTaskCursor | undefined;
  let hrError: unknown;
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

  if (hrError !== undefined) throw hrError;
  if (workspaceError !== undefined) throw workspaceError;
  return Object.freeze({ hr, workspace });
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

function myWorkHref(
  hr: HrLeaveRequestCursor | undefined,
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
  return `/workspace/my-work?${parameters.toString()}`;
}

export async function loadAssignedProviderView(
  options: LoadAssignedProviderViewOptions,
): Promise<AssignedProviderViewModel> {
  const cursors = parseAssignedProviderCursors(options.searchParams);
  const hrSettlementPromise = settle(() => options.loadHr(cursors.hr));
  const workspaceSettlementPromise = settle(() => options.loadWorkspace(cursors.workspace));
  const [hrSettlement, workspaceSettlement] = await Promise.all([
    hrSettlementPromise,
    workspaceSettlementPromise,
  ]);

  const hr = classifySettlement(hrSettlement, "hr_leave_assigned", validateHrPage);
  const workspace = classifySettlement(
    workspaceSettlement,
    "workspace_task_assigned",
    validateWorkspacePage,
  );

  const hrCount = hr.unavailable ? 0 : hr.page.items.length;
  const workspaceCount = workspace.unavailable ? 0 : workspace.page.items.length;
  const nextApprovalsHref =
    !hr.unavailable && hr.page.nextCursor
      ? myWorkHref(hr.page.nextCursor, workspace.unavailable ? undefined : cursors.workspace)
      : null;
  const nextTasksHref =
    !workspace.unavailable && workspace.page.nextCursor
      ? myWorkHref(hr.unavailable ? undefined : cursors.hr, workspace.page.nextCursor)
      : null;
  const hasAvailableCurrentCursor =
    (!hr.unavailable && cursors.hr !== undefined) ||
    (!workspace.unavailable && cursors.workspace !== undefined);

  return Object.freeze({
    hr,
    nextApprovalsHref,
    nextTasksHref,
    queuesClear:
      !hr.unavailable &&
      !workspace.unavailable &&
      hrCount === 0 &&
      workspaceCount === 0 &&
      cursors.hr === undefined &&
      cursors.workspace === undefined &&
      hr.page.nextCursor === null &&
      workspace.page.nextCursor === null,
    startOverHref: hasAvailableCurrentCursor ? "/workspace/my-work" : null,
    totalShown: hrCount + workspaceCount,
    workspace,
  });
}
