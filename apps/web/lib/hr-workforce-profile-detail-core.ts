import {
  type ApiProblemDetails,
  type HrWorkforceProfileDetail,
  type HrWorkforceProfileResponse,
  type HrWorkforceRelationshipHistoryCursor,
  type HrWorkforceStatusHistoryCursor,
  parseApiProblemDetails,
  parseHrWorkforceProfile,
} from "@esbla/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETURN_CONTEXTS = new Set<WorkforceDetailReturnContext>(["admin", "direct-reports", "own"]);
const NAVIGATION_KEYS = new Set([
  "relationshipCursorReportingRelationshipId",
  "relationshipCursorVersion",
  "returnContext",
  "statusCursorEffectiveAt",
  "statusCursorWorkforceStatusHistoryId",
]);

export type WorkforceProfileDetailFailureKind =
  | "conflict"
  | "denied"
  | "dependency_unavailable"
  | "inactive"
  | "not_found"
  | "operational_error"
  | "validation";
export type WorkforceDetailReturnContext = "admin" | "direct-reports" | "own";

export interface WorkforceDetailNavigation {
  readonly relationshipCursor?: HrWorkforceRelationshipHistoryCursor;
  readonly returnContext: WorkforceDetailReturnContext | null;
  readonly statusCursor?: HrWorkforceStatusHistoryCursor;
}

export interface WorkforceProfileDetailFailureState {
  readonly message: string;
  readonly status: WorkforceProfileDetailFailureKind;
  readonly title: string;
}

export type WorkforceDetailHistoryUpdate =
  | {
      readonly history: "relationship";
      readonly nextCursor: HrWorkforceRelationshipHistoryCursor | null;
    }
  | { readonly history: "status"; readonly nextCursor: HrWorkforceStatusHistoryCursor | null };

export class WorkforceProfileDetailUiError extends Error {
  constructor(readonly kind: WorkforceProfileDetailFailureKind) {
    super("Workforce Profile detail request failed");
    this.name = "WorkforceProfileDetailUiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: string): string {
  if (!UUID.test(value)) throw new WorkforceProfileDetailUiError("validation");
  return value.toLowerCase();
}

function workerProfileUuid(value: string): string {
  if (!UUID.test(value)) throw new WorkforceProfileDetailUiError("not_found");
  return value.toLowerCase();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new WorkforceProfileDetailUiError("validation");
  return value;
}

function canonicalTimestamp(value: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new WorkforceProfileDetailUiError("validation");
  }
  return value;
}

function positiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new WorkforceProfileDetailUiError("validation");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new WorkforceProfileDetailUiError("validation");
  return parsed;
}

export function parseWorkforceDetailNavigation(value: unknown): WorkforceDetailNavigation {
  if (!isRecord(value) || Object.keys(value).some((key) => !NAVIGATION_KEYS.has(key))) {
    throw new WorkforceProfileDetailUiError("validation");
  }
  const relationshipId = optionalString(value.relationshipCursorReportingRelationshipId);
  const relationshipVersion = optionalString(value.relationshipCursorVersion);
  const statusEffectiveAt = optionalString(value.statusCursorEffectiveAt);
  const statusHistoryId = optionalString(value.statusCursorWorkforceStatusHistoryId);
  const rawReturnContext = optionalString(value.returnContext);
  if ((relationshipId === undefined) !== (relationshipVersion === undefined)) {
    throw new WorkforceProfileDetailUiError("validation");
  }
  if ((statusEffectiveAt === undefined) !== (statusHistoryId === undefined)) {
    throw new WorkforceProfileDetailUiError("validation");
  }
  return {
    ...(relationshipId && relationshipVersion
      ? {
          relationshipCursor: {
            relationshipVersion: positiveInteger(relationshipVersion),
            reportingRelationshipId: uuid(relationshipId),
          },
        }
      : {}),
    returnContext:
      rawReturnContext && RETURN_CONTEXTS.has(rawReturnContext as WorkforceDetailReturnContext)
        ? (rawReturnContext as WorkforceDetailReturnContext)
        : null,
    ...(statusEffectiveAt && statusHistoryId
      ? {
          statusCursor: {
            effectiveAt: canonicalTimestamp(statusEffectiveAt),
            workforceStatusHistoryId: uuid(statusHistoryId),
          },
        }
      : {}),
  };
}

function appendRelationshipCursor(
  query: URLSearchParams,
  cursor: HrWorkforceRelationshipHistoryCursor | undefined,
) {
  if (!cursor) return;
  query.set("relationshipCursorVersion", String(cursor.relationshipVersion));
  query.set("relationshipCursorReportingRelationshipId", uuid(cursor.reportingRelationshipId));
}

function appendStatusCursor(
  query: URLSearchParams,
  cursor: HrWorkforceStatusHistoryCursor | undefined,
) {
  if (!cursor) return;
  query.set("statusCursorEffectiveAt", canonicalTimestamp(cursor.effectiveAt));
  query.set("statusCursorWorkforceStatusHistoryId", uuid(cursor.workforceStatusHistoryId));
}

export function buildWorkforceDetailApiPath(
  workerProfileId: string,
  navigation: WorkforceDetailNavigation,
): string {
  const target = workerProfileUuid(workerProfileId);
  const query = new URLSearchParams({ pageSize: "10" });
  appendRelationshipCursor(query, navigation.relationshipCursor);
  appendStatusCursor(query, navigation.statusCursor);
  return `/v1/hr/workforce-profiles/by-id/${encodeURIComponent(target)}?${query}`;
}

