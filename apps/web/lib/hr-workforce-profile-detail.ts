import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  buildWorkforceDetailApiPath,
  decodeWorkforceDetailResponse,
  parseWorkforceDetailNavigation,
  type WorkforceDetailNavigation,
  type WorkforceProfileDetailFailureState,
  workforceDetailStateForError,
} from "./hr-workforce-profile-detail-core";

export type WorkforceProfileDetailLoadState =
  | (WorkforceProfileDetailFailureState & { readonly navigation: WorkforceDetailNavigation })
  | {
      readonly detail: Awaited<ReturnType<typeof decodeWorkforceDetailResponse>>;
      readonly navigation: WorkforceDetailNavigation;
      readonly status: "success";
    };

export async function loadAuthorizedWorkforceProfileDetail(
  workerProfileId: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<WorkforceProfileDetailLoadState> {
  let navigation: WorkforceDetailNavigation;
  try {
    navigation = parseWorkforceDetailNavigation(searchParams);
  } catch (error) {
    return { ...workforceDetailStateForError(error), navigation: { returnContext: null } };
  }
  try {
    return {
      detail: await decodeWorkforceDetailResponse(
        fetchDevelopmentApi({
          method: "GET",
          path: buildWorkforceDetailApiPath(workerProfileId, navigation),
        }),
        workerProfileId,
      ),
      navigation,
      status: "success",
    };
  } catch (error) {
    return { ...workforceDetailStateForError(error), navigation };
  }
}
