import { randomUUID } from "node:crypto";
import type {
  HrWorkforceProfileDetail,
  HrWorkforceRelationshipHistory,
  HrWorkforceStatusHistory,
} from "@esbla/contracts";
import { ArrowLeft, BadgeCheck, Clock3, FileClock, TriangleAlert } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { loadAuthorizedWorkforceProfileDetail } from "../../../../../../lib/hr-workforce-profile-detail";
import {
  buildWorkforceDetailHistoryHref,
  type WorkforceDetailNavigation,
  workforceDetailReturnLink,
} from "../../../../../../lib/hr-workforce-profile-detail-core";
import { loadAuthorizedWorkforceList } from "../../../../../../lib/hr-workforce-profile-list";
import {
  type RouteBackedWidgetOrigin,
  withoutRouteBackedWidgetOrigin,
} from "../../../../../../lib/route-backed-widget-navigation-core";
import { RouteBackedWidgetLink } from "../../../../../../theme/zen-theme/v1/route-backed-widget-link";
import { WorkforceProfileMaintenance } from "./workforce-profile-maintenance";

interface WorkforceProfileDetailPageProps {
  readonly focusOrigin?: RouteBackedWidgetOrigin | undefined;
  readonly leadingControl?: ReactNode;
  readonly mode?: "focus" | "standalone";
  readonly params: Promise<{ workerProfileId: string }>;
  readonly preloadedState?: Awaited<ReturnType<typeof loadAuthorizedWorkforceProfileDetail>>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const statusLabels = {
  active: "Active",
  draft: "Draft",
  suspended: "Suspended",
  terminated: "Terminated",
} as const;

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "UTC",
    timeZoneName: "short",
    year: "numeric",
  }).format(new Date(value));
}

function statusChangeLabel(event: HrWorkforceStatusHistory) {
  return event.previousStatus
    ? `${statusLabels[event.previousStatus]} to ${statusLabels[event.newStatus]}`
    : `Created as ${statusLabels[event.newStatus]}`;
}

function relationshipLabel(event: HrWorkforceRelationshipHistory) {
  return event.relationshipStatus === "assigned" ? "Manager assigned" : "Manager unassigned";
}

function HistoryNavigation({
  detail,
  focusOrigin,
  history,
  navigation,
}: Readonly<{
  detail: HrWorkforceProfileDetail;
  focusOrigin?: RouteBackedWidgetOrigin | undefined;
  history: "relationship" | "status";
  navigation: WorkforceDetailNavigation;
}>) {
  const currentCursor =
    history === "relationship" ? navigation.relationshipCursor : navigation.statusCursor;
  const nextCursor =
    history === "relationship"
      ? detail.relationshipHistory.nextCursor
      : detail.statusHistory.nextCursor;
  if (!currentCursor && !nextCursor) return null;
  const label = history === "relationship" ? "reporting history" : "status history";
  return (
    <nav aria-label={`${label} pages`} className="work-queue-actions">
      {currentCursor ? (
        <RouteBackedWidgetLink
          className="text-command"
          focusOrigin={focusOrigin}
          href={buildWorkforceDetailHistoryHref(
            detail.workerProfileId,
            navigation,
            history === "relationship"
              ? { history, nextCursor: null }
              : { history, nextCursor: null },
          )}
        >
          Start {label} over
        </RouteBackedWidgetLink>
      ) : null}
      {nextCursor ? (
        <RouteBackedWidgetLink
          className="text-command"
          focusOrigin={focusOrigin}
          href={buildWorkforceDetailHistoryHref(
            detail.workerProfileId,
            navigation,
            history === "relationship"
              ? { history, nextCursor: detail.relationshipHistory.nextCursor }
              : { history, nextCursor: detail.statusHistory.nextCursor },
          )}
        >
          Next {label}
        </RouteBackedWidgetLink>
      ) : null}
    </nav>
  );
}

function FailureState({
  leadingControl,
  message,
  mode,
  returnLink,
  title,
}: Readonly<{
  message: string;
  leadingControl?: ReactNode;
  mode: "focus" | "standalone";
  returnLink: ReturnType<typeof workforceDetailReturnLink>;
  title: string;
}>) {
  return (
    <section
      aria-labelledby="workforce-detail-failure-heading"
      className="work-surface leave-detail-surface"
    >
      {leadingControl ??
        (mode === "standalone" ? (
          <a className="text-command detail-back" href={returnLink.href}>
            <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
            {returnLink.label}
          </a>
        ) : null)}
      <div className="leave-list-error" role="alert">
        <span aria-hidden="true" className="empty-worklist-icon">
          <TriangleAlert size={27} strokeWidth={1.6} />
        </span>
        <h1 id="workforce-detail-failure-heading">{title}</h1>
        <p>{message}</p>
      </div>
    </section>
  );
}

