import {
  type ApiProblemDetails,
  type HrLeaveRequestCursor,
  type HrLeaveRequestPage,
  parseApiProblemDetails,
  parseHrLeaveRequestPage,
} from "@esbla/contracts/hr-leave-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type HrLeaveListErrorKind = "denied" | "error" | "inactive" | "not_found" | "unavailable";

export class HrLeaveListError extends Error {
  readonly kind: HrLeaveListErrorKind;

  constructor(kind: HrLeaveListErrorKind = "unavailable") {
    super("The leave-request list is unavailable");
    this.name = "HrLeaveListError";
    this.kind = kind;
  }
}

function mediaTypeEssence(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return null;
  let escaped = false;
  let quoted = false;
  for (const character of contentType) {
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      return null;
    }
  }
  if (quoted || escaped) return null;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

export function buildOwnLeaveRequestListPath(cursor?: HrLeaveRequestCursor): string {
  const parameters = new URLSearchParams({ pageSize: "50" });
  if (cursor) {
    if (
      !UUID_PATTERN.test(cursor.leaveRequestId) ||
      !ISO_DATE_TIME_PATTERN.test(cursor.submittedAt) ||
      Number.isNaN(Date.parse(cursor.submittedAt))
    ) {
      throw new HrLeaveListError();
    }
    parameters.set("cursorLeaveRequestId", cursor.leaveRequestId);
    parameters.set("cursorSubmittedAt", cursor.submittedAt);
  }
  return `/v1/hr/leave-requests?${parameters.toString()}`;
}

export async function decodeOwnLeaveRequestListResponse(
  responsePromise: Promise<Response>,
): Promise<HrLeaveRequestPage> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrLeaveListError();
  }

  let mediaType: string | null;
  try {
    mediaType = mediaTypeEssence(response);
  } catch {
    throw new HrLeaveListError();
  }
  if (response.status === 200) {
    if (mediaType !== "application/json") throw new HrLeaveListError();
    try {
      return parseHrLeaveRequestPage(await response.json());
    } catch {
      throw new HrLeaveListError();
    }
  }

  if (mediaType !== "application/problem+json") throw new HrLeaveListError();
  let problem: ApiProblemDetails;
  try {
    problem = parseApiProblemDetails(await response.json());
  } catch {
    throw new HrLeaveListError();
  }
  if (problem.status !== response.status) throw new HrLeaveListError();
  if (response.status === 403 && problem.code === "POLICY_DENIED") {
    throw new HrLeaveListError("denied");
  }
  if (response.status === 404) throw new HrLeaveListError("not_found");
  if (response.status === 503 && problem.code === "LEAVE_SERVICE_INACTIVE") {
    throw new HrLeaveListError("inactive");
  }
  if (response.status >= 500) throw new HrLeaveListError("error");
  throw new HrLeaveListError();
}
