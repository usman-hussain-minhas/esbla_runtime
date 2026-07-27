import { HrLeaveListError } from "../../../../lib/hr-leave-list-core";

export type HrLeaveWidgetState =
  | "denied"
  | "empty"
  | "error"
  | "inactive"
  | "loading"
  | "not-found"
  | "populated"
  | "unavailable";

export interface HrLeaveWidgetFailureState {
  readonly description: string;
  readonly heading: string;
  readonly state: Exclude<HrLeaveWidgetState, "empty" | "loading" | "populated">;
}

const knownStates = {
  denied: {
    description: "Your current permissions do not allow this list to be shown.",
    heading: "Leave requests are hidden",
    state: "denied",
  },
  error: {
    description: "The service returned an error. No private error detail is shown.",
    heading: "Leave could not be loaded",
    state: "error",
  },
  inactive: {
    description: "Leave Request is not active for this tenant.",
    heading: "Leave service is inactive",
    state: "inactive",
  },
  not_found: {
    description: "The registered Leave list is no longer available.",
    heading: "Leave list was not found",
    state: "not-found",
  },
  unavailable: {
    description: "The service could not be reached. No private error detail is shown.",
    heading: "Leave is unavailable",
    state: "unavailable",
  },
} as const satisfies Readonly<Record<HrLeaveListError["kind"], HrLeaveWidgetFailureState>>;

export function resolveHrLeaveWidgetFailureState(error: unknown): HrLeaveWidgetFailureState {
  if (error instanceof HrLeaveListError) return knownStates[error.kind];
  return {
    description: "The widget hit an unexpected problem. No private error detail is shown.",
    heading: "Leave could not be loaded",
    state: "error",
  };
}
