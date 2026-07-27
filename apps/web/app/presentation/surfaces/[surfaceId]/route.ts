import { parseZenV1SurfaceId } from "@esbla/contracts";
import { isSameOriginPresentationRequest } from "../../../../lib/presentation-preferences-core";
import { persistOwnPresentationSurfaceOverlay } from "../../../../lib/presentation-surfaces";
import {
  PresentationSurfaceError,
  parsePresentationSurfaceOverlayUpdate,
} from "../../../../lib/presentation-surfaces-core";

export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function json(body: unknown, status: number) {
  return Response.json(body, { headers: responseHeaders, status });
}

function failureStatus(error: unknown): number {
  if (!(error instanceof PresentationSurfaceError)) return 503;
  if (error.kind === "forbidden") return 403;
  if (error.kind === "conflict") return 409;
  if (error.kind === "invalid_input") return 400;
  return 503;
}

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly surfaceId: string }> },
) {
  if (!isSameOriginPresentationRequest(request)) return json({ error: "forbidden" }, 403);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "invalid_input" }, 415);
  }
  let surfaceId: ReturnType<typeof parseZenV1SurfaceId>;
  let input: ReturnType<typeof parsePresentationSurfaceOverlayUpdate>;
  try {
    surfaceId = parseZenV1SurfaceId((await context.params).surfaceId);
    input = parsePresentationSurfaceOverlayUpdate(await request.json());
  } catch {
    return json({ error: "invalid_input" }, 400);
  }
  try {
    const result = await persistOwnPresentationSurfaceOverlay(
      surfaceId,
      {
        expectedVersion: input.expectedVersion,
        placements: input.placements,
      },
      input.idempotencyKey,
    );
    return json(result, 200);
  } catch (error) {
    return json(
      { error: error instanceof PresentationSurfaceError ? error.kind : "unavailable" },
      failureStatus(error),
    );
  }
}
