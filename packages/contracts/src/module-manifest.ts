export type ModuleActivation = "inactive_by_default" | "required";
export type CapabilityExposure = "internal" | "tenant" | "admin" | "integration";

export interface CapabilityDeclaration {
  readonly id: string;
  readonly exposure: CapabilityExposure;
}

export interface ModuleManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly activation: ModuleActivation;
  readonly dependencies: readonly string[];
  readonly capabilities: readonly CapabilityDeclaration[];
}

export function defineModuleManifest<const T extends ModuleManifest>(manifest: T): T {
  return Object.freeze(manifest);
}
