import "server-only";

import { fetchDevelopmentApi } from "./development-session";
import {
  buildWorkforceListApiPath,
  decodeWorkforceListResponse,
  parseWorkforceListNavigation,
  type WorkforceListFailureState,
  type WorkforceListNavigation,
  type WorkforceListView,
  workforceListStateForError,
} from "./hr-workforce-profile-list-core";

export type WorkforceListLoadState =
  | (WorkforceListFailureState & { readonly navigation: WorkforceListNavigation })
  | {
      readonly navigation: WorkforceListNavigation;
      readonly page: Awaited<ReturnType<typeof decodeWorkforceListResponse>>;
      readonly status: "success";
    };

function fallbackNavigation(view: WorkforceListView): WorkforceListNavigation {
  return view === "workforce" ? { status: "active", view } : { view };
}

export async function loadAuthorizedWorkforceList(
  searchParams: Record<string, string | string[] | undefined>,
  view: WorkforceListView,
): Promise<WorkforceListLoadState> {
  let navigation: WorkforceListNavigation;
  try {
    navigation = parseWorkforceListNavigation(searchParams, view);
  } catch (error) {
    return { ...workforceListStateForError(error), navigation: fallbackNavigation(view) };
  }
  try {
    return {
      navigation,
      page: await decodeWorkforceListResponse(
        fetchDevelopmentApi({ method: "GET", path: buildWorkforceListApiPath(navigation) }),
        navigation,
      ),
      status: "success",
    };
  } catch (error) {
    return { ...workforceListStateForError(error), navigation };
  }
}
