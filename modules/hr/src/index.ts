import { defineModuleManifest } from "@esbla/contracts";

export * from "./activation.js";
export * from "./commands.js";
export * from "./errors.js";
export * from "./queries.js";
export * from "./settings.js";
export * from "./types.js";

export const hrManifest = defineModuleManifest({
  activation: "inactive_by_default",
  capabilities: [
    { exposure: "admin", id: "hr.leave.activate" },
    { exposure: "tenant", id: "hr.leave.approve" },
    { exposure: "admin", id: "hr.leave.deactivate" },
    { exposure: "tenant", id: "hr.leave.list_assigned" },
    { exposure: "tenant", id: "hr.leave.list_own" },
    { exposure: "tenant", id: "hr.leave.reject" },
    { exposure: "tenant", id: "hr.leave.submit" },
    { exposure: "tenant", id: "hr.leave.view" },
  ],
  dependencies: ["platform_core"],
  id: "hr",
  name: "HR",
  version: "0.1.0",
});
