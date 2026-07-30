import { persistOwnPresentationPreferences } from "../../../lib/presentation-preferences";
import {
  isSameOriginPresentationRequest,
  PresentationPreferencesError,
  parsePresentationPreferencesUpdate,
} from "../../../lib/presentation-preferences-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function json(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown): number {
  if (!(error instanceof PresentationPreferencesError)) return 503;
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
    const input = parsePresentationPreferencesUpdate(await request.json());
    const result = await persistOwnPresentationPreferences(
      {
        density: input.density,
        expectedVersion: input.expectedVersion,
        highContrast: input.highContrast,
        palette: input.palette,
        reducedMotion: input.reducedMotion,
      },
      input.idempotencyKey,
    );
    return json(result, 200);
  } catch (error) {
    return json(
      { error: error instanceof PresentationPreferencesError ? error.kind : "unavailable" },
      failureStatus(error),
    );
  }
}
