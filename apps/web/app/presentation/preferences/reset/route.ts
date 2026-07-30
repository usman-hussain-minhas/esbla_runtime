import { resetOwnPresentationPreferences } from "../../../../lib/presentation-preferences";
import {
  isSameOriginPresentationRequest,
  PresentationPreferencesError,
  parsePresentationPreferencesReset,
} from "../../../../lib/presentation-preferences-core";

export const dynamic = "force-dynamic";

function status(error: unknown): number {
  if (!(error instanceof PresentationPreferencesError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (error.kind === "invalid_input") return 400;
  return 503;
}

const json = (body: unknown, responseStatus: number) =>
  Response.json(body, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    status: responseStatus,
  });

export async function POST(request: Request) {
  if (!isSameOriginPresentationRequest(request)) return json({ error: "forbidden" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "invalid_input" }, 415);
  }
  try {
    const input = parsePresentationPreferencesReset(await request.json());
    return json(
      await resetOwnPresentationPreferences(
        { expectedVersion: input.expectedVersion },
        input.idempotencyKey,
      ),
      200,
    );
  } catch (error) {
    return json(
      { error: error instanceof PresentationPreferencesError ? error.kind : "unavailable" },
      status(error),
    );
  }
}
