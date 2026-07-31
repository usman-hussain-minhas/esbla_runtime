import { randomUUID } from "node:crypto";
import type { PresentationWidgetDefinition, PresentationWidgetState } from "@esbla/contracts";
import { ArrowRight, List, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { LeaveApprovalAction } from "../../../../components/leave-approval-action";
import {
  AssignedProviderUnavailableError,
  loadAssignedProviderWidgetView,
} from "../../../../lib/assigned-provider-core";
import { loadOwnAttendance } from "../../../../lib/hr-attendance";
import { loadEmploymentList } from "../../../../lib/hr-employment-record";
import { getAssignedExpenseClaims, loadOwnExpenseClaims } from "../../../../lib/hr-expense-claim";
import { getAssignedLeaveRequests } from "../../../../lib/hr-leave-assigned-list";
import { buildHrLeaveDetailHref } from "../../../../lib/hr-leave-navigation-core";
import { loadOwnShifts } from "../../../../lib/hr-shift-assignment";
import { getAssignedTimesheets, loadOwnTimesheets } from "../../../../lib/hr-timesheet";
import { loadOwnWorkforceProfile } from "../../../../lib/hr-workforce-profile";
import { loadAuthorizedWorkforceList } from "../../../../lib/hr-workforce-profile-list";
import type { ResponsivePresentationWidgetPlacement } from "../../../../lib/presentation-layout-core";
import { buildRouteBackedWidgetHref } from "../../../../lib/route-backed-widget-navigation-core";
import { getAssignedWorkspaceTasks } from "../../../../lib/workspace-task-assigned-list";
import {
  getRegisteredSurfaceInstance,
  getWidgetDefinition,
  type SurfaceDefinition,
} from "../index";
import { SemanticIcon } from "../semantic-icons";
import { PresentationWidgetFrame, PresentationWidgetStateContent } from "./presentation-widget";

interface RepresentativeWidgetProps {
  readonly placement: ResponsivePresentationWidgetPlacement;
  readonly surfaceId: SurfaceDefinition["id"];
}

type FailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "empty"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";

interface FailureContent {
  readonly message: string;
  readonly title: string;
}

interface RegisteredWidget {
  readonly definition: PresentationWidgetDefinition;
  readonly fullScreenRoute: string;
  readonly placement: ResponsivePresentationWidgetPlacement;
}

function resolveRegisteredWidget(
  surfaceId: SurfaceDefinition["id"],
  placement: ResponsivePresentationWidgetPlacement,
  expectedDefinitionId?: string,
): RegisteredWidget {
  const registered = getRegisteredSurfaceInstance(surfaceId, placement.desktop.instanceId);
  const definition = getWidgetDefinition(
    registered.widgetDefinitionId,
    registered.widgetDefinitionVersion,
  );
  if (
    (expectedDefinitionId !== undefined && definition.id !== expectedDefinitionId) ||
    [placement.desktop, placement.tablet, placement.phone].some(
      (candidate) =>
        candidate.instanceId !== registered.instanceId ||
        candidate.widgetDefinitionId !== registered.widgetDefinitionId ||
        candidate.widgetDefinitionVersion !== registered.widgetDefinitionVersion,
    ) ||
    definition.fullScreenRoute === null
  ) {
    throw new Error("Representative widget registry binding is invalid");
  }
  return { definition, fullScreenRoute: definition.fullScreenRoute, placement };
}

function presentationStateForFailure(kind: FailureKind): PresentationWidgetState {
  if (kind === "denied") return "permission_denied";
  if (kind === "inactive") return "service_inactive";
  if (kind === "not_found") return "not_found";
  if (kind === "dependency_unavailable") return "unavailable";
  if (kind === "empty") return "empty";
  return "operational_error";
}

function WidgetFrame({
  children,
  definition,
  placement,
  state,
  surfaceId,
}: Readonly<{
  children: ReactNode;
  definition: PresentationWidgetDefinition;
  placement: ResponsivePresentationWidgetPlacement;
  state: PresentationWidgetState;
  surfaceId: SurfaceDefinition["id"];
}>) {
  const fullScreenControlId = `${placement.desktop.instanceId}.full-screen`;
  const fullScreenEligible =
    state !== "permission_denied" && state !== "service_inactive" && state !== "not_found";
  return (
    <PresentationWidgetFrame
      action={
        definition.fullScreenRoute && fullScreenEligible ? (
          <Link
            aria-label={`Open ${definition.displayName}`}
            className="icon-command"
            href={buildRouteBackedWidgetHref(
              definition.fullScreenRoute,
              surfaceId,
              fullScreenControlId,
            )}
            id={fullScreenControlId}
            title="Open full screen"
          >
            <List aria-hidden="true" size={16} />
          </Link>
        ) : undefined
      }
      definition={definition}
      leadingIcon={
        <SemanticIcon
          aria-hidden="true"
          semanticKey={definition.semanticIcon}
          size={18}
          strokeWidth={1.7}
        />
      }
      placement={placement}
      state={state}
    >
      {children}
    </PresentationWidgetFrame>
  );
}

function FailureState({
  content,
  definition,
  kind,
}: Readonly<{
  content: FailureContent;
  definition: PresentationWidgetDefinition;
  kind: FailureKind;
}>) {
  const state = presentationStateForFailure(kind);
  return (
    <PresentationWidgetStateContent
      description={content.message}
      heading={content.title}
      icon={
        <SemanticIcon
          aria-hidden="true"
          semanticKey={definition.semanticIcon}
          size={25}
          strokeWidth={1.6}
        />
      }
      state={state}
    />
  );
}

function EmptyState({
  definition,
  description,
  heading,
}: Readonly<{
  definition: PresentationWidgetDefinition;
  description: string;
  heading: string;
}>) {
  return (
    <PresentationWidgetStateContent
      description={description}
      heading={heading}
      icon={
        <SemanticIcon
          aria-hidden="true"
          semanticKey={definition.semanticIcon}
          size={25}
          strokeWidth={1.6}
        />
      }
      state="empty"
    />
  );
}

export function RepresentativeWidgetLoading({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement);
  return (
    <PresentationWidgetFrame
      definition={definition}
      leadingIcon={
        <SemanticIcon
          aria-hidden="true"
          semanticKey={definition.semanticIcon}
          size={18}
          strokeWidth={1.7}
        />
      }
      placement={placement}
      state="loading"
    >
      <PresentationWidgetStateContent
        description="Keep this surface open while the current authorized data is read."
        heading={`Loading ${definition.displayName.toLowerCase()}…`}
        state="loading"
      />
    </PresentationWidgetFrame>
  );
}

export async function WorkforceProfileWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "hr.workforce.my-profile");
  const result = await loadOwnWorkforceProfile();
  let state: PresentationWidgetState;
  let content: ReactNode;
  if (result.status === "success") {
    state = "populated";
    content = (
      <PresentationWidgetStateContent state="populated">
        <div className="zen-widget-summary">
          <span className="leave-status leave-status-active">Active</span>
          <strong>{result.profile.employeeNumber ?? "Employee number not assigned"}</strong>
          <p>
            {result.profile.principalLinked ? "Principal connected" : "Principal not connected"}
          </p>
          <Link
            className="text-command"
            href={`/workspace/hr/profile/by-id/${encodeURIComponent(
              result.profile.workerProfileId,
            )}?returnContext=own`}
          >
            View profile history
            <ArrowRight aria-hidden="true" size={15} />
          </Link>
        </div>
      </PresentationWidgetStateContent>
    );
  } else {
    state = presentationStateForFailure(result.status);
    content =
      result.status === "empty" ? (
        <EmptyState definition={definition} description={result.message} heading={result.title} />
      ) : (
        <FailureState
          content={{ message: result.message, title: result.title }}
          definition={definition}
          kind={result.status}
        />
      );
  }
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

