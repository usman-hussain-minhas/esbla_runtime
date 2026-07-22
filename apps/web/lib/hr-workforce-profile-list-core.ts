import {
  type ApiProblemDetails,
  type HrDirectReportsCursor,
  type HrWorkforceCursor,
  type HrWorkforceListResponse,
  type HrWorkforceStatus,
  hrWorkforceStatuses,
  parseApiProblemDetails,
  parseHrWorkforceListResponse,
} from "@esbla/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIRECT_KEYS = new Set(["cursorEffectiveAt", "cursorReportingRelationshipId"]);
const WORKFORCE_KEYS = new Set(["cursorCreatedAt", "cursorWorkerProfileId", "status"]);
const STATUSES = new Set<HrWorkforceStatus>(hrWorkforceStatuses);

export type WorkforceListFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export type WorkforceListView = "direct_reports" | "workforce";
export type WorkforceListNavigation =
  | { readonly cursor?: HrDirectReportsCursor; readonly view: "direct_reports" }
  | {
      readonly cursor?: HrWorkforceCursor;
      readonly status: HrWorkforceStatus;
      readonly view: "workforce";
    };
export interface WorkforceListFailureState {
  readonly message: string;
  readonly status: WorkforceListFailureKind;
  readonly title: string;
}

export class WorkforceProfileListUiError extends Error {
  constructor(readonly kind: WorkforceListFailureKind) {
    super("Workforce Profile list request failed");
    this.name = "WorkforceProfileListUiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new WorkforceProfileListUiError("validation");
  return value;
}

function uuid(value: string): string {
  if (!UUID.test(value)) throw new WorkforceProfileListUiError("validation");
  return value.toLowerCase();
}

function timestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new WorkforceProfileListUiError("validation");
  }
  return value;
}

export function parseWorkforceListNavigation(
  value: unknown,
  view: WorkforceListView,
): WorkforceListNavigation {
  if (!isRecord(value)) throw new WorkforceProfileListUiError("validation");
  const allowed = view === "direct_reports" ? DIRECT_KEYS : WORKFORCE_KEYS;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new WorkforceProfileListUiError("validation");
  }
  if (view === "direct_reports") {
    const effectiveAt = optionalString(value.cursorEffectiveAt);
    const reportingRelationshipId = optionalString(value.cursorReportingRelationshipId);
    if ((effectiveAt === undefined) !== (reportingRelationshipId === undefined)) {
      throw new WorkforceProfileListUiError("validation");
    }
    return {
      ...(effectiveAt && reportingRelationshipId
        ? {
            cursor: {
              effectiveAt: timestamp(effectiveAt),
              reportingRelationshipId: uuid(reportingRelationshipId),
            },
          }
        : {}),
      view,
    };
  }
  const createdAt = optionalString(value.cursorCreatedAt);
  const workerProfileId = optionalString(value.cursorWorkerProfileId);
  const status = optionalString(value.status) ?? "active";
  if (
    !STATUSES.has(status as HrWorkforceStatus) ||
    (createdAt === undefined) !== (workerProfileId === undefined)
  ) {
    throw new WorkforceProfileListUiError("validation");
  }
  return {
    ...(createdAt && workerProfileId
      ? { cursor: { createdAt: timestamp(createdAt), workerProfileId: uuid(workerProfileId) } }
      : {}),
    status: status as HrWorkforceStatus,
    view,
  };
}

export function buildWorkforceListApiPath(navigation: WorkforceListNavigation): string {
  const query = new URLSearchParams({ pageSize: "10" });
  if (navigation.view === "direct_reports") {
    if (navigation.cursor) {
      query.set("cursorEffectiveAt", timestamp(navigation.cursor.effectiveAt));
      query.set("cursorReportingRelationshipId", uuid(navigation.cursor.reportingRelationshipId));
    }
  } else {
    query.set("status", navigation.status);
    if (navigation.cursor) {
      query.set("cursorCreatedAt", timestamp(navigation.cursor.createdAt));
      query.set("cursorWorkerProfileId", uuid(navigation.cursor.workerProfileId));
    }
  }
  return `/v1/hr/workforce-profiles?${query}`;
}

export function buildWorkforceListHref(
  navigation: WorkforceListNavigation,
  cursor: HrDirectReportsCursor | HrWorkforceCursor | null,
): string {
  const query = new URLSearchParams();
  let route = "/workspace/hr/profile/direct-reports";
  if (navigation.view === "direct_reports") {
    if (cursor && "effectiveAt" in cursor) {
      query.set("cursorEffectiveAt", timestamp(cursor.effectiveAt));
      query.set("cursorReportingRelationshipId", uuid(cursor.reportingRelationshipId));
    } else if (cursor) throw new WorkforceProfileListUiError("validation");
  } else {
    route = "/workspace/hr/profile/admin";
    query.set("status", navigation.status);
    if (cursor && "createdAt" in cursor) {
      query.set("cursorCreatedAt", timestamp(cursor.createdAt));
      query.set("cursorWorkerProfileId", uuid(cursor.workerProfileId));
    } else if (cursor) throw new WorkforceProfileListUiError("validation");
  }
  const encoded = query.toString();
  return `${route}${encoded ? `?${encoded}` : ""}`;
}

