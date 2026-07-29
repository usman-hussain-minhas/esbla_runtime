import { isSameOriginPresentationRequest } from "../../../lib/presentation-preferences-core";
import { persistOwnPresentationShortcut } from "../../../lib/presentation-shortcuts";
import {
  PresentationShortcutsError,
  parsePresentationShortcutUpdateRequest,
} from "../../../lib/presentation-shortcuts-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function json(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown): number {
  if (!(error instanceof PresentationShortcutsError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (error.kind === "invalid_input") return 400;
  return 503;
}

export async function POST(request: Request) {
  if (!isSameOriginPresentationRequest(request)) return json({ error: "forbidden" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "invalid_input" }, 415);
  }
  try {
    const input = parsePresentationShortcutUpdateRequest(await request.json());
    const result = await persistOwnPresentationShortcut(
      {
        contextId: input.contextId,
        contextKind: input.contextKind,
        expectedVersion: input.expectedVersion,
        operation: input.operation,
        settingKey: input.settingKey,
        targetId: input.targetId,
      },
      input.idempotencyKey,
    );
    return json(result, 200);
  } catch (error) {
    return json(
      { error: error instanceof PresentationShortcutsError ? error.kind : "unavailable" },
      failureStatus(error),
    );
  }
}
