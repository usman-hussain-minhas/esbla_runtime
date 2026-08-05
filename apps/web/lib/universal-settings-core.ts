import {
  getPresentationSettingDefinition,
  type PresentationPreferences,
  type ZenV1SurfaceId,
  zenV1SurfaceIds,
} from "@esbla/contracts";

export const UNIVERSAL_SETTINGS_CHANNEL = "esbla.universal-settings.v1";

export type UniversalSettingsUpdateSubject =
  | "appearance"
  | "shortcuts"
  | "tenant-defaults"
  | ZenV1SurfaceId;

export interface UniversalSettingsUpdate {
  readonly mutationId: string;
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly sourceTabId: string;
  readonly subject: UniversalSettingsUpdateSubject;
}

export interface TenantPresentationDraft {
  readonly density: "comfortable" | "compact";
  readonly highContrast: boolean;
  readonly lockDensity: boolean;
  readonly palette: "light" | "dark";
  readonly reducedMotion: "auto" | "reduce";
  readonly requireHighContrast: boolean;
  readonly requireReducedMotion: boolean;
}

const opaqueScopePattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const subjects = new Set<UniversalSettingsUpdateSubject>([
  "appearance",
  "shortcuts",
  "tenant-defaults",
  ...zenV1SurfaceIds,
]);

function literalProductDefault(key: string): boolean | string {
  const value = getPresentationSettingDefinition(key).defaultValue;
  if (
    value.kind !== "literal" ||
    (typeof value.value !== "boolean" && typeof value.value !== "string")
  ) {
    throw new Error("Invalid Universal Settings Product default");
  }
  return value.value;
}

function enumProductDefault<const T extends string>(key: string, values: readonly T[]): T {
  const value = literalProductDefault(key);
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error("Invalid Universal Settings enum default");
  }
  return value as T;
}

function booleanProductDefault(key: string): boolean {
  const value = literalProductDefault(key);
  if (typeof value !== "boolean") throw new Error("Invalid Universal Settings boolean default");
  return value;
}

const productPalette = enumProductDefault("appearance.palette.v1", ["light", "dark"]);
const productDensity = enumProductDefault("appearance.density.v1", ["comfortable", "compact"]);
const productHighContrast = booleanProductDefault("appearance.high_contrast.v1");
const productReducedMotion = enumProductDefault("appearance.reduced_motion.v1", ["auto", "reduce"]);

export function deriveTenantPresentationDraft(
  preferences: PresentationPreferences,
): TenantPresentationDraft {
  const appearance = preferences.appearance;
  return {
    density: appearance.density.tenantValue ?? productDensity,
    highContrast: appearance.highContrast.tenantValue ?? productHighContrast,
    lockDensity: appearance.density.locked,
    palette: appearance.palette.tenantValue ?? productPalette,
    reducedMotion: appearance.reducedMotion.tenantValue ?? productReducedMotion,
    requireHighContrast: appearance.highContrast.locked,
    requireReducedMotion: appearance.reducedMotion.locked,
  };
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

export function parseUniversalSettingsUpdate(value: unknown): UniversalSettingsUpdate {
  if (
    !exactRecord(value, ["mutationId", "schemaVersion", "scope", "sourceTabId", "subject"]) ||
    value.schemaVersion !== 1 ||
    typeof value.mutationId !== "string" ||
    !uuidPattern.test(value.mutationId) ||
    typeof value.scope !== "string" ||
    !opaqueScopePattern.test(value.scope) ||
    typeof value.sourceTabId !== "string" ||
    !uuidPattern.test(value.sourceTabId) ||
    typeof value.subject !== "string" ||
    !subjects.has(value.subject as UniversalSettingsUpdateSubject)
  ) {
    throw new Error("Invalid Universal Settings update");
  }
  return value as unknown as UniversalSettingsUpdate;
}

export function shouldNotifyUniversalSettingsUpdate(
  update: UniversalSettingsUpdate,
  current: {
    readonly cacheScope: string | null;
    readonly sourceTabId: string;
  },
): boolean {
  return (
    current.cacheScope !== null &&
    opaqueScopePattern.test(current.cacheScope) &&
    update.scope === current.cacheScope &&
    update.sourceTabId !== current.sourceTabId
  );
}
