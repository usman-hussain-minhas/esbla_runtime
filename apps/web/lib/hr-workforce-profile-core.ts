import {
  type HrWorkforceProfile,
  parseApiProblemDetails,
  parseHrWorkforceProfile,
} from "@esbla/contracts";

export type HrWorkforceOwnProfileState =
  | { readonly profile: HrWorkforceProfile; readonly status: "ready" }
  | { readonly status: "inactive" | "not_linked_or_denied" };

export class HrWorkforceProfileViewError extends Error {
  constructor() {
    super("The workforce profile is unavailable");
    this.name = "HrWorkforceProfileViewError";
  }
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export async function decodeOwnWorkforceProfileResponse(
  responsePromise: Promise<Response>,
): Promise<HrWorkforceOwnProfileState> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new HrWorkforceProfileViewError();
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HrWorkforceProfileViewError();
  }

  if (response.status === 200 && mediaType(response) === "application/json") {
    try {
      const profile = parseHrWorkforceProfile(payload);
      if (profile.workforceStatus !== "active" || !profile.principalLinked) {
        throw new TypeError("Own profile is not active and linked");
      }
      return { profile, status: "ready" };
    } catch {
      throw new HrWorkforceProfileViewError();
    }
  }

  if (mediaType(response) !== "application/problem+json") {
    throw new HrWorkforceProfileViewError();
  }
  try {
    const problem = parseApiProblemDetails(payload);
    if (problem.status !== response.status) throw new HrWorkforceProfileViewError();
    if (problem.code === "WORKFORCE_PROFILE_SERVICE_INACTIVE" && response.status === 503) {
      return { status: "inactive" };
    }
    if (
      response.status === 403 &&
      (problem.code === "POLICY_DENIED" || problem.code === "ACTOR_NOT_ACTIVE_MEMBER")
    ) {
      return { status: "not_linked_or_denied" };
    }
  } catch (error) {
    if (error instanceof HrWorkforceProfileViewError) throw error;
    throw new HrWorkforceProfileViewError();
  }
  throw new HrWorkforceProfileViewError();
}
