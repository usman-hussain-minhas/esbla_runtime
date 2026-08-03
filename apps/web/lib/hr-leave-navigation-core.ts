const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export type HrLeaveReturnContext =
  | "hr-mission-control"
  | "leave-list"
  | "mission-control"
  | "my-work";

export type HrLeaveListReturnContext = Exclude<HrLeaveReturnContext, "my-work">;

export interface HrLeaveFocusNavigation {
  readonly originFocusId?: string;
  readonly returnContext: HrLeaveListReturnContext;
}

export interface HrLeaveReturnLink {
  readonly href: string;
  readonly label: string;
}

export interface HrLeaveListCursor {
  readonly leaveRequestId: string;
  readonly submittedAt: string;
}

export const HR_LEAVE_CANONICAL_HOST_LINK = Object.freeze({
  href: "/workspace/hr/leave",
  label: "Back to My Leave Requests",
}) satisfies HrLeaveReturnLink;

function validateOriginFocusId(originFocusId: string | undefined): void {
  if (
    originFocusId !== undefined &&
    (!/^[a-z0-9][a-z0-9.-]{0,159}$/.test(originFocusId) || originFocusId.includes(".."))
  ) {
    throw new TypeError("Leave origin focus ID is invalid");
  }
}

function isGregorianDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

function isStrictTimestamp(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  return (
    match !== null &&
    isGregorianDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number.isFinite(Date.parse(value))
  );
}

function appendFocusNavigation(search: URLSearchParams, navigation: HrLeaveFocusNavigation): void {
  validateOriginFocusId(navigation.originFocusId);
  if (navigation.returnContext !== "leave-list" && !navigation.originFocusId) {
    throw new TypeError("Leave origin focus ID is required");
  }
  search.set("returnContext", navigation.returnContext);
  if (navigation.originFocusId) search.set("originFocusId", navigation.originFocusId);
}

export function buildHrLeaveListHref(
  navigation?: HrLeaveFocusNavigation,
  cursor?: HrLeaveListCursor,
): string {
  const search = new URLSearchParams();
  if (cursor) {
    if (!UUID_PATTERN.test(cursor.leaveRequestId) || !isStrictTimestamp(cursor.submittedAt)) {
      throw new TypeError("Leave cursor is invalid");
    }
    search.set("cursorLeaveRequestId", cursor.leaveRequestId);
    search.set("cursorSubmittedAt", cursor.submittedAt);
  }
  if (navigation?.returnContext === "mission-control") {
    validateOriginFocusId(navigation.originFocusId);
    if (!navigation.originFocusId) throw new TypeError("Leave origin focus ID is required");
    search.set("originFocusId", navigation.originFocusId);
    search.set("returnSurface", "mission-control");
  } else if (navigation?.returnContext === "hr-mission-control") {
    validateOriginFocusId(navigation.originFocusId);
    if (!navigation.originFocusId) throw new TypeError("Leave origin focus ID is required");
    search.set("originFocusId", navigation.originFocusId);
    search.set("returnSurface", "hr-mission-control");
  }
  const query = search.toString();
  return query ? `/workspace/hr/leave?${query}` : "/workspace/hr/leave";
}

export function parseHrLeaveListCursor(
  search: Readonly<Record<string, string | readonly string[] | undefined>>,
): HrLeaveListCursor | undefined {
  const leaveRequestIdPresent = Object.hasOwn(search, "cursorLeaveRequestId");
  const submittedAtPresent = Object.hasOwn(search, "cursorSubmittedAt");
  if (!leaveRequestIdPresent && !submittedAtPresent) return undefined;
  if (
    !leaveRequestIdPresent ||
    !submittedAtPresent ||
    typeof search.cursorLeaveRequestId !== "string" ||
    typeof search.cursorSubmittedAt !== "string" ||
    !UUID_PATTERN.test(search.cursorLeaveRequestId) ||
    !isStrictTimestamp(search.cursorSubmittedAt)
  ) {
    throw new TypeError("Leave cursor is invalid");
  }
  return Object.freeze({
    leaveRequestId: search.cursorLeaveRequestId,
    submittedAt: search.cursorSubmittedAt,
  });
}

export function buildHrLeaveNewHref(navigation?: HrLeaveFocusNavigation): string {
  if (!navigation) return "/workspace/hr/leave/new";
  const search = new URLSearchParams();
  appendFocusNavigation(search, navigation);
  return `/workspace/hr/leave/new?${search}`;
}

export function parseHrLeaveReturnContext(value: unknown): HrLeaveReturnContext | undefined {
  return value === "hr-mission-control" ||
    value === "leave-list" ||
    value === "mission-control" ||
    value === "my-work"
    ? value
    : undefined;
}

export function buildHrLeaveDetailHref(
  leaveRequestId: string,
  returnContext: HrLeaveReturnContext,
  originFocusId?: string,
  listCursor?: HrLeaveListCursor,
): string {
  if (!UUID_PATTERN.test(leaveRequestId)) throw new TypeError("Leave request ID is invalid");
  if (!parseHrLeaveReturnContext(returnContext)) {
    throw new TypeError("Leave return context is invalid");
  }
  validateOriginFocusId(originFocusId);
  const search = new URLSearchParams({ returnContext });
  if (originFocusId) search.set("originFocusId", originFocusId);
  if (listCursor) {
    const cursor = parseHrLeaveListCursor({
      cursorLeaveRequestId: listCursor.leaveRequestId,
      cursorSubmittedAt: listCursor.submittedAt,
    });
    if (!cursor) throw new TypeError("Leave cursor is invalid");
    search.set("cursorLeaveRequestId", cursor.leaveRequestId);
    search.set("cursorSubmittedAt", cursor.submittedAt);
  }
  return `/workspace/hr/leave/${leaveRequestId}?${search}`;
}

export function getHrLeaveReturnLink(
  returnContext: HrLeaveReturnContext | undefined,
): HrLeaveReturnLink | undefined {
  if (returnContext === "leave-list") {
    return HR_LEAVE_CANONICAL_HOST_LINK;
  }
  if (returnContext === "my-work") {
    return { href: "/workspace/my-work", label: "Back to My Work" };
  }
  if (returnContext === "mission-control") {
    return { href: "/", label: "Back to Mission Control" };
  }
  if (returnContext === "hr-mission-control") {
    return { href: "/workspace/hr", label: "Back to HR Mission Control" };
  }
  return undefined;
}

export function parseHrLeaveOriginFocusId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9.-]{0,159}$/.test(value) &&
    !value.includes("..")
    ? value
    : undefined;
}
