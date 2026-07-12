import {
  type ApiProblemDetails,
  type HrAssignedLeaveRequestPage,
  type HrLeaveRequestCursor,
  parseApiProblemDetails,
  parseHrAssignedLeaveRequestPage,
} from "@esbla/contracts/hr-leave-api";
import { AssignedProviderUnavailableError } from "./assigned-provider-core";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class HrLeaveAssignedListError extends Error {
  constructor() {
    super("The assigned leave-request list is unavailable");
    this.name = "HrLeaveAssignedListError";
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

export function buildAssignedLeaveRequestListPath(cursor?: HrLeaveRequestCursor): string {
  const parameters = new URLSearchParams({ pageSize: "50" });
  if (cursor) {
    if (
      !UUID_PATTERN.test(cursor.leaveRequestId) ||
      !ISO_DATE_TIME_PATTERN.test(cursor.submittedAt) ||
      Number.isNaN(Date.parse(cursor.submittedAt))
    ) {
      throw new HrLeaveAssignedListError();
    }
    parameters.set("cursorLeaveRequestId", cursor.leaveRequestId);
    parameters.set("cursorSubmittedAt", cursor.submittedAt);
  }
  return `/v1/hr/leave-requests/assigned?${parameters.toString()}`;
}

export async function decodeAssignedLeaveRequestListResponse(
  responsePromise: Promise<Response>,
): Promise<HrAssignedLeaveRequestPage> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrLeaveAssignedListError();
  }

  let mediaType: string | null;
  try {
    mediaType = mediaTypeEssence(response);
  } catch {
    throw new HrLeaveAssignedListError();
  }

  if (response.status === 200) {
    if (mediaType !== "application/json") throw new HrLeaveAssignedListError();
    let payload: unknown;
    try {
      payload = await response.json();
      return parseHrAssignedLeaveRequestPage(payload);
    } catch {
      throw new HrLeaveAssignedListError();
    }
  }

  if (mediaType !== "application/problem+json") throw new HrLeaveAssignedListError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HrLeaveAssignedListError();
  }
  let problem: ApiProblemDetails;
  try {
    problem = parseApiProblemDetails(payload);
  } catch {
    throw new HrLeaveAssignedListError();
  }
  if (problem.status !== response.status) throw new HrLeaveAssignedListError();
  if (response.status === 403 && problem.code === "POLICY_DENIED") {
    throw new AssignedProviderUnavailableError("hr_leave_assigned", "ineligible");
  }
  if (response.status === 503 && problem.code === "LEAVE_SERVICE_INACTIVE") {
    throw new AssignedProviderUnavailableError("hr_leave_assigned", "inactive");
  }
  throw new HrLeaveAssignedListError();
}
