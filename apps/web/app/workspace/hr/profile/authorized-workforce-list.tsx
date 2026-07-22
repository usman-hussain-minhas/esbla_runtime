import type { HrWorkforceProfile, HrWorkforceStatus } from "@esbla/contracts";
import { ArrowRight, LoaderCircle, TriangleAlert, UsersRound } from "lucide-react";
import { loadEmploymentList } from "../../../../lib/hr-employment-record";
import { hasEmploymentAction } from "../../../../lib/hr-employment-record-core";
import { loadAuthorizedWorkforceList } from "../../../../lib/hr-workforce-profile-list";
import {
  buildWorkforceListHref,
  type WorkforceListNavigation,
  type WorkforceListView,
  workforceListDetailHref,
} from "../../../../lib/hr-workforce-profile-list-core";

interface AuthorizedWorkforceListProps {
  readonly searchParams: Record<string, string | string[] | undefined>;
  readonly view: WorkforceListView;
}

const statusLabels: Record<HrWorkforceStatus, string> = {
  active: "Active",
  draft: "Draft",
  suspended: "Suspended",
  terminated: "Terminated",
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(value));
}

function WorkforceRow({
  assignedAt,
  canCreateEmployment,
  index,
  profile,
  view,
}: Readonly<{
  assignedAt?: string;
  canCreateEmployment: boolean;
  index: number;
  profile: HrWorkforceProfile;
  view: WorkforceListView;
}>) {
  const label = profile.employeeNumber ?? `Workforce profile ${index + 1}`;
  const canStartEmployment =
    canCreateEmployment &&
    view === "workforce" &&
    ((profile.workforceStatus === "active" && profile.principalLinked) ||
      (profile.workforceStatus === "draft" && !profile.principalLinked));
  return (
    <tr>
      <td data-label="Profile">{label}</td>
      <td data-label="Status">
        <span className={`leave-status leave-status-${profile.workforceStatus}`}>
          {statusLabels[profile.workforceStatus]}
        </span>
      </td>
      <td data-label="Principal link">{profile.principalLinked ? "Connected" : "Not connected"}</td>
      {assignedAt ? (
        <td data-label="Assigned">
          <time dateTime={assignedAt}>{formatDateTime(assignedAt)}</time>
        </td>
      ) : null}
      <td data-label="Actions">
        <div className="work-queue-actions">
          <a
            className="text-command work-detail-link"
            href={workforceListDetailHref(profile.workerProfileId, view)}
          >
            View details
            <ArrowRight aria-hidden="true" size={15} strokeWidth={1.8} />
          </a>
          {canStartEmployment ? (
            <a
              className="text-command"
              href={`/workspace/hr/employment/admin?workerProfileId=${encodeURIComponent(
                profile.workerProfileId,
              )}`}
            >
              Start employment record
            </a>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

function StatusFilters({ navigation }: Readonly<{ navigation: WorkforceListNavigation }>) {
  if (navigation.view !== "workforce") return null;
  return (
    <nav aria-label="Workforce status filters" className="work-queue-actions">
      {(Object.keys(statusLabels) as HrWorkforceStatus[]).map((status) => (
        <a
          aria-current={navigation.status === status ? "page" : undefined}
          className="text-command"
          href={buildWorkforceListHref({ status, view: "workforce" }, null)}
          key={status}
        >
          {statusLabels[status]}
        </a>
      ))}
    </nav>
  );
}

export function AuthorizedWorkforceListLoading({ view }: Readonly<{ view: WorkforceListView }>) {
  return (
    <div aria-busy="true" aria-live="polite" className="empty-worklist" role="status">
      <span aria-hidden="true" className="empty-worklist-icon">
        <LoaderCircle className="submit-spinner" size={27} strokeWidth={1.6} />
      </span>
      <h2>{view === "direct_reports" ? "Loading direct reports" : "Loading workforce"}</h2>
      <p>Checking current permission and workforce availability.</p>
    </div>
  );
}

export async function AuthorizedWorkforceList({
  searchParams,
  view,
}: AuthorizedWorkforceListProps) {
  const [state, employment] = await Promise.all([
    loadAuthorizedWorkforceList(searchParams, view),
    view === "workforce" ? loadEmploymentList({ pageSize: "1" }) : Promise.resolve(null),
  ]);
  const canCreateEmployment =
    employment !== null && hasEmploymentAction(employment.authorizedActions, "create_record");
  if (state.status !== "success") {
    return (
      <div className="leave-list-error" role="alert">
        <span aria-hidden="true" className="empty-worklist-icon">
          <TriangleAlert size={27} strokeWidth={1.6} />
        </span>
        <h2>{state.title}</h2>
        <p>{state.message}</p>
      </div>
    );
  }
  const { navigation, page } = state;
  const emptyLabel =
    page.kind === "direct_reports"
      ? "No current direct reports"
      : `No ${statusLabels[navigation.view === "workforce" ? navigation.status : "active"].toLowerCase()} workforce profiles`;
  return (
    <div>
      <StatusFilters navigation={navigation} />
      {page.items.length === 0 ? (
        <div className="empty-worklist">
          <span aria-hidden="true" className="empty-worklist-icon">
            <UsersRound size={27} strokeWidth={1.6} />
          </span>
          <h2>{emptyLabel}</h2>
          <p>Only profiles available through your current role appear here.</p>
        </div>
      ) : (
        <div className="leave-table-wrap">
          <table className="leave-table">
            <caption className="visually-hidden">
              {page.kind === "direct_reports" ? "Current direct reports" : "Authorized workforce"}
            </caption>
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Status</th>
                <th scope="col">Principal link</th>
                {page.kind === "direct_reports" ? <th scope="col">Assigned</th> : null}
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {page.kind === "direct_reports"
                ? page.items.map((item, index) => (
                    <WorkforceRow
                      assignedAt={item.relationship.effectiveAt}
                      canCreateEmployment={canCreateEmployment}
                      index={index}
                      key={item.profile.workerProfileId}
                      profile={item.profile}
                      view={navigation.view}
                    />
                  ))
                : page.items.map((profile, index) => (
                    <WorkforceRow
                      canCreateEmployment={canCreateEmployment}
                      index={index}
                      key={profile.workerProfileId}
                      profile={profile}
                      view={navigation.view}
                    />
                  ))}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor || navigation.cursor ? (
        <nav aria-label="Workforce list pages" className="list-pagination">
          {navigation.cursor ? (
            <a className="text-command" href={buildWorkforceListHref(navigation, null)}>
              Start over
            </a>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <a className="text-command" href={buildWorkforceListHref(navigation, page.nextCursor)}>
              Next page
            </a>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
