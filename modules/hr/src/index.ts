import { defineModuleManifest } from "@esbla/contracts";

export const hrManifest = defineModuleManifest({
  activation: "inactive_by_default",
  capabilities: [],
  dependencies: ["platform_core"],
  id: "hr",
  name: "HR",
  version: "0.1.0",
});
