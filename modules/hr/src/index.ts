import { defineModuleManifest } from "@esbla/contracts";

export * from "./activation.js";
export * from "./commands.js";
export * from "./errors.js";
export * from "./queries.js";
export * from "./settings.js";
export * from "./types.js";
export * from "./workforce-profile-activation.js";
export * from "./workforce-profile-commands.js";
export * from "./workforce-profile-errors.js";
export * from "./workforce-profile-queries.js";
export * from "./workforce-profile-settings.js";
export * from "./workforce-profile-types.js";

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
    { exposure: "admin", id: "hr.workforce.activate_service" },
    { exposure: "tenant", id: "hr.workforce.change_status" },
    { exposure: "tenant", id: "hr.workforce.create_profile" },
    { exposure: "admin", id: "hr.workforce.deactivate_service" },
    { exposure: "tenant", id: "hr.workforce.link_principal" },
    { exposure: "tenant", id: "hr.workforce.view_own" },
    { exposure: "admin", id: "hr.workforce.view_service_control" },
  ],
  dependencies: ["platform_core"],
  id: "hr",
  name: "HR",
  version: "0.1.0",
});
