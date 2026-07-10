import {
  type HrLeaveRequestCursor,
  type HrLeaveRequestPage,
  parseHrLeaveRequestPage,
} from "@esbla/contracts/hr-leave-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class HrLeaveListError extends Error {
  constructor() {
    super("The leave-request list is unavailable");
    this.name = "HrLeaveListError";
  }
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
  if (!response.ok) throw new HrLeaveListError();
  try {
    return parseHrLeaveRequestPage(await response.json());
  } catch {
    throw new HrLeaveListError();
  }
}
