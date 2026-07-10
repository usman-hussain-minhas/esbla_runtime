import { describe, expect, it } from "vitest";
import { workspaceManifest } from "./index.js";

describe("Workspace Task passenger manifest reuse contract", () => {
  it("keeps Workspace inactive until Core activation and depends on platform core", () => {
    expect(workspaceManifest.activation).toBe("inactive_by_default");
    expect(workspaceManifest.dependencies).toEqual(["platform_core"]);
    expect(workspaceManifest.id).toBe("workspace");
    expect(workspaceManifest.version).toBe("0.1.0");
  });

  it("declares bounded tenant capabilities without provider, money, or deployment exposure", () => {
    const exposures = new Set(
      workspaceManifest.capabilities.map((capability) => capability.exposure),
    );
    expect(exposures).toEqual(new Set(["tenant"]));
    expect(workspaceManifest.capabilities.map((capability) => capability.id).sort()).toEqual([
      "workspace.task.complete",
      "workspace.task.create",
      "workspace.task.list_assigned",
      "workspace.task.view",
    ]);
    expect(workspaceManifest.capabilities).not.toContainEqual({
      exposure: "integration",
      id: expect.any(String),
    });
  });
});
