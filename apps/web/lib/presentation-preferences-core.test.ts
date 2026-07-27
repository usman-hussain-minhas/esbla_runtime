import { describe, expect, it } from "vitest";
import {
  decodePresentationPreferencesResponse,
  isSameOriginPresentationRequest,
  PresentationPreferencesError,
  parsePresentationPreferencesUpdate,
} from "./presentation-preferences-core";

describe("presentation preference web boundary", () => {
  it("accepts exact successful preferences and rejects non-200 success-like bodies", async () => {
    await expect(
      decodePresentationPreferencesResponse(
        Promise.resolve(
          Response.json({
            highContrast: true,
            palette: "dark",
            source: "user_override",
            version: 2,
          }),
        ),
      ),
    ).resolves.toEqual({
      highContrast: true,
      palette: "dark",
      source: "user_override",
      version: 2,
    });
    await expect(
      decodePresentationPreferencesResponse(Promise.resolve(new Response("{}", { status: 201 }))),
    ).rejects.toBeInstanceOf(PresentationPreferencesError);
  });

  it("requires an exact bounded update and UUID idempotency key", () => {
    expect(
      parsePresentationPreferencesUpdate({
        expectedVersion: 0,
        highContrast: false,
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
        palette: "light",
      }),
    ).toEqual({
      expectedVersion: 0,
      highContrast: false,
      idempotencyKey: "93000000-0000-4000-8000-000000000001",
      palette: "light",
    });
    expect(() =>
      parsePresentationPreferencesUpdate({
        expectedVersion: 0,
        highContrast: "high-contrast",
        idempotencyKey: "93000000-0000-4000-8000-000000000001",
        palette: "light",
      }),
    ).toThrow();
  });

  it("accepts the verified forwarded Host origin used by the built Next server", () => {
    expect(
      isSameOriginPresentationRequest(
        new Request("http://localhost:3000/presentation/preferences", {
          headers: {
            host: "127.0.0.1:41901",
            origin: "http://127.0.0.1:41901",
            "sec-fetch-site": "same-origin",
          },
          method: "POST",
        }),
      ),
    ).toBe(true);
  });
});
