import {
  type HrLeaveRequestDetail,
  parseHrLeaveRequestDetail,
} from "@esbla/contracts/hr-leave-api";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class HrLeaveDetailError extends Error {
  constructor() {
    super("The leave-request detail is unavailable");
    this.name = "HrLeaveDetailError";
  }
}

export function buildLeaveRequestDetailPath(leaveRequestId: string): string {
  if (!UUID_PATTERN.test(leaveRequestId)) throw new HrLeaveDetailError();
  return `/v1/hr/leave-requests/${encodeURIComponent(leaveRequestId)}`;
}

export async function decodeLeaveRequestDetailResponse(
  responsePromise: Promise<Response>,
): Promise<HrLeaveRequestDetail | null> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrLeaveDetailError();
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new HrLeaveDetailError();
  try {
    return parseHrLeaveRequestDetail(await response.json());
  } catch {
    throw new HrLeaveDetailError();
  }
}