export function workforceDetailReturnLink(context: WorkforceDetailReturnContext | null) {
  const links = {
    admin: { href: "/workspace/hr/profile/admin", label: "Back to workforce administration" },
    "direct-reports": {
      href: "/workspace/hr/profile/direct-reports",
      label: "Back to direct reports",
    },
    own: { href: "/workspace/hr/profile", label: "Back to my profile" },
  } as const;
  return context ? links[context] : { href: "/workspace/hr", label: "Back to HR" };
}

export function buildWorkforceDetailHistoryHref(
  workerProfileId: string,
  navigation: WorkforceDetailNavigation,
  update: WorkforceDetailHistoryUpdate,
): string {
  const target = workerProfileUuid(workerProfileId);
  const relationshipCursor =
    update.history === "relationship"
      ? (update.nextCursor ?? undefined)
      : navigation.relationshipCursor;
  const statusCursor =
    update.history === "status" ? (update.nextCursor ?? undefined) : navigation.statusCursor;
  const query = new URLSearchParams();
  if (navigation.returnContext) query.set("returnContext", navigation.returnContext);
  appendRelationshipCursor(query, relationshipCursor);
  appendStatusCursor(query, statusCursor);
  const encoded = query.toString();
  return `/workspace/hr/profile/by-id/${encodeURIComponent(target)}${encoded ? `?${encoded}` : ""}`;
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function problemError(problem: ApiProblemDetails): WorkforceProfileDetailUiError {
  if (
    problem.status === 403 &&
    ["ACTOR_NOT_ACTIVE_MEMBER", "POLICY_DENIED"].includes(problem.code)
  ) {
    return new WorkforceProfileDetailUiError("denied");
  }
  if (problem.status === 404 && problem.code === "WORKFORCE_PROFILE_NOT_FOUND") {
    return new WorkforceProfileDetailUiError("not_found");
  }
  if (problem.status === 409 && problem.code === "WORKFORCE_PROFILE_CONFLICT") {
    return new WorkforceProfileDetailUiError("conflict");
  }
  if (
    problem.status === 400 &&
    ["REQUEST_VALIDATION_FAILED", "WORKFORCE_INPUT_INVALID"].includes(problem.code)
  ) {
    return new WorkforceProfileDetailUiError("validation");
  }
  if (problem.status === 503 && problem.code === "WORKFORCE_SERVICE_INACTIVE") {
    return new WorkforceProfileDetailUiError("inactive");
  }
  if (problem.status === 503 && problem.code === "ACTIVATION_DEPENDENCY_BLOCKED") {
    return new WorkforceProfileDetailUiError("dependency_unavailable");
  }
  return new WorkforceProfileDetailUiError("operational_error");
}

function isDetail(value: HrWorkforceProfileResponse): value is HrWorkforceProfileDetail {
  return Object.hasOwn(value, "relationshipHistory") && Object.hasOwn(value, "statusHistory");
}

export async function decodeWorkforceDetailResponse(
  responsePromise: Promise<Response>,
  workerProfileId: string,
): Promise<HrWorkforceProfileDetail> {
  const target = workerProfileUuid(workerProfileId);
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new WorkforceProfileDetailUiError("operational_error");
  }
  if (
    response.status === 200 &&
    mediaType(response) === "application/json" &&
    response.headers.get("idempotent-replayed") === null
  ) {
    try {
      const parsed = parseHrWorkforceProfile(await response.json());
      if (
        !isDetail(parsed) ||
        parsed.workerProfileId !== target ||
        parsed.relationshipHistory.items.some((item) => item.workerProfileId !== target)
      ) {
        throw new TypeError("Unexpected Workforce Profile detail binding");
      }
      return parsed;
    } catch {
      throw new WorkforceProfileDetailUiError("operational_error");
    }
  }
  if (response.status < 400 || mediaType(response) !== "application/problem+json") {
    throw new WorkforceProfileDetailUiError("operational_error");
  }
  try {
    const problem = parseApiProblemDetails(await response.json());
    if (problem.status !== response.status) throw new TypeError("Problem status mismatch");
    throw problemError(problem);
  } catch (error) {
    if (error instanceof WorkforceProfileDetailUiError) throw error;
    throw new WorkforceProfileDetailUiError("operational_error");
  }
}

export function workforceDetailStateForError(error: unknown): WorkforceProfileDetailFailureState {
  const kind = error instanceof WorkforceProfileDetailUiError ? error.kind : "operational_error";
  const states: Record<
    WorkforceProfileDetailFailureKind,
    Readonly<{ message: string; title: string }>
  > = {
    conflict: {
      message: "This workforce profile could not be read as one current record. Try again.",
      title: "Profile state changed",
    },
    denied: {
      message: "You do not have current permission to view this workforce profile.",
      title: "Profile unavailable",
    },
    dependency_unavailable: {
      message: "A required workforce dependency is unavailable right now.",
      title: "Profile dependency unavailable",
    },
    inactive: {
      message: "Workforce Profile is not available right now.",
      title: "Workforce Profile inactive",
    },
    not_found: {
      message: "This workforce profile was not found or is unavailable to this account.",
      title: "Workforce profile not found",
    },
    operational_error: {
      message: "We could not load this workforce profile. Try again in a moment.",
      title: "Profile unavailable",
    },
    validation: {
      message: "This workforce history link is invalid. Return to a current workforce view.",
      title: "History link invalid",
    },
  };
  return { ...states[kind], status: kind };
}
