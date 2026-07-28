import type { PresentationWidgetState } from "@esbla/contracts";
import { HrLeaveListError } from "../../../../lib/hr-leave-list-core";

export type HrLeaveWidgetState = PresentationWidgetState;

export interface HrLeaveWidgetFailureState {
  readonly description: string;
  readonly heading: string;
  readonly state: Extract<
    HrLeaveWidgetState,
    "not_found" | "operational_error" | "permission_denied" | "service_inactive" | "unavailable"
  >;
}

const knownStates = {
  denied: {
    description:
      "Your current permissions do not allow this list to be shown. Access must be granted before retrying.",
    heading: "Leave requests are hidden",
    state: "permission_denied",
  },
  error: {
    description: "The service returned an error. Reload this page to try the read again.",
    heading: "Leave could not be loaded",
    state: "operational_error",
  },
  inactive: {
    description:
      "Leave Request is not active for this tenant. A tenant administrator can activate it.",
    heading: "Leave service is inactive",
    state: "service_inactive",
  },
  not_found: {
    description:
      "The registered Leave list is no longer available. Return later after it is restored.",
    heading: "Leave list was not found",
    state: "not_found",
  },
  unavailable: {
    description: "The service could not be reached. Reload this page to try the read again.",
    heading: "Leave is unavailable",
    state: "unavailable",
  },
} as const satisfies Readonly<Record<HrLeaveListError["kind"], HrLeaveWidgetFailureState>>;

export function resolveHrLeaveWidgetFailureState(error: unknown): HrLeaveWidgetFailureState {
  if (error instanceof HrLeaveListError) return knownStates[error.kind];
  return {
    description: "The widget hit an unexpected problem. Reload this page to try the read again.",
    heading: "Leave could not be loaded",
    state: "operational_error",
  };
}

export const HR_LEAVE_WIDGET_TIMEOUT_STATE = Object.freeze({
  description: "The Leave read took too long. Reload this page to try it again.",
  heading: "Leave is taking too long",
  state: "unavailable",
} as const satisfies HrLeaveWidgetFailureState);
