import { describe, expect, it } from "vitest";
import {
  canonicalizeSignedJson,
  createDevelopmentSignaturePayload,
  signDevelopmentPrincipal,
} from "./development-principal.js";

const input = {
  body: { nested: { z: true, a: 1 }, list: ["one", false, null] },
  idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  method: "post",
  principalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  timestamp: "1777777777",
  url: "/v1/example?view=own",
} as const;

describe("development principal signing contract", () => {
  it("canonicalizes object keys independently of insertion order", () => {
    expect(canonicalizeSignedJson({ z: 2, a: { y: 1, b: true } })).toBe(
      canonicalizeSignedJson({ a: { b: true, y: 1 }, z: 2 }),
    );
    expect(
      signDevelopmentPrincipal("a secure development secret of 32+ bytes", input),
    ).toHaveLength(64);
  });

  it("binds the method, URL, identity, idempotency key, timestamp, and body hash", () => {
    const payload = createDevelopmentSignaturePayload(input);
    expect(payload).toContain("esbla-development-principal-v1\nPOST\n/v1/example?view=own");
    expect(payload).toContain(input.tenantId);
    expect(payload).toContain(input.idempotencyKey);
    expect(payload.split("\n")).toHaveLength(9);
  });

  it("rejects values that do not have stable JSON meaning", () => {
    expect(() => canonicalizeSignedJson(Number.NaN)).toThrow("finite");
    expect(() => canonicalizeSignedJson(new Date())).toThrow("plain JSON objects");
    expect(() => canonicalizeSignedJson([undefined])).toThrow("JSON values only");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalizeSignedJson(circular)).toThrow("circular");
  });
});
