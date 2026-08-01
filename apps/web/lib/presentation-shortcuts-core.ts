import {
  type PresentationShortcutDiscovery,
  type PresentationShortcutDiscoveryQuery,
  type PresentationShortcutSet,
  parseApiProblemDetails,
  parsePresentationShortcutDiscovery,
  parsePresentationShortcutDiscoveryQuery,
  parseUpdatePresentationShortcutBody,
  parseUpdatePresentationShortcutResponse,
  type UpdatePresentationShortcutBody,
  type UpdatePresentationShortcutResponse,
} from "@esbla/contracts";

export type PresentationShortcutsErrorKind =
  | "conflict"
  | "forbidden"
  | "invalid_input"
  | "unavailable";

export class PresentationShortcutsError extends Error {
  readonly kind: PresentationShortcutsErrorKind;

  constructor(kind: PresentationShortcutsErrorKind) {
    super("Presentation shortcuts are unavailable");
    this.name = "PresentationShortcutsError";
    this.kind = kind;
  }
}

function errorForStatus(status: number, code: string): PresentationShortcutsError {
  if (status === 403 || code === "POLICY_DENIED" || code === "ACTOR_NOT_ACTIVE_MEMBER") {
    return new PresentationShortcutsError("forbidden");
  }
  if (status === 409 || code === "IDEMPOTENCY_CONFLICT") {
    return new PresentationShortcutsError("conflict");
  }
  if (status === 400 || code === "SETTING_INVALID") {
    return new PresentationShortcutsError("invalid_input");
  }
  return new PresentationShortcutsError("unavailable");
}

async function strictProblem(response: Response): Promise<PresentationShortcutsError> {
  try {
    const problem = parseApiProblemDetails(await response.json());
    return errorForStatus(response.status, problem.code);
  } catch {
    return new PresentationShortcutsError("unavailable");
  }
}

export function buildPresentationShortcutsPath(
  query: PresentationShortcutDiscoveryQuery = {},
): string {
  let parsed: PresentationShortcutDiscoveryQuery;
  try {
    parsed = parsePresentationShortcutDiscoveryQuery(query);
  } catch {
    throw new PresentationShortcutsError("invalid_input");
  }
  if (parsed.contextServiceGroupId) {
    const parameters = new URLSearchParams({
      contextServiceGroupId: parsed.contextServiceGroupId,
    });
    return `/v1/platform/presentation/shortcuts?${parameters.toString()}`;
  }
  if (!parsed.contextSurfaceId) return "/v1/platform/presentation/shortcuts";
  const parameters = new URLSearchParams({ contextSurfaceId: parsed.contextSurfaceId });
  return `/v1/platform/presentation/shortcuts?${parameters.toString()}`;
}

export async function decodePresentationShortcutDiscoveryResponse(
  responsePromise: Promise<Response>,
): Promise<PresentationShortcutDiscovery> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationShortcutsError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parsePresentationShortcutDiscovery(await response.json());
  } catch {
    throw new PresentationShortcutsError("unavailable");
  }
}

export async function decodePresentationShortcutUpdateResponse(
  responsePromise: Promise<Response>,
): Promise<UpdatePresentationShortcutResponse> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PresentationShortcutsError("unavailable");
  }
  if (response.status !== 200) throw await strictProblem(response);
  try {
    return parseUpdatePresentationShortcutResponse(await response.json());
  } catch {
    throw new PresentationShortcutsError("unavailable");
  }
}

export function parsePresentationShortcutUpdateRequest(
  value: unknown,
): UpdatePresentationShortcutBody & { readonly idempotencyKey: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          "contextId",
          "contextKind",
          "expectedVersion",
          "idempotencyKey",
          "operation",
          "settingKey",
          "targetId",
        ].sort(),
      ) ||
    !("idempotencyKey" in value) ||
    typeof value.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.idempotencyKey,
    )
  ) {
    throw new PresentationShortcutsError("invalid_input");
  }
  try {
    const body = parseUpdatePresentationShortcutBody({
      contextId: "contextId" in value ? value.contextId : undefined,
      contextKind: "contextKind" in value ? value.contextKind : undefined,
      expectedVersion: "expectedVersion" in value ? value.expectedVersion : undefined,
      operation: "operation" in value ? value.operation : undefined,
      settingKey: "settingKey" in value ? value.settingKey : undefined,
      targetId: "targetId" in value ? value.targetId : undefined,
    });
    return { ...body, idempotencyKey: value.idempotencyKey };
  } catch {
    throw new PresentationShortcutsError("invalid_input");
  }
}

export function replacePresentationShortcutSet(
  discovery: PresentationShortcutDiscovery,
  replacement: PresentationShortcutSet,
): PresentationShortcutDiscovery {
  if (
    replacement.settingKey === "navigation.universal_shortcuts.v1" &&
    replacement.contextKind === "global" &&
    replacement.contextId === "global"
  ) {
    return { ...discovery, universal: replacement };
  }
  if (
    replacement.settingKey === "navigation.contextual_shortcuts.v1" &&
    discovery.contextual?.contextKind === replacement.contextKind &&
    discovery.contextual.contextId === replacement.contextId
  ) {
    return { ...discovery, contextual: replacement };
  }
  throw new PresentationShortcutsError("unavailable");
}
