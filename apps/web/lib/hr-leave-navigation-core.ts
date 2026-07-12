const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HrLeaveReturnContext = "leave-list" | "my-work";

export interface HrLeaveReturnLink {
  readonly href: string;
  readonly label: string;
}

export function parseHrLeaveReturnContext(value: unknown): HrLeaveReturnContext | undefined {
  return value === "leave-list" || value === "my-work" ? value : undefined;
}

export function buildHrLeaveDetailHref(
  leaveRequestId: string,
  returnContext: HrLeaveReturnContext,
): string {
  if (!UUID_PATTERN.test(leaveRequestId)) throw new TypeError("Leave request ID is invalid");
  if (returnContext !== "leave-list" && returnContext !== "my-work") {
    throw new TypeError("Leave return context is invalid");
  }
  return `/workspace/hr/leave/${leaveRequestId}?returnContext=${returnContext}`;
}

export function getHrLeaveReturnLink(
  returnContext: HrLeaveReturnContext | undefined,
): HrLeaveReturnLink | undefined {
  if (returnContext === "leave-list") {
    return { href: "/workspace/hr/leave", label: "Back to My Leave Requests" };
  }
  if (returnContext === "my-work") {
    return { href: "/workspace/my-work", label: "Back to My Work" };
  }
  return undefined;
}
