const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HrLeaveReturnContext =
  | "hr-mission-control"
  | "leave-list"
  | "mission-control"
  | "my-work";

export interface HrLeaveReturnLink {
  readonly href: string;
  readonly label: string;
}

export const HR_LEAVE_CANONICAL_HOST_LINK = Object.freeze({
  href: "/workspace/hr/leave",
  label: "Back to My Leave Requests",
}) satisfies HrLeaveReturnLink;

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
): string {
  if (!UUID_PATTERN.test(leaveRequestId)) throw new TypeError("Leave request ID is invalid");
  if (!parseHrLeaveReturnContext(returnContext)) {
    throw new TypeError("Leave return context is invalid");
  }
  if (
    originFocusId !== undefined &&
    (!/^[a-z0-9][a-z0-9.-]{0,159}$/.test(originFocusId) || originFocusId.includes(".."))
  ) {
    throw new TypeError("Leave origin focus ID is invalid");
  }
  const search = new URLSearchParams({ returnContext });
  if (originFocusId) search.set("originFocusId", originFocusId);
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
