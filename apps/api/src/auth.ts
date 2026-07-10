import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { OperationContext } from "@esbla/platform-core";
import type { FastifyRequest } from "fastify";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

export type AuthErrorCode =
  | "AUTH_CONFIGURATION_INVALID"
  | "AUTH_EXPIRED"
  | "AUTH_INVALID"
  | "AUTH_REQUIRED";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export interface AuthenticatedPrincipal {
  readonly operationContext: OperationContext;
  readonly requestId: string;
}

export type RequestAuthenticator = (
  request: FastifyRequest,
) => Promise<AuthenticatedPrincipal> | AuthenticatedPrincipal;

export interface DevelopmentSignatureInput {
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly method: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly tenantId: string;
  readonly timestamp: string;
  readonly url: string;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Signed JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Signed request bodies must contain JSON values only");
}

function signaturePayload(input: DevelopmentSignatureInput): string {
  const bodyHash = createHash("sha256")
    .update(canonicalJson(input.body ?? null))
    .digest("hex");
  return [
    "esbla-development-principal-v1",
    input.method.toUpperCase(),
    input.url,
    input.tenantId,
    input.principalId,
    input.requestId,
    input.idempotencyKey ?? "",
    input.timestamp,
    bodyHash,
  ].join("\n");
}

export function signDevelopmentPrincipal(secret: string, input: DevelopmentSignatureInput): string {
  return createHmac("sha256", secret).update(signaturePayload(input)).digest("hex");
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createDevelopmentAuthenticator(options: {
  readonly clock?: () => Date;
  readonly environment?: string;
  readonly maxAgeSeconds?: number;
  readonly secret: string;
}): RequestAuthenticator {
  if (options.environment === "production") {
    throw new AuthError(
      "AUTH_CONFIGURATION_INVALID",
      "Development principal authentication is forbidden in production",
    );
  }
  if (Buffer.byteLength(options.secret) < 32) {
    throw new AuthError(
      "AUTH_CONFIGURATION_INVALID",
      "Development auth secret must contain at least 32 bytes",
    );
  }
  const clock = options.clock ?? (() => new Date());
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new AuthError(
      "AUTH_CONFIGURATION_INVALID",
      "Development signature lifetime must be a positive integer",
    );
  }

  return (request) => {
    const tenantId = header(request, "x-esbla-tenant-id");
    const principalId = header(request, "x-esbla-principal-id");
    const requestId = header(request, "x-esbla-request-id");
    const timestamp = header(request, "x-esbla-auth-timestamp");
    const signature = header(request, "x-esbla-auth-signature");
    const idempotencyKey = header(request, "idempotency-key");
    if (!tenantId || !principalId || !requestId || !timestamp || !signature) {
      throw new AuthError("AUTH_REQUIRED", "Signed development principal headers are required");
    }
    if (
      !UUID_PATTERN.test(tenantId) ||
      !UUID_PATTERN.test(principalId) ||
      !UUID_PATTERN.test(requestId) ||
      !SIGNATURE_PATTERN.test(signature)
    ) {
      throw new AuthError("AUTH_INVALID", "Signed development principal headers are invalid");
    }
    if (request.method === "POST" && (!idempotencyKey || !UUID_PATTERN.test(idempotencyKey))) {
      throw new AuthError("AUTH_REQUIRED", "A UUID Idempotency-Key is required for mutations");
    }
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(clock().getTime() / 1000);
    if (!Number.isSafeInteger(timestampSeconds)) {
      throw new AuthError("AUTH_INVALID", "Authentication timestamp is invalid");
    }
    if (Math.abs(nowSeconds - timestampSeconds) > maxAgeSeconds) {
      throw new AuthError("AUTH_EXPIRED", "Signed development principal has expired");
    }

    const expected = signDevelopmentPrincipal(options.secret, {
      body: request.body,
      method: request.method,
      principalId,
      requestId,
      tenantId,
      timestamp,
      url: request.url,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const expectedBuffer = Buffer.from(expected, "hex");
    const actualBuffer = Buffer.from(signature, "hex");
    if (
      expectedBuffer.length !== actualBuffer.length ||
      !timingSafeEqual(expectedBuffer, actualBuffer)
    ) {
      throw new AuthError("AUTH_INVALID", "Signed development principal did not verify");
    }

    return {
      operationContext: {
        actorPrincipalId: principalId,
        correlationId: idempotencyKey ?? requestId,
        tenantId,
      },
      requestId,
    };
  };
}
