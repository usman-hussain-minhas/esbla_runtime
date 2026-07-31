import {
  type PresentationSurfaceBaseMutationResponse,
  type PresentationSurfaceBaseWorkspace,
  parseApiProblemDetails,
  parsePresentationSurfaceBaseMutationResponse,
  parsePresentationSurfaceBaseWorkspace,
  parseRollbackPresentationSurfaceBaseBody,
  parseUpsertPresentationSurfaceDraftBody,
  parseUpsertPresentationSurfaceDraftResponse,
  parseValidatePresentationSurfaceDraftBody,
  parseValidatePresentationSurfaceDraftResponse,
  type RollbackPresentationSurfaceBaseBody,
  type UpsertPresentationSurfaceDraftBody,
  type UpsertPresentationSurfaceDraftResponse,
  type ValidatePresentationSurfaceDraftBody,
  type ValidatePresentationSurfaceDraftResponse,
} from "@esbla/contracts";

export type PresentationSurfaceBaseRequestErrorKind =
  | "conflict"
  | "forbidden"
  | "invalid_input"
  | "unavailable";

export class PresentationSurfaceBaseRequestError extends Error {
  readonly kind: PresentationSurfaceBaseRequestErrorKind;

  constructor(kind: PresentationSurfaceBaseRequestErrorKind) {
    super("Presentation surface base is unavailable");
    this.name = "PresentationSurfaceBaseRequestError";
    this.kind = kind;
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function errorForStatus(status: number, code: string): PresentationSurfaceBaseRequestError {
  if (status === 403 || code === "POLICY_DENIED" || code === "ACTOR_NOT_ACTIVE_MEMBER") {
    return new PresentationSurfaceBaseRequestError("forbidden");
  }
  if (status === 409 || code === "IDEMPOTENCY_CONFLICT") {
    return new PresentationSurfaceBaseRequestError("conflict");
  }
  if (status === 400) return new PresentationSurfaceBaseRequestError("invalid_input");
  return new PresentationSurfaceBaseRequestError("unavailable");
}

async function strictProblem(response: Response): Promise<PresentationSurfaceBaseRequestError> {
  try {
    const problem = parseApiProblemDetails(await response.json());
    return errorForStatus(response.status, problem.code);
  } catch {
    return new PresentationSurfaceBaseRequestError("unavailable");
  }
}

async function decodeResponse<T>(
  responsePromise: Promise<Response>,
  parse: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationSurfaceBaseRequestError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parse(await response.json());
  } catch {
    throw new PresentationSurfaceBaseRequestError("unavailable");
  }
}

function idempotencyKey(value: Readonly<Record<string, unknown>>): string {
  if (typeof value.idempotencyKey !== "string" || !uuidPattern.test(value.idempotencyKey)) {
    throw new PresentationSurfaceBaseRequestError("invalid_input");
  }
  return value.idempotencyKey;
}

export function parsePresentationSurfaceDraftRequest(
  value: unknown,
): UpsertPresentationSurfaceDraftBody & { readonly idempotencyKey: string } {
  if (
    !exactRecord(value, [
      "expectedDraftVersion",
      "expectedHeadRowVersion",
      "idempotencyKey",
      "placements",
    ])
  ) {
    throw new PresentationSurfaceBaseRequestError("invalid_input");
  }
  try {
    return {
      ...parseUpsertPresentationSurfaceDraftBody({
        expectedDraftVersion: value.expectedDraftVersion,
        expectedHeadRowVersion: value.expectedHeadRowVersion,
        placements: value.placements,
      }),
      idempotencyKey: idempotencyKey(value),
    };
  } catch {
    throw new PresentationSurfaceBaseRequestError("invalid_input");
  }
}

export function parsePresentationSurfaceDraftValidationRequest(
  value: unknown,
): ValidatePresentationSurfaceDraftBody & { readonly idempotencyKey: string } {
  if (!exactRecord(value, ["expectedDraftVersion", "expectedHeadRowVersion", "idempotencyKey"])) {
    throw new PresentationSurfaceBaseRequestError("invalid_input");
  }
  try {
    return {
      ...parseValidatePresentationSurfaceDraftBody({
        expectedDraftVersion: value.expectedDraftVersion,
        expectedHeadRowVersion: value.expectedHeadRowVersion,
      }),
      idempotencyKey: idempotencyKey(value),
    };
  } catch {
    throw new PresentationSurfaceBaseRequestError("invalid_input");
  }
}

export function parsePresentationSurfaceBaseRollbackRequest(
  value: unknown,
): RollbackPresentationSurfaceBaseBody & { readonly idempotencyKey: string } {
  if (!exactRecord(value, ["expectedHeadRowVersion", "idempotencyKey", "sourceBaseVersion"])) {
    throw new PresentationSurfaceBaseRequestError("invalid_input");
  }
  try {
    return {
      ...parseRollbackPresentationSurfaceBaseBody({
        expectedHeadRowVersion: value.expectedHeadRowVersion,
        sourceBaseVersion: value.sourceBaseVersion,
      }),
      idempotencyKey: idempotencyKey(value),
    };
  } catch {
    throw new PresentationSurfaceBaseRequestError("invalid_input");
  }
}

export function decodePresentationSurfaceBaseWorkspaceResponse(
  responsePromise: Promise<Response>,
): Promise<PresentationSurfaceBaseWorkspace> {
  return decodeResponse(responsePromise, parsePresentationSurfaceBaseWorkspace);
}

export function decodePresentationSurfaceDraftResponse(
  responsePromise: Promise<Response>,
): Promise<UpsertPresentationSurfaceDraftResponse> {
  return decodeResponse(responsePromise, parseUpsertPresentationSurfaceDraftResponse);
}

export function decodePresentationSurfaceDraftValidationResponse(
  responsePromise: Promise<Response>,
): Promise<ValidatePresentationSurfaceDraftResponse> {
  return decodeResponse(responsePromise, parseValidatePresentationSurfaceDraftResponse);
}

export function decodePresentationSurfaceBaseMutationResponse(
  responsePromise: Promise<Response>,
): Promise<PresentationSurfaceBaseMutationResponse> {
  return decodeResponse(responsePromise, parsePresentationSurfaceBaseMutationResponse);
}
