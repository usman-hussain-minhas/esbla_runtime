import { describe, expect, it } from "vitest";
import { hrManifest } from "./index.js";

describe("hrManifest", () => {
  it("stays inactive until a complete vertical is proven", () => {
    expect(hrManifest.activation).toBe("inactive_by_default");
    expect(hrManifest.capabilities).toEqual([]);
  });
});
