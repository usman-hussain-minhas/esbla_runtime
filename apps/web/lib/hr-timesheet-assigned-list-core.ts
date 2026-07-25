import { type ApiProblemDetails, parseApiProblemDetails } from "@esbla/contracts";
import {
  type HrTimesheetAssignedCursor,
  type HrTimesheetListResponse,
  parseHrTimesheetListResponse,
} from "@esbla/contracts/hr-timesheet-api";
import { AssignedProviderUnavailableError } from "./assigned-provider-core";
import { hasTimesheetAction, parseTimesheetActions } from "./hr-timesheet-core";

type AssignedTimesheetPage = Extract<HrTimesheetListResponse, { readonly kind: "assigned" }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export class TimesheetAssignedListError extends Error {
  constructor() {
    super("The assigned Timesheet list is unavailable");
    this.name = "TimesheetAssignedListError";
  }
}

function isGregorianDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function isTimestamp(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  return (
    !!match &&
    isGregorianDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number.isFinite(Date.parse(value))
  );
}

function mediaTypeEssence(response: Response): string | null {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return null;
  let escaped = false;
  let quoted = false;
  for (const character of contentType) {
    if (escaped) escaped = false;
    else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") return null;
  }
  if (quoted || escaped) return null;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

export function buildAssignedTimesheetListPath(cursor?: HrTimesheetAssignedCursor): string {
  const parameters = new URLSearchParams({ pageSize: "50" });
  if (cursor) {
    if (!UUID_PATTERN.test(cursor.timesheetVersionId) || !isTimestamp(cursor.submittedAt)) {
      throw new TimesheetAssignedListError();
    }
    parameters.set("cursorTimesheetVersionId", cursor.timesheetVersionId.toLowerCase());
    parameters.set("cursorSubmittedAt", cursor.submittedAt);
  }
  return `/v1/hr/timesheets/assigned?${parameters}`;
}

async function failure(response: Response): Promise<never> {
  if (mediaTypeEssence(response) !== "application/problem+json") {
    throw new TimesheetAssignedListError();
  }
  let problem: ApiProblemDetails;
  try {
    problem = parseApiProblemDetails(await response.json());
  } catch {
    throw new TimesheetAssignedListError();
  }
  if (problem.status !== response.status) throw new TimesheetAssignedListError();
  if (response.status === 403 && problem.code === "POLICY_DENIED") {
    throw new AssignedProviderUnavailableError("hr_timesheet_assigned", "ineligible");
  }
  if (response.status === 503 && problem.code === "TIMESHEET_SERVICE_INACTIVE") {
    throw new AssignedProviderUnavailableError("hr_timesheet_assigned", "inactive");
  }
  throw new TimesheetAssignedListError();
}

export async function decodeAssignedTimesheetListResponse(
  responsePromise: Promise<Response>,
): Promise<AssignedTimesheetPage> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new TimesheetAssignedListError();
  }
  if (response.status !== 200) return await failure(response);
  if (mediaTypeEssence(response) !== "application/json") {
    throw new TimesheetAssignedListError();
  }
  try {
    const actions = parseTimesheetActions(response);
    if (!hasTimesheetAction(actions, "list_assigned")) throw 0;
    const page = parseHrTimesheetListResponse(await response.json());
    if (page.kind !== "assigned") throw 0;
    return page;
  } catch {
    throw new TimesheetAssignedListError();
  }
}
