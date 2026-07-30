import {
  type PresentationPreferences,
  parseApiProblemDetails,
  parsePresentationPreferences,
  parseResetPresentationPreferencesBody,
  parseUpdatePresentationPreferencesBody,
  parseUpdatePresentationPreferencesResponse,
  parseUpdateTenantPresentationDefaultsBody,
  type ResetPresentationPreferencesBody,
  type UpdatePresentationPreferencesBody,
  type UpdatePresentationPreferencesResponse,
  type UpdateTenantPresentationDefaultsBody,
} from "@esbla/contracts";

export type PresentationPreferencesErrorKind =
  | "conflict"
  | "forbidden"
  | "invalid_input"
  | "unavailable";

export class PresentationPreferencesError extends Error {
  readonly kind: PresentationPreferencesErrorKind;

  constructor(kind: PresentationPreferencesErrorKind) {
    super("Presentation preferences are unavailable");
    this.name = "PresentationPreferencesError";
    this.kind = kind;
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function errorForStatus(status: number, code: string): PresentationPreferencesError {
  if (status === 403 || code === "POLICY_DENIED" || code === "ACTOR_NOT_ACTIVE_MEMBER") {
    return new PresentationPreferencesError("forbidden");
  }
  if (status === 409 || code === "IDEMPOTENCY_CONFLICT") {
    return new PresentationPreferencesError("conflict");
  }
  if (status === 400) return new PresentationPreferencesError("invalid_input");
  return new PresentationPreferencesError("unavailable");
}

async function strictProblem(response: Response): Promise<PresentationPreferencesError> {
  try {
    const problem = parseApiProblemDetails(await response.json());
    return errorForStatus(response.status, problem.code);
  } catch {
    return new PresentationPreferencesError("unavailable");
  }
}

export async function decodePresentationPreferencesResponse(
  responsePromise: Promise<Response>,
): Promise<PresentationPreferences> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationPreferencesError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parsePresentationPreferences(await response.json());
  } catch {
    throw new PresentationPreferencesError("unavailable");
  }
}

export function parsePresentationPreferencesUpdate(
  value: unknown,
): UpdatePresentationPreferencesBody & { readonly idempotencyKey: string } {
  if (
    !hasExactKeys(value, [
      "density",
      "expectedVersion",
      "highContrast",
      "idempotencyKey",
      "palette",
      "reducedMotion",
    ]) ||
    typeof value.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.idempotencyKey,
    )
  ) {
    throw new PresentationPreferencesError("invalid_input");
  }
  try {
    const body = parseUpdatePresentationPreferencesBody({
      density: "density" in value ? value.density : undefined,
      expectedVersion: "expectedVersion" in value ? value.expectedVersion : undefined,
      highContrast: "highContrast" in value ? value.highContrast : undefined,
      palette: "palette" in value ? value.palette : undefined,
      reducedMotion: "reducedMotion" in value ? value.reducedMotion : undefined,
    });
    return { ...body, idempotencyKey: value.idempotencyKey };
  } catch {
    throw new PresentationPreferencesError("invalid_input");
  }
}

function idempotencyKey(value: unknown): string {
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
    throw new PresentationPreferencesError("invalid_input");
  }
  return value.idempotencyKey;
}

export function parseTenantPresentationDefaultsUpdate(
  value: unknown,
): UpdateTenantPresentationDefaultsBody & { readonly idempotencyKey: string } {
  const key = idempotencyKey(value);
  try {
    if (
      !hasExactKeys(value, [
        "density",
        "expectedVersion",
        "highContrast",
        "idempotencyKey",
        "lockDensity",
        "palette",
        "reducedMotion",
        "requireHighContrast",
        "requireReducedMotion",
      ])
    ) {
      throw new Error("invalid");
    }
    const body = parseUpdateTenantPresentationDefaultsBody({
      density: "density" in value ? value.density : undefined,
      expectedVersion: "expectedVersion" in value ? value.expectedVersion : undefined,
      highContrast: "highContrast" in value ? value.highContrast : undefined,
      lockDensity: "lockDensity" in value ? value.lockDensity : undefined,
      palette: "palette" in value ? value.palette : undefined,
      reducedMotion: "reducedMotion" in value ? value.reducedMotion : undefined,
      requireHighContrast: "requireHighContrast" in value ? value.requireHighContrast : undefined,
      requireReducedMotion:
        "requireReducedMotion" in value ? value.requireReducedMotion : undefined,
    });
    return { ...body, idempotencyKey: key };
  } catch {
    throw new PresentationPreferencesError("invalid_input");
  }
}

export function parsePresentationPreferencesReset(
  value: unknown,
): ResetPresentationPreferencesBody & { readonly idempotencyKey: string } {
  const key = idempotencyKey(value);
  try {
    if (!hasExactKeys(value, ["expectedVersion", "idempotencyKey"])) {
      throw new Error("invalid");
    }
    return {
      ...parseResetPresentationPreferencesBody({
        expectedVersion: "expectedVersion" in value ? value.expectedVersion : undefined,
      }),
      idempotencyKey: key,
    };
  } catch {
    throw new PresentationPreferencesError("invalid_input");
  }
}

export async function decodePresentationPreferencesUpdateResponse(
  responsePromise: Promise<Response>,
): Promise<UpdatePresentationPreferencesResponse> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationPreferencesError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parseUpdatePresentationPreferencesResponse(await response.json());
  } catch {
    throw new PresentationPreferencesError("unavailable");
  }
}

export function isSameOriginPresentationRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite !== null && fetchSite !== "same-origin")) return false;
  try {
    const requestUrl = new URL(request.url);
    const originUrl = new URL(origin);
    if (requestUrl.origin === originUrl.origin) return true;
    if (!host || !["http:", "https:"].includes(requestUrl.protocol)) return false;
    const normalizedHost = host.toLowerCase();
    const effectiveUrl = new URL(`${requestUrl.protocol}//${normalizedHost}`);
    return effectiveUrl.host === normalizedHost && originUrl.origin === effectiveUrl.origin;
  } catch {
    return false;
  }
}