function formatObservationInstant(value: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export async function AttendanceObservationsWidget({
  placement,
  surfaceId,
}: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(
    surfaceId,
    placement,
    "hr.attendance.my-observations",
  );
  const result = await loadOwnAttendance({ pageSize: "5" });
  const state =
    result.status === "success"
      ? result.page.items.length === 0
        ? "empty"
        : "populated"
      : presentationStateForFailure(result.kind);
  let content: ReactNode;
  if (result.status !== "success") {
    content = <FailureState content={result} definition={definition} kind={result.kind} />;
  } else if (result.page.items.length === 0) {
    content = (
      <EmptyState
        definition={definition}
        description="Recent authorized attendance observations will appear here."
        heading="No attendance observations"
      />
    );
  } else {
    content = (
      <PresentationWidgetStateContent state="populated">
        <ol aria-label="My attendance observations" className="zen-widget-list">
          {result.page.items.slice(0, 5).map((observation) => (
            <li key={observation.attendanceObservationId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/attendance/by-id/${encodeURIComponent(
                  observation.attendanceObservationId,
                )}?returnTo=own`}
              >
                <span className="leave-status leave-status-active">
                  {observation.observationKind === "presence_start" ? "Start" : "End"}
                </span>
                <span>
                  <strong>{formatObservationInstant(observation.observedAt)}</strong>
                  <p>
                    {observation.sourceKind === "manual" ? "Manual observation" : "Observation"}
                  </p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    );
  }
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

export async function ExpenseClaimsWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "hr.expense.mine");
  const result = await loadOwnExpenseClaims();
  const state =
    result.status === "success"
      ? result.page.items.length === 0
        ? "empty"
        : "populated"
      : presentationStateForFailure(result.kind);
  let content: ReactNode;
  if (result.status !== "success") {
    content = <FailureState content={result} definition={definition} kind={result.kind} />;
  } else if (result.page.items.length === 0) {
    content = (
      <EmptyState
        definition={definition}
        description="Draft and submitted expense claims will appear here."
        heading="No expense claims"
      />
    );
  } else {
    content = (
      <PresentationWidgetStateContent state="populated">
        <ol aria-label="My expense claims" className="zen-widget-list">
          {result.page.items.slice(0, 5).map((claim) => (
            <li key={claim.expenseClaimId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/expenses/by-id/${encodeURIComponent(
                  claim.expenseClaimId,
                )}?returnTo=own`}
              >
                <span className={`leave-status leave-status-${claim.status}`}>{claim.status}</span>
                <span>
                  <strong>
                    {new Intl.NumberFormat("en").format(claim.totalAmountMinor)}{" "}
                    {claim.currencyCode}
                  </strong>
                  <p>Minor units · version {claim.version}</p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    );
  }
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

export async function DirectReportsWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(
    surfaceId,
    placement,
    "hr.workforce.direct-reports",
  );
  const result = await loadAuthorizedWorkforceList({}, "direct_reports");
  const page =
    result.status === "success" && result.page.kind === "direct_reports" ? result.page : undefined;
  const state =
    result.status === "success"
      ? page === undefined
        ? "operational_error"
        : page.items.length === 0
          ? "empty"
          : "populated"
      : presentationStateForFailure(result.status);
  let content: ReactNode;
  if (page === undefined) {
    content =
      result.status === "success" ? (
        <FailureState
          content={{
            message: "The direct reports request could not be completed.",
            title: "Direct reports unavailable",
          }}
          definition={definition}
          kind="operational_error"
        />
      ) : (
        <FailureState
          content={{ message: result.message, title: result.title }}
          definition={definition}
          kind={result.status}
        />
      );
  } else if (page.items.length === 0) {
    content = (
      <EmptyState
        definition={definition}
        description="Current authorized reporting relationships will appear here."
        heading="No direct reports"
      />
    );
  } else {
    content = (
      <PresentationWidgetStateContent state="populated">
        <ol aria-label="Direct reports" className="zen-widget-list">
          {page.items.slice(0, 5).map(({ profile }) => (
            <li key={profile.workerProfileId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/profile/by-id/${encodeURIComponent(
                  profile.workerProfileId,
                )}?returnContext=direct-reports`}
              >
                <span className={`leave-status leave-status-${profile.workforceStatus}`}>
                  {profile.workforceStatus}
                </span>
                <span>
                  <strong>{profile.employeeNumber ?? "Employee number not assigned"}</strong>
                  <p>
                    {profile.principalLinked ? "Principal connected" : "Principal not connected"}
                  </p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    );
  }
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

export async function EmploymentFactsWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(
    surfaceId,
    placement,
    "hr.employment.current-facts",
  );
  const result = await loadEmploymentList({ pageSize: "5" });
  const state =
    result.status === "success"
      ? result.page.items.length === 0
        ? "empty"
        : "populated"
      : presentationStateForFailure(result.kind);
  let content: ReactNode;
  if (result.status !== "success") {
    content = <FailureState content={result} definition={definition} kind={result.kind} />;
  } else if (result.page.items.length === 0) {
    content = (
      <EmptyState
        definition={definition}
        description="No employment facts are available through your current authorized view."
        heading="No employment records"
      />
    );
  } else {
    content = (
      <PresentationWidgetStateContent state="populated">
        <ol aria-label="Current employment facts" className="zen-widget-list">
          {result.page.items.slice(0, 5).map((record) => (
            <li key={record.employmentRecordId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/employment/by-id/${encodeURIComponent(
                  record.employmentRecordId,
                )}`}
              >
                <span className={`leave-status leave-status-${record.status}`}>
                  {record.status}
                </span>
                <span>
                  <strong>{record.currentVersion?.positionReference ?? "Employment record"}</strong>
                  <p>
                    {record.currentVersion
                      ? `${record.currentVersion.effectiveFrom}–${
                          record.currentVersion.effectiveTo ?? "present"
                        }`
                      : "No effective version"}
                  </p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    );
  }
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

async function workforceQueueContent(
  definition: PresentationWidgetDefinition,
  status: "active" | "draft" | "terminated",
): Promise<Readonly<{ content: ReactNode; state: PresentationWidgetState }>> {
  const result = await loadAuthorizedWorkforceList({ status }, "workforce");
  const page =
    result.status === "success" && result.page.kind === "workforce" ? result.page : undefined;
  if (!page) {
    return {
      content:
        result.status === "success" ? (
          <FailureState
            content={{
              message: "The workforce queue could not be completed.",
              title: "Workforce queue unavailable",
            }}
            definition={definition}
            kind="operational_error"
          />
        ) : (
          <FailureState
            content={{ message: result.message, title: result.title }}
            definition={definition}
            kind={result.status}
          />
        ),
      state:
        result.status === "success"
          ? "operational_error"
          : presentationStateForFailure(result.status),
    };
  }
  if (page.items.length === 0) {
    return {
      content: (
        <EmptyState
          definition={definition}
          description={`No ${status} workforce profiles require attention.`}
          heading={`No ${status} profiles`}
        />
      ),
      state: "empty",
    };
  }
  return {
    content: (
      <PresentationWidgetStateContent state="populated">
        <ol aria-label={`${status} workforce profiles`} className="zen-widget-list">
          {page.items.slice(0, 5).map((profile) => (
            <li key={profile.workerProfileId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/profile/by-id/${encodeURIComponent(
                  profile.workerProfileId,
                )}?returnContext=admin`}
              >
                <span className={`leave-status leave-status-${profile.workforceStatus}`}>
                  {profile.workforceStatus}
                </span>
                <span>
                  <strong>{profile.employeeNumber ?? "Employee number not assigned"}</strong>
                  <p>
                    {profile.principalLinked ? "Principal connected" : "Principal not connected"}
                  </p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    ),
    state: "populated",
  };
}

export async function WorkforceAdminQueueWidget({
  placement,
  surfaceId,
}: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "hr.workforce.admin-queue");
  const { content, state } = await workforceQueueContent(definition, "draft");
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

export async function WorkforceStatusReportingWidget({
  placement,
  surfaceId,
}: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(
    surfaceId,
    placement,
    "hr.workforce.status-reporting",
  );
  const results = await Promise.all(
    (["active", "draft", "terminated"] as const).map(async (status) => ({
      result: await loadAuthorizedWorkforceList({ status }, "workforce"),
      status,
    })),
  );
  const failure = results.find(
    ({ result }) => result.status !== "success" || result.page.kind !== "workforce",
  );
  if (failure) {
    const result = failure.result;
    const kind = result.status === "success" ? "operational_error" : result.status;
    return (
      <WidgetFrame
        definition={definition}
        placement={placement}
        state={presentationStateForFailure(kind)}
        surfaceId={surfaceId}
      >
        <FailureState
          content={
            result.status === "success"
              ? {
                  message: "The bounded workforce status snapshot could not be completed.",
                  title: "Workforce status unavailable",
                }
              : { message: result.message, title: result.title }
          }
          definition={definition}
          kind={kind}
        />
      </WidgetFrame>
    );
  }
  const summaries = results.map(({ result, status }) => {
    if (result.status !== "success" || result.page.kind !== "workforce") {
      throw new Error("Workforce status registry binding is invalid");
    }
    return {
      count: result.page.items.length,
      hasMore: result.page.nextCursor !== null,
      status,
    };
  });
  const empty = summaries.every(({ count }) => count === 0);
  return (
    <WidgetFrame
      definition={definition}
      placement={placement}
      state={empty ? "empty" : "populated"}
      surfaceId={surfaceId}
    >
      {empty ? (
        <EmptyState
          definition={definition}
          description="No workforce profiles are available through the current authorized view."
          heading="No workforce status data"
        />
      ) : (
        <PresentationWidgetStateContent state="populated">
          <dl className="zen-widget-summary">
            {summaries.map(({ count, hasMore, status }) => (
              <div key={status}>
                <dt>{status}</dt>
                <dd>{hasMore ? `${count}+` : count}</dd>
              </div>
            ))}
          </dl>
        </PresentationWidgetStateContent>
      )}
    </WidgetFrame>
  );
}

async function employmentListWidget(
  definition: PresentationWidgetDefinition,
  mode: "admin" | "history",
): Promise<Readonly<{ content: ReactNode; state: PresentationWidgetState }>> {
  const result = await loadEmploymentList({ pageSize: "5" });
  if (result.status !== "success") {
    return {
      content: <FailureState content={result} definition={definition} kind={result.kind} />,
      state: presentationStateForFailure(result.kind),
    };
  }
  if (result.page.items.length === 0) {
    return {
      content: (
        <EmptyState
          definition={definition}
          description={
            mode === "admin"
              ? "No employment records are available for administration."
              : "Employment history will appear after an authorized record exists."
          }
          heading={
            mode === "admin" ? "No employment administration queue" : "No employment history"
          }
        />
      ),
      state: "empty",
    };
  }
  return {
    content: (
      <PresentationWidgetStateContent state="populated">
        <ol
          aria-label={mode === "admin" ? "Employment administration queue" : "Employment history"}
          className="zen-widget-list"
        >
          {result.page.items.slice(0, 5).map((record) => (
            <li key={record.employmentRecordId}>
              <Link
                className="zen-widget-row"
                href={
                  mode === "admin"
                    ? "/workspace/hr/employment/admin"
                    : `/workspace/hr/employment/by-id/${encodeURIComponent(
                        record.employmentRecordId,
                      )}`
                }
              >
                <span className={`leave-status leave-status-${record.status}`}>
                  {record.status}
                </span>
                <span>
                  <strong>{record.currentVersion?.positionReference ?? "Employment record"}</strong>
                  <p>
                    {record.currentVersion
                      ? `${record.currentVersion.effectiveFrom}–${
                          record.currentVersion.effectiveTo ?? "present"
                        }`
                      : "No effective version"}
                  </p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    ),
    state: "populated",
  };
}

export async function EmploymentAdminQueueWidget({
  placement,
  surfaceId,
}: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "hr.employment.admin-queue");
  const { content, state } = await employmentListWidget(definition, "admin");
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

export async function EmploymentHistoryWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "hr.employment.history");
  const { content, state } = await employmentListWidget(definition, "history");
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

export async function WorkspaceTasksWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "workspace.tasks.mine");
  let page: Awaited<ReturnType<typeof getAssignedWorkspaceTasks>>;
  try {
    page = await getAssignedWorkspaceTasks();
  } catch (error) {
    const inactive = error instanceof AssignedProviderUnavailableError;
    return (
      <WidgetFrame
        definition={definition}
        placement={placement}
        state={inactive ? "service_inactive" : "unavailable"}
        surfaceId={surfaceId}
      >
        <FailureState
          content={{
            message: inactive
              ? "Workspace Tasks is not active for this tenant."
              : "Assigned tasks could not be loaded. No private error detail is shown.",
            title: inactive ? "Workspace Tasks inactive" : "Tasks unavailable",
          }}
          definition={definition}
          kind={inactive ? "inactive" : "dependency_unavailable"}
        />
      </WidgetFrame>
    );
  }
  const items = page.items.slice(0, 5);
  return (
    <WidgetFrame
      definition={definition}
      placement={placement}
      state={items.length === 0 ? "empty" : "populated"}
      surfaceId={surfaceId}
    >
      {items.length === 0 ? (
        <EmptyState
          definition={definition}
          description="Tasks assigned to you will appear here."
          heading="No assigned tasks"
        />
      ) : (
        <PresentationWidgetStateContent state="populated">
          <ol aria-label="My assigned tasks" className="zen-widget-list">
            {items.map((item) => (
              <li key={item.workItemId}>
                <Link className="zen-widget-row" href="/workspace/tasks">
                  <span className="leave-status leave-status-submitted">Task</span>
                  <span>
                    <strong>{item.title}</strong>
                    <p>{item.dueOn ? `Due ${item.dueOn}` : item.createdByDisplayName}</p>
                  </span>
                  <ArrowRight aria-hidden="true" size={15} />
                </Link>
              </li>
            ))}
          </ol>
        </PresentationWidgetStateContent>
      )}
    </WidgetFrame>
  );
}

function formatShiftInstant(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en", {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export async function PublishedShiftsWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "hr.shift.my-published");
  const result = await loadOwnShifts({ pageSize: "5" });
  const state =
    result.status === "success"
      ? result.page.items.length === 0
        ? "empty"
        : "populated"
      : presentationStateForFailure(result.kind);
  let content: ReactNode;
  if (result.status !== "success") {
    content = <FailureState content={result} definition={definition} kind={result.kind} />;
  } else if (result.page.items.length === 0) {
    content = (
      <EmptyState
        definition={definition}
        description="Published assignments in your current bounded period will appear here."
        heading="No published shifts"
      />
    );
  } else {
    content = (
      <PresentationWidgetStateContent state="populated">
        <ol aria-label="My published shifts" className="zen-widget-list">
          {result.page.items.slice(0, 5).map((shift) => (
            <li key={shift.shiftAssignmentId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/shifts/by-id/${encodeURIComponent(
                  shift.shiftAssignmentId,
                )}?returnTo=own`}
              >
                <span className="leave-status leave-status-active">Published</span>
                <span>
                  <strong>{formatShiftInstant(shift.startsAt, shift.ianaTimezone)}</strong>
                  <p>Until {formatShiftInstant(shift.endsAt, shift.ianaTimezone)}</p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    );
  }
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

function formatMinutes(value: number): string {
  return `${Math.floor(value / 60)}h ${value % 60}m`;
}

export async function TimesheetsWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "hr.timesheet.mine");
  const result = await loadOwnTimesheets({ pageSize: "5" });
  const state =
    result.status === "success"
      ? result.page.items.length === 0
        ? "empty"
        : "populated"
      : presentationStateForFailure(result.kind);
  let content: ReactNode;
  if (result.status !== "success") {
    content = <FailureState content={result} definition={definition} kind={result.kind} />;
  } else if (result.page.items.length === 0) {
    content = (
      <EmptyState
        definition={definition}
        description="Use the full-screen form to create a weekly draft under current service rules."
        heading="No Timesheets yet"
      />
    );
  } else {
    content = (
      <PresentationWidgetStateContent state="populated">
        <ol aria-label="My Timesheets" className="zen-widget-list">
          {result.page.items.slice(0, 5).map((timesheet) => (
            <li key={timesheet.timesheetId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/timesheets/by-id/${encodeURIComponent(
                  timesheet.timesheetId,
                )}?returnTo=own`}
              >
                <span className={`leave-status leave-status-${timesheet.status}`}>
                  {timesheet.status}
                </span>
                <span>
                  <strong>
                    {timesheet.periodStart}–{timesheet.periodEnd}
                  </strong>
                  <p>{formatMinutes(timesheet.totalMinutes)}</p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    );
  }
  return (
    <WidgetFrame definition={definition} placement={placement} state={state} surfaceId={surfaceId}>
      {content}
    </WidgetFrame>
  );
}

export async function MyWorkWidget({ placement, surfaceId }: RepresentativeWidgetProps) {
  const { definition } = resolveRegisteredWidget(surfaceId, placement, "platform.my-work.queue");
  let view: Awaited<ReturnType<typeof loadAssignedProviderWidgetView>>;
  try {
    view = await loadAssignedProviderWidgetView({
      loadExpense: (cursor, signal) => getAssignedExpenseClaims(cursor, signal),
      loadHr: (cursor, signal) => getAssignedLeaveRequests(cursor, signal),
      loadTimesheet: (cursor, signal) => getAssignedTimesheets(cursor, signal),
      loadWorkspace: (cursor, signal) => getAssignedWorkspaceTasks(cursor, signal),
      searchParams: {},
    });
  } catch {
    return (
      <WidgetFrame
        definition={definition}
        placement={placement}
        state="unavailable"
        surfaceId={surfaceId}
      >
        <PresentationWidgetStateContent
          description="Assigned work could not be loaded. No private error detail is shown."
          heading="My Work unavailable"
          icon={<TriangleAlert aria-hidden="true" size={25} strokeWidth={1.6} />}
          state="unavailable"
        />
      </WidgetFrame>
    );
  }

  const unavailableCount = [view.hr, view.timesheet, view.expense, view.workspace].filter(
    ({ unavailable }) => unavailable,
  ).length;
  if (view.totalShown === 0) {
    const unavailable = unavailableCount > 0;
    return (
      <WidgetFrame
        definition={definition}
        placement={placement}
        state={unavailable ? "unavailable" : "empty"}
        surfaceId={surfaceId}
      >
        <PresentationWidgetStateContent
          description={
            unavailable
              ? "No assigned items are shown because one or more eligible providers are unavailable."
              : "Approvals and tasks waiting for your action will appear here."
          }
          heading={unavailable ? "Some work providers unavailable" : "Nothing needs your attention"}
          icon={
            <SemanticIcon
              aria-hidden="true"
              semanticKey={definition.semanticIcon}
              size={25}
              strokeWidth={1.6}
            />
          }
          state={unavailable ? "unavailable" : "empty"}
        />
      </WidgetFrame>
    );
  }

  let remaining = 5;
  const leaveItems = view.hr.unavailable ? [] : view.hr.page.items.slice(0, remaining);
  remaining -= leaveItems.length;
  const timesheetItems = view.timesheet.unavailable
    ? []
    : view.timesheet.page.items.slice(0, remaining);
  remaining -= timesheetItems.length;
  const expenseItems = view.expense.unavailable ? [] : view.expense.page.items.slice(0, remaining);
  remaining -= expenseItems.length;
  const taskItems = view.workspace.unavailable ? [] : view.workspace.page.items.slice(0, remaining);

  return (
    <WidgetFrame
      definition={definition}
      placement={placement}
      state="populated"
      surfaceId={surfaceId}
    >
      <PresentationWidgetStateContent state="populated">
        {unavailableCount > 0 ? (
          <p className="zen-widget-provider-notice">{unavailableCount} provider unavailable</p>
        ) : null}
        <ol aria-label="Assigned work across eligible providers" className="zen-widget-list">
          {leaveItems.map((item, index) => (
            <li className="zen-widget-work-row" key={item.workItemId}>
              <Link
                className="zen-widget-row"
                href={buildHrLeaveDetailHref(
                  item.leaveRequestId,
                  surfaceId === "surface.mission-control"
                    ? "mission-control"
                    : "hr-mission-control",
                  `${placement.desktop.instanceId}.${item.leaveRequestId}`,
                )}
                id={`${placement.desktop.instanceId}.${item.leaveRequestId}`}
              >
                <span className="leave-status leave-status-submitted">Leave</span>
                <span>
                  <strong>{item.employeeDisplayName}</strong>
                  <p>
                    {item.startDate}–{item.endDate}
                  </p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
              {index === 0 ? (
                <div className="zen-widget-inline-command">
                  <LeaveApprovalAction
                    expectedVersion={item.version}
                    idempotencyKey={randomUUID()}
                    leaveRequestId={item.leaveRequestId}
                  />
                </div>
              ) : null}
            </li>
          ))}
          {timesheetItems.map((item) => (
            <li key={item.workItemId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/timesheets/by-id/${encodeURIComponent(
                  item.timesheetId,
                )}?returnContext=my-work`}
              >
                <span className="leave-status leave-status-submitted">Timesheet</span>
                <span>
                  <strong>
                    {item.periodStart}–{item.periodEnd}
                  </strong>
                  <p>{formatMinutes(item.totalMinutes)}</p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
          {expenseItems.map((item) => (
            <li key={item.workItemId}>
              <Link
                className="zen-widget-row"
                href={`/workspace/hr/expenses/by-id/${encodeURIComponent(
                  item.expenseClaimId,
                )}?returnContext=my-work`}
              >
                <span className="leave-status leave-status-submitted">Expense</span>
                <span>
                  <strong>
                    {new Intl.NumberFormat("en").format(item.totalAmountMinor)} {item.currencyCode}
                  </strong>
                  <p>Minor units · version {item.version}</p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
          {taskItems.map((item) => (
            <li key={item.workItemId}>
              <Link className="zen-widget-row" href="/workspace/my-work">
                <span className="leave-status leave-status-submitted">Task</span>
                <span>
                  <strong>{item.title}</strong>
                  <p>{item.createdByDisplayName}</p>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </li>
          ))}
        </ol>
      </PresentationWidgetStateContent>
    </WidgetFrame>
  );
}
