import { defineModuleManifest } from "@esbla/contracts";

export * from "./activation.js";
export * from "./context.js";
export * from "./errors.js";
export * from "./policy.js";
export * from "./presentation.js";
export * from "./presentation-setting.js";
export * from "./proof.js";
export * from "./settings.js";
export * from "./worklist.js";

export const platformCoreManifest = defineModuleManifest({
  activation: "required",
  capabilities: [
    { exposure: "internal", id: "platform.activation.set" },
    { exposure: "internal", id: "platform.evidence.append" },
    { exposure: "internal", id: "platform.policy.evaluate" },
    { exposure: "internal", id: "platform.presentation.preferences.read_own" },
    { exposure: "internal", id: "platform.presentation.preferences.write_own" },
    { exposure: "internal", id: "platform.presentation.layouts.read_own" },
    { exposure: "internal", id: "platform.presentation.layouts.reset_own" },
    { exposure: "internal", id: "platform.presentation.layouts.write_own" },
    { exposure: "internal", id: "platform.studio.surface_base.read" },
    { exposure: "internal", id: "platform.studio.surface_base.draft" },
    { exposure: "internal", id: "platform.studio.surface_base.validate" },
    { exposure: "internal", id: "platform.studio.surface_base.publish" },
    { exposure: "internal", id: "platform.studio.surface_base.rollback" },
    { exposure: "internal", id: "platform.settings.resolve" },
    { exposure: "internal", id: "platform.tenant_transaction.run" },
    { exposure: "internal", id: "platform.work_item.manage" },
  ],
  dependencies: [],
  id: "platform_core",
  name: "Platform Core",
  version: "0.1.0",
});
