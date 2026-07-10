import { createHash, createHmac } from "node:crypto";

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

function canonicalJson(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Signed JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Signed request bodies must not be circular");
    ancestors.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Signed request bodies must contain plain JSON objects only");
    }
    if (ancestors.has(value)) throw new TypeError("Signed request bodies must not be circular");
    ancestors.add(value);
    try {
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`);
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError("Signed request bodies must contain JSON values only");
}

export function canonicalizeSignedJson(value: unknown): string {
  return canonicalJson(value, new WeakSet());
}

export function createDevelopmentSignaturePayload(input: DevelopmentSignatureInput): string {
  const bodyHash = createHash("sha256")
    .update(canonicalizeSignedJson(input.body ?? null))
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
  return createHmac("sha256", secret)
    .update(createDevelopmentSignaturePayload(input))
    .digest("hex");
}
