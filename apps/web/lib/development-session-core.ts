import { randomUUID } from "node:crypto";
import { signDevelopmentPrincipal } from "@esbla/contracts/development-principal";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MUTATION_METHODS = new Set(["DELETE", "PATCH", "POST", "PUT"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type Environment = Readonly<Record<string, string | undefined>>;

export type DevelopmentSessionErrorCode =
  | "DEVELOPMENT_IDENTITY_FORBIDDEN"
  | "DEVELOPMENT_SESSION_INVALID"
  | "DEVELOPMENT_SECRET_EXPOSURE_FORBIDDEN";

export class DevelopmentSessionError extends Error {
  readonly code: DevelopmentSessionErrorCode;

  constructor(code: DevelopmentSessionErrorCode, message: string) {
    super(message);
    this.name = "DevelopmentSessionError";
    this.code = code;
  }
}

export interface DevelopmentSessionConfig {
  readonly apiBaseUrl: URL;
  readonly label: string;
  readonly principalId: string;
  readonly secret: string;
  readonly tenantId: string;
}

export interface DevelopmentSessionSummary {
  readonly endpoint?: string;
  readonly label: string;
  readonly state: "blocked" | "configured";
}

export interface DevelopmentRequestInput {
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly method: string;
  readonly path: string;
}

export interface PreparedDevelopmentRequest {
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: string;
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_SESSION_INVALID",
      `${name} is required for the development session`,
    );
  }
  return value;
}

function validateUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new DevelopmentSessionError("DEVELOPMENT_SESSION_INVALID", `${name} must be a UUID`);
  }
  return value;
}

export function readDevelopmentSessionConfig(environment: Environment): DevelopmentSessionConfig {
  if (Object.hasOwn(environment, "NEXT_PUBLIC_ESBLA_DEV_AUTH_SECRET")) {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_SECRET_EXPOSURE_FORBIDDEN",
      "The development auth secret must never use a NEXT_PUBLIC environment variable",
    );
  }
  if (environment.NODE_ENV === "production") {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_IDENTITY_FORBIDDEN",
      "Development principal authentication is forbidden in production",
    );
  }

  const apiBaseUrl = new URL(required(environment, "ESBLA_API_BASE_URL"));
  if (
    !["http:", "https:"].includes(apiBaseUrl.protocol) ||
    !LOOPBACK_HOSTS.has(apiBaseUrl.hostname) ||
    apiBaseUrl.username ||
    apiBaseUrl.password ||
    apiBaseUrl.pathname !== "/" ||
    apiBaseUrl.search ||
    apiBaseUrl.hash
  ) {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_SESSION_INVALID",
      "The development API base URL must be an uncredentialed loopback origin",
    );
  }

  const secret = required(environment, "ESBLA_DEV_AUTH_SECRET");
  if (Buffer.byteLength(secret) < 32) {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_SESSION_INVALID",
      "The development auth secret must contain at least 32 bytes",
    );
  }

  return {
    apiBaseUrl,
    label: environment.ESBLA_DEV_SESSION_LABEL?.trim() || "Local development",
    principalId: validateUuid(
      required(environment, "ESBLA_DEV_PRINCIPAL_ID"),
      "ESBLA_DEV_PRINCIPAL_ID",
    ),
    secret,
    tenantId: validateUuid(required(environment, "ESBLA_DEV_TENANT_ID"), "ESBLA_DEV_TENANT_ID"),
  };
}

export function summarizeDevelopmentSession(environment: Environment): DevelopmentSessionSummary {
  try {
    const config = readDevelopmentSessionConfig(environment);
    return {
      endpoint: config.apiBaseUrl.origin,
      label: config.label,
      state: "configured",
    };
  } catch {
    return { label: "Identity pending", state: "blocked" };
  }
}

export function prepareDevelopmentRequest(
  config: DevelopmentSessionConfig,
  input: DevelopmentRequestInput,
  options: {
    readonly clock?: () => Date;
    readonly requestId?: () => string;
  } = {},
): PreparedDevelopmentRequest {
  const method = input.method.toUpperCase();
  if (!input.path.startsWith("/") || input.path.startsWith("//")) {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_SESSION_INVALID",
      "Development API request paths must be origin-relative",
    );
  }
  const target = new URL(input.path, config.apiBaseUrl);
  if (target.origin !== config.apiBaseUrl.origin || target.hash) {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_SESSION_INVALID",
      "Development API requests must remain on the configured loopback origin",
    );
  }
  if (MUTATION_METHODS.has(method)) {
    validateUuid(input.idempotencyKey ?? "", "Idempotency-Key");
  }
  if (!MUTATION_METHODS.has(method) && input.body !== undefined) {
    throw new DevelopmentSessionError(
      "DEVELOPMENT_SESSION_INVALID",
      "Read-only development API requests must not include a body",
    );
  }

  const requestId = validateUuid((options.requestId ?? randomUUID)(), "request ID");
  const timestamp = String(Math.floor((options.clock ?? (() => new Date()))().getTime() / 1000));
  const canonicalUrl = `${target.pathname}${target.search}`;
  const signature = signDevelopmentPrincipal(config.secret, {
    body: input.body,
    method,
    principalId: config.principalId,
    requestId,
    tenantId: config.tenantId,
    timestamp,
    url: canonicalUrl,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-esbla-auth-signature": signature,
    "x-esbla-auth-timestamp": timestamp,
    "x-esbla-principal-id": config.principalId,
    "x-esbla-request-id": requestId,
    "x-esbla-tenant-id": config.tenantId,
  };
  if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
  if (input.body !== undefined) headers["content-type"] = "application/json";

  return {
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    headers,
    method,
    url: target.toString(),
  };
}
