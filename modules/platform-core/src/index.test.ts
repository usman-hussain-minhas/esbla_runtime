import { describe, expect, it } from "vitest";
import { platformCoreManifest } from "./index.js";

describe("platformCoreManifest", () => {
  it("is the required root module", () => {
    expect(platformCoreManifest.activation).toBe("required");
    expect(platformCoreManifest.dependencies).toEqual([]);
  });
});
