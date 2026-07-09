import { defineModuleManifest } from "@esbla/contracts";

export * from "./activation.js";
export * from "./context.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./proof.js";
export * from "./settings.js";
export * from "./worklist.js";

export const platformCoreManifest = defineModuleManifest({
  activation: "required",
  capabilities: [
    { exposure: "internal", id: "platform.activation.set" },
    { exposure: "internal", id: "platform.evidence.append" },
    { exposure: "internal", id: "platform.policy.evaluate" },
    { exposure: "internal", id: "platform.settings.resolve" },
    { exposure: "internal", id: "platform.tenant_transaction.run" },
    { exposure: "internal", id: "platform.work_item.manage" },
  ],
  dependencies: [],
  id: "platform_core",
  name: "Platform Core",
  version: "0.1.0",
});