export function workforceListDetailHref(workerProfileId: string, view: WorkforceListView): string {
  const context = view === "workforce" ? "admin" : "direct-reports";
  return `/workspace/hr/profile/by-id/${encodeURIComponent(uuid(workerProfileId))}?returnContext=${context}`;
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function problemError(problem: ApiProblemDetails): WorkforceProfileListUiError {
  if (
    problem.status === 403 &&
    ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code)
  ) {
    return new WorkforceProfileListUiError("denied");
  }
  if (problem.status === 404 && problem.code === "WORKFORCE_PROFILE_NOT_FOUND")
    return new WorkforceProfileListUiError("not_found");
  if (problem.status === 409 && problem.code === "WORKFORCE_PROFILE_CONFLICT")
    return new WorkforceProfileListUiError("conflict");
  if (
    problem.status === 400 &&
    ["REQUEST_VALIDATION_FAILED", "WORKFORCE_INPUT_INVALID"].includes(problem.code)
  ) {
    return new WorkforceProfileListUiError("validation");
  }
  if (problem.status === 503 && problem.code === "WORKFORCE_SERVICE_INACTIVE")
    return new WorkforceProfileListUiError("inactive");
  if (problem.status === 503 && problem.code === "ACTIVATION_DEPENDENCY_BLOCKED")
    return new WorkforceProfileListUiError("dependency_unavailable");
  return new WorkforceProfileListUiError("operational_error");
}

export async function decodeWorkforceListResponse(
  responsePromise: Promise<Response>,
  navigation: WorkforceListNavigation,
): Promise<HrWorkforceListResponse> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkforceProfileListUiError("operational_error");
  }
  if (
    response.status === 200 &&
    mediaType(response) === "application/json" &&
    response.headers.get("idempotent-replayed") === null
  ) {
    try {
      const page = parseHrWorkforceListResponse(await response.json());
      if (page.kind !== navigation.view) throw new TypeError("Unexpected Workforce list branch");
      if (page.items.length > 10) throw new TypeError("Workforce list exceeds requested page size");
      const ids = new Set<string>();
      if (page.kind === "direct_reports") {
        const relationshipIds = new Set<string>();
        let previous: (typeof page.items)[number] | undefined;
        for (const item of page.items) {
          if (ids.has(item.profile.workerProfileId)) {
            throw new TypeError("Duplicate Workforce list item");
          }
          ids.add(item.profile.workerProfileId);
          if (
            relationshipIds.has(item.relationship.reportingRelationshipId) ||
            item.relationship.relationshipStatus !== "assigned" ||
            item.relationship.managerWorkerProfileId === null
          ) {
            throw new TypeError("Invalid direct-report relationship");
          }
          relationshipIds.add(item.relationship.reportingRelationshipId);
          if (
            item.relationship.workerProfileId !== item.profile.workerProfileId ||
            item.relationship.workerProfileVersion !== item.profile.version
          ) {
            throw new TypeError("Workforce relationship binding mismatch");
          }
          if (
            previous &&
            (item.relationship.effectiveAt > previous.relationship.effectiveAt ||
              (item.relationship.effectiveAt === previous.relationship.effectiveAt &&
                item.relationship.reportingRelationshipId >=
                  previous.relationship.reportingRelationshipId))
          ) {
            throw new TypeError("Workforce direct reports are out of order");
          }
          previous = item;
        }
        const last = page.items.at(-1)?.relationship;
        if (
          page.nextCursor &&
          (!last ||
            page.nextCursor.effectiveAt !== last.effectiveAt ||
            page.nextCursor.reportingRelationshipId !== last.reportingRelationshipId)
        ) {
          throw new TypeError("Workforce direct-reports cursor is not page-bound");
        }
      } else {
        if (navigation.view !== "workforce") throw new TypeError("Workforce branch mismatch");
        for (const profile of page.items) {
          if (ids.has(profile.workerProfileId))
            throw new TypeError("Duplicate Workforce list item");
          ids.add(profile.workerProfileId);
          if (profile.workforceStatus !== navigation.status) {
            throw new TypeError("Workforce status binding mismatch");
          }
        }
        if (
          page.nextCursor &&
          page.nextCursor.workerProfileId !== page.items.at(-1)?.workerProfileId
        ) {
          throw new TypeError("Workforce cursor is not page-bound");
        }
      }
      return page;
    } catch {
      throw new WorkforceProfileListUiError("operational_error");
    }
  }
  if (response.status < 400 || mediaType(response) !== "application/problem+json")
    throw new WorkforceProfileListUiError("operational_error");
  try {
    const problem = parseApiProblemDetails(await response.json());
    if (problem.status !== response.status) throw new TypeError("Problem status mismatch");
    throw problemError(problem);
  } catch (error) {
    if (error instanceof WorkforceProfileListUiError) throw error;
    throw new WorkforceProfileListUiError("operational_error");
  }
}

export function workforceListStateForError(error: unknown): WorkforceListFailureState {
  const kind = error instanceof WorkforceProfileListUiError ? error.kind : "operational_error";
  const states: Record<WorkforceListFailureKind, Readonly<{ message: string; title: string }>> = {
    conflict: {
      message: "The workforce list changed while it was being read. Try again.",
      title: "Workforce list changed",
    },
    denied: {
      message: "You do not have current permission to view this workforce list.",
      title: "Workforce list unavailable",
    },
    dependency_unavailable: {
      message: "A required workforce dependency is unavailable right now.",
      title: "Workforce dependency unavailable",
    },
    inactive: {
      message: "Workforce Profile is not available right now.",
      title: "Workforce Profile inactive",
    },
    not_found: {
      message: "This workforce list is not available to this account.",
      title: "Workforce list not found",
    },
    operational_error: {
      message: "We could not load the workforce list. Try again in a moment.",
      title: "Workforce list unavailable",
    },
    validation: {
      message: "This workforce list link is invalid. Return to a current workforce view.",
      title: "Workforce list link invalid",
    },
  };
  return { ...states[kind], status: kind };
}
