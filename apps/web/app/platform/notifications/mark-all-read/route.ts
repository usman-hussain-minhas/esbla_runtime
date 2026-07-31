import { persistAllOwnNotificationsRead } from "../../../../lib/platform-notifications";
import {
  isSameOriginNotificationRequest,
  PlatformNotificationsError,
  parseNotificationMarkAllRequest,
} from "../../../../lib/platform-notifications-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function json(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown): number {
  if (!(error instanceof PlatformNotificationsError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (error.kind === "invalid_input") return 400;
  return 503;
}

export async function POST(request: Request) {
  if (!isSameOriginNotificationRequest(request)) return json({ error: "forbidden" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "invalid_input" }, 415);
  }
  try {
    const input = parseNotificationMarkAllRequest(await request.json());
    return json(
      await persistAllOwnNotificationsRead(
        {
          beforeOccurredAt: input.beforeOccurredAt,
          expectedUnreadCount: input.expectedUnreadCount,
        },
        input.idempotencyKey,
      ),
      200,
    );
  } catch (error) {
    return json(
      { error: error instanceof PlatformNotificationsError ? error.kind : "unavailable" },
      failureStatus(error),
    );
  }
}