export default async function WorkforceProfileDetailPage({
  focusOrigin,
  leadingControl,
  mode = "standalone",
  params,
  preloadedState,
  searchParams,
}: WorkforceProfileDetailPageProps) {
  const [{ workerProfileId }, parameters] = await Promise.all([params, searchParams]);
  const productParameters = withoutRouteBackedWidgetOrigin(parameters) as Record<
    string,
    string | string[] | undefined
  >;
  const state =
    preloadedState ??
    (await loadAuthorizedWorkforceProfileDetail(workerProfileId, productParameters));
  const returnLink = workforceDetailReturnLink(state.navigation.returnContext);
  if (state.status === "not_found") notFound();
  if (state.status !== "success") {
    return (
      <FailureState
        leadingControl={leadingControl}
        message={state.message}
        mode={mode}
        returnLink={returnLink}
        title={state.title}
      />
    );
  }
  const { detail, navigation } = state;
  const maintenanceAdmission = await loadAuthorizedWorkforceList(
    { status: detail.workforceStatus },
    "workforce",
  );
  return (
    <section
      aria-labelledby="workforce-detail-heading"
      className="work-surface leave-detail-surface"
    >
      {leadingControl ??
        (mode === "standalone" ? (
          <a className="text-command detail-back" href={returnLink.href}>
            <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
            {returnLink.label}
          </a>
        ) : null)}
      <header className="surface-heading leave-detail-heading">
        <div>
          <p className="surface-label">Workforce Profile</p>
          <h1 id="workforce-detail-heading">
            {detail.employeeNumber ? `Employee ${detail.employeeNumber}` : "Workforce profile"}
          </h1>
          <p className="surface-summary">Persistent role-scoped workforce detail and history.</p>
        </div>
        <span className="leave-status">{statusLabels[detail.workforceStatus]}</span>
      </header>
      {maintenanceAdmission.status === "success" ? (
        <WorkforceProfileMaintenance
          idempotencyKeys={{ reporting: randomUUID(), status: randomUUID() }}
          initialStatus={detail.workforceStatus}
          initialVersion={detail.version}
          key={`${detail.workerProfileId}:${detail.version}`}
          workerProfileId={detail.workerProfileId}
        />
      ) : null}
      <div className="leave-detail-layout">
        <section aria-labelledby="workforce-facts-heading" className="leave-detail-section">
          <div className="detail-section-heading">
            <BadgeCheck aria-hidden="true" size={20} strokeWidth={1.7} />
            <h2 id="workforce-facts-heading">Current profile</h2>
          </div>
          <dl className="leave-detail-facts">
            <div>
              <dt>Workforce status</dt>
              <dd>{statusLabels[detail.workforceStatus]}</dd>
            </div>
            <div>
              <dt>Employee number</dt>
              <dd>{detail.employeeNumber ?? "Not assigned"}</dd>
            </div>
            <div>
              <dt>Principal link</dt>
              <dd>{detail.principalLinked ? "Connected" : "Not connected"}</dd>
            </div>
            <div>
              <dt>Record version</dt>
              <dd>{detail.version}</dd>
            </div>
          </dl>
          <div className="leave-detail-copy">
            <div className="detail-section-heading">
              <FileClock aria-hidden="true" size={19} strokeWidth={1.7} />
              <h2 id="status-history-heading">Status history</h2>
            </div>
            {detail.statusHistory.items.length === 0 ? (
              <p>No status history is available on this page.</p>
            ) : (
              <ol aria-labelledby="status-history-heading" className="leave-history">
                {detail.statusHistory.items.map((event) => (
                  <li className="leave-history-item" key={event.workforceStatusHistoryId}>
                    <span aria-hidden="true" className="leave-history-marker">
                      <Clock3 size={14} strokeWidth={1.8} />
                    </span>
                    <div>
                      <strong>{statusLabels[event.newStatus]}</strong>
                      <p>{statusChangeLabel(event)}</p>
                      <time dateTime={event.effectiveAt}>{formatDateTime(event.effectiveAt)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <HistoryNavigation
              detail={detail}
              focusOrigin={focusOrigin}
              history="status"
              navigation={navigation}
            />
          </div>
        </section>
        <section aria-labelledby="relationship-history-heading" className="leave-detail-section">
          <div className="detail-section-heading">
            <FileClock aria-hidden="true" size={20} strokeWidth={1.7} />
            <h2 id="relationship-history-heading">Reporting history</h2>
          </div>
          {detail.relationshipHistory.items.length === 0 ? (
            <div className="leave-detail-copy">
              <p>No reporting history is available on this page.</p>
            </div>
          ) : (
            <ol aria-labelledby="relationship-history-heading" className="leave-history">
              {detail.relationshipHistory.items.map((event) => (
                <li className="leave-history-item" key={event.reportingRelationshipId}>
                  <span aria-hidden="true" className="leave-history-marker">
                    <Clock3 size={14} strokeWidth={1.8} />
                  </span>
                  <div>
                    <strong>{relationshipLabel(event)}</strong>
                    <p>
                      {event.managerWorkerProfileId
                        ? `Manager profile reference ${event.managerWorkerProfileId}`
                        : "No manager profile assigned"}
                    </p>
                    <time dateTime={event.effectiveAt}>{formatDateTime(event.effectiveAt)}</time>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <HistoryNavigation
            detail={detail}
            focusOrigin={focusOrigin}
            history="relationship"
            navigation={navigation}
          />
        </section>
      </div>
    </section>
  );
}
