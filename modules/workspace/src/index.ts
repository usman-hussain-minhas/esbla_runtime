import { defineModuleManifest } from "@esbla/contracts";

export * from "./commands.js";
export * from "./errors.js";
export * from "./queries.js";
export * from "./settings.js";
export * from "./types.js";

export const workspaceManifest = defineModuleManifest({
  activation: "inactive_by_default",
  capabilities: [
    { exposure: "tenant", id: "workspace.task.complete" },
    { exposure: "tenant", id: "workspace.task.create" },
    { exposure: "tenant", id: "workspace.task.list_assigned" },
    { exposure: "tenant", id: "workspace.task.view" },
  ],
  dependencies: ["platform_core"],
  id: "workspace",
  name: "Workspace",
  version: "0.1.0",
});
