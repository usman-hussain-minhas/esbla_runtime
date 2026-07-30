import {
  type PresentationSurfaceLayout,
  parseApiProblemDetails,
  parsePresentationSurfaceLayout,
  parseResetPresentationSurfaceOverlayBody,
  parseResetPresentationSurfaceOverlayResponse,
  parseUpdatePresentationSurfaceOverlayBody,
  parseUpdatePresentationSurfaceOverlayResponse,
  type ResetPresentationSurfaceOverlayResponse,
  type UpdatePresentationSurfaceOverlayBody,
  type UpdatePresentationSurfaceOverlayResponse,
} from "@esbla/contracts";

export type PresentationSurfaceErrorKind =
  | "conflict"
  | "forbidden"
  | "invalid_input"
  | "unavailable";

export class PresentationSurfaceError extends Error {
  readonly kind: PresentationSurfaceErrorKind;

  constructor(kind: PresentationSurfaceErrorKind) {
    super("Presentation surface is unavailable");
    this.name = "PresentationSurfaceError";
    this.kind = kind;
  }
}

function errorForStatus(status: number, code: string): PresentationSurfaceError {
  if (status === 403 || code === "POLICY_DENIED" || code === "ACTOR_NOT_ACTIVE_MEMBER") {
    return new PresentationSurfaceError("forbidden");
  }
  if (status === 409 || code === "IDEMPOTENCY_CONFLICT") {
    return new PresentationSurfaceError("conflict");
  }
  if (status === 400) return new PresentationSurfaceError("invalid_input");
  return new PresentationSurfaceError("unavailable");
}

async function strictProblem(response: Response): Promise<PresentationSurfaceError> {
  try {
    const problem = parseApiProblemDetails(await response.json());
    return errorForStatus(response.status, problem.code);
  } catch {
    return new PresentationSurfaceError("unavailable");
  }
}

export async function decodePresentationSurfaceLayoutResponse(
  responsePromise: Promise<Response>,
): Promise<PresentationSurfaceLayout> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationSurfaceError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parsePresentationSurfaceLayout(await response.json());
  } catch {
    throw new PresentationSurfaceError("unavailable");
  }
}

export function parsePresentationSurfaceOverlayUpdate(
  value: unknown,
): UpdatePresentationSurfaceOverlayBody & { readonly idempotencyKey: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("idempotencyKey" in value) ||
    typeof value.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.idempotencyKey,
    )
  ) {
    throw new PresentationSurfaceError("invalid_input");
  }
  try {
    const body = parseUpdatePresentationSurfaceOverlayBody({
      expectedVersion: "expectedVersion" in value ? value.expectedVersion : undefined,
      placements: "placements" in value ? value.placements : undefined,
    });
    return { ...body, idempotencyKey: value.idempotencyKey };
  } catch {
    throw new PresentationSurfaceError("invalid_input");
  }
}

export function parsePresentationSurfaceOverlayReset(value: unknown): {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["expectedVersion", "idempotencyKey"]) ||
    !("idempotencyKey" in value) ||
    typeof value.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.idempotencyKey,
    )
  ) {
    throw new PresentationSurfaceError("invalid_input");
  }
  try {
    return {
      ...parseResetPresentationSurfaceOverlayBody({
        expectedVersion: "expectedVersion" in value ? value.expectedVersion : undefined,
      }),
      idempotencyKey: value.idempotencyKey,
    };
  } catch {
    throw new PresentationSurfaceError("invalid_input");
  }
}

export async function decodePresentationSurfaceOverlayUpdateResponse(
  responsePromise: Promise<Response>,
): Promise<UpdatePresentationSurfaceOverlayResponse> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationSurfaceError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parseUpdatePresentationSurfaceOverlayResponse(await response.json());
  } catch {
    throw new PresentationSurfaceError("unavailable");
  }
}

export async function decodePresentationSurfaceOverlayResetResponse(
  responsePromise: Promise<Response>,
): Promise<ResetPresentationSurfaceOverlayResponse> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationSurfaceError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parseResetPresentationSurfaceOverlayResponse(await response.json());
  } catch {
    throw new PresentationSurfaceError("unavailable");
  }
}
