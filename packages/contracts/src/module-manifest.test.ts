import { describe, expect, it } from "vitest";
import { defineModuleManifest } from "./module-manifest.js";

describe("defineModuleManifest", () => {
  it("freezes a module declaration", () => {
    const manifest = defineModuleManifest({
      activation: "inactive_by_default",
      capabilities: [],
      dependencies: [],
      id: "example",
      name: "Example",
      version: "0.1.0",
    });

    expect(Object.isFrozen(manifest)).toBe(true);
  });
});
