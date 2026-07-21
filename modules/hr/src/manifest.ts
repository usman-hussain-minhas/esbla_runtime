import { defineModuleManifest } from "@esbla/contracts";

export const hrManifest = defineModuleManifest({
  activation: "inactive_by_default",
  capabilities: Object.freeze([
    Object.freeze({ exposure: "admin", id: "hr.leave.activate" }),
    Object.freeze({ exposure: "tenant", id: "hr.leave.approve" }),
    Object.freeze({ exposure: "admin", id: "hr.leave.deactivate" }),
    Object.freeze({ exposure: "tenant", id: "hr.leave.list_assigned" }),
    Object.freeze({ exposure: "tenant", id: "hr.leave.list_own" }),
    Object.freeze({ exposure: "tenant", id: "hr.leave.reject" }),
    Object.freeze({ exposure: "tenant", id: "hr.leave.submit" }),
    Object.freeze({ exposure: "tenant", id: "hr.leave.view" }),
    Object.freeze({ exposure: "admin", id: "hr.workforce.activate_service" }),
    Object.freeze({ exposure: "tenant", id: "hr.workforce.change_status" }),
    Object.freeze({ exposure: "tenant", id: "hr.workforce.create_profile" }),
    Object.freeze({ exposure: "admin", id: "hr.workforce.deactivate_service" }),
    Object.freeze({ exposure: "tenant", id: "hr.workforce.link_principal" }),
    Object.freeze({ exposure: "tenant", id: "hr.workforce.view_own" }),
    Object.freeze({ exposure: "admin", id: "hr.workforce.view_service_control" }),
  ]),
  dependencies: Object.freeze(["platform_core"]),
  id: "hr",
  name: "HR",
  version: "0.1.0",
});
