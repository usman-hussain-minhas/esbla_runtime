import { type PlatformNotificationListQuery, parseNotificationListQuery } from "@esbla/contracts";
import { loadOwnNotifications } from "../../../lib/platform-notifications";
import { PlatformNotificationsError } from "../../../lib/platform-notifications-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function json(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const keys = [...parameters.keys()];
    if (new Set(keys).size !== keys.length) {
      throw new PlatformNotificationsError("invalid_input");
    }
    let query: PlatformNotificationListQuery;
    try {
      query = parseNotificationListQuery({
        ...Object.fromEntries(parameters),
        ...(parameters.has("pageSize") ? { pageSize: Number(parameters.get("pageSize")) } : {}),
      });
    } catch {
      throw new PlatformNotificationsError("invalid_input");
    }
    return json(await loadOwnNotifications(query), 200);
  } catch (error) {
    const invalid = error instanceof PlatformNotificationsError && error.kind === "invalid_input";
    return json({ error: invalid ? "invalid_input" : "unavailable" }, invalid ? 400 : 503);
  }
}
