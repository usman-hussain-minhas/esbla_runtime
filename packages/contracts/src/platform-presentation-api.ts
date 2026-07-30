export const presentationPalettes = ["light", "dark"] as const;
export const presentationDensities = ["comfortable", "compact"] as const;
export const presentationReducedMotionValues = ["auto", "reduce"] as const;
export const PRESENTATION_BILLING_STATE = "non_billable" as const;

export type PresentationPalette = (typeof presentationPalettes)[number];
export type PresentationDensity = (typeof presentationDensities)[number];
export type PresentationReducedMotion = (typeof presentationReducedMotionValues)[number];
export type PresentationPreferenceSource = "product_default" | "tenant_global" | "user_global";

export interface EffectivePresentationPreference<
  TKey extends string,
  TValue extends boolean | string,
> {
  readonly effectiveValue: TValue;
  readonly key: TKey;
  readonly locked: boolean;
  readonly lockReason: string | null;
  readonly source: PresentationPreferenceSource;
  readonly tenantValue: TValue | null;
  readonly userValue: TValue | null;
}

export interface PresentationAppearancePreferences {
  readonly density: EffectivePresentationPreference<"appearance.density.v1", PresentationDensity>;
  readonly highContrast: EffectivePresentationPreference<"appearance.high_contrast.v1", boolean>;
  readonly palette: EffectivePresentationPreference<"appearance.palette.v1", PresentationPalette>;
  readonly reducedMotion: EffectivePresentationPreference<
    "appearance.reduced_motion.v1",
    PresentationReducedMotion
  >;
}

export interface PresentationPreferences {
  readonly appearance: PresentationAppearancePreferences;
  readonly canManageTenantDefaults: boolean;
  readonly tenantVersion: number;
  readonly userVersion: number;
}

export interface UpdatePresentationPreferencesBody {
  readonly density: PresentationDensity;
  readonly expectedVersion: number;
  readonly highContrast: boolean;
  readonly palette: PresentationPalette;
  readonly reducedMotion: PresentationReducedMotion;
}

export interface UpdateTenantPresentationDefaultsBody extends UpdatePresentationPreferencesBody {
  readonly lockDensity: boolean;
  readonly requireHighContrast: boolean;
  readonly requireReducedMotion: boolean;
}

export interface ResetPresentationPreferencesBody {
  readonly expectedVersion: number;
}

export interface UpdatePresentationPreferencesResponse extends PresentationPreferences {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly replayed: boolean;
}

const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const lockReasonPattern = "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){1,12}$";

function preferenceSchema(key: string, value: Readonly<Record<string, unknown>>) {
  return {
    additionalProperties: false,
    properties: {
      effectiveValue: value,
      key: { const: key },
      locked: { type: "boolean" },
      lockReason: { anyOf: [{ pattern: lockReasonPattern, type: "string" }, { type: "null" }] },
      source: { enum: ["product_default", "tenant_global", "user_global"] },
      tenantValue: { anyOf: [value, { type: "null" }] },
      userValue: { anyOf: [value, { type: "null" }] },
    },
    required: [
      "effectiveValue",
      "key",
      "locked",
      "lockReason",
      "source",
      "tenantValue",
      "userValue",
    ],
    type: "object",
  } as const;
}

const paletteSchema = { enum: presentationPalettes } as const;
const densitySchema = { enum: presentationDensities } as const;
const reducedMotionSchema = { enum: presentationReducedMotionValues } as const;
const booleanSchema = { type: "boolean" } as const;

const presentationPreferencesProperties = {
  appearance: {
    additionalProperties: false,
    properties: {
      density: preferenceSchema("appearance.density.v1", densitySchema),
      highContrast: preferenceSchema("appearance.high_contrast.v1", booleanSchema),
      palette: preferenceSchema("appearance.palette.v1", paletteSchema),
      reducedMotion: preferenceSchema("appearance.reduced_motion.v1", reducedMotionSchema),
    },
    required: ["density", "highContrast", "palette", "reducedMotion"],
    type: "object",
  },
  canManageTenantDefaults: { type: "boolean" },
  tenantVersion: { maximum: 2_147_483_647, minimum: 0, type: "integer" },
  userVersion: { maximum: 2_147_483_647, minimum: 0, type: "integer" },
} as const;

export const presentationPreferencesSchema = {
  $id: "PresentationPreferencesV1",
  additionalProperties: false,
  properties: presentationPreferencesProperties,
  required: ["appearance", "canManageTenantDefaults", "tenantVersion", "userVersion"],
  type: "object",
} as const;

export const updatePresentationPreferencesBodySchema = {
  $id: "UpdatePresentationPreferencesBodyV1",
  additionalProperties: false,
  properties: {
    density: densitySchema,
    expectedVersion: { maximum: 2_147_483_646, minimum: 0, type: "integer" },
    highContrast: booleanSchema,
    palette: paletteSchema,
    reducedMotion: reducedMotionSchema,
  },
  required: ["density", "expectedVersion", "highContrast", "palette", "reducedMotion"],
  type: "object",
} as const;

export const updateTenantPresentationDefaultsBodySchema = {
  $id: "UpdateTenantPresentationDefaultsBodyV1",
  additionalProperties: false,
  properties: {
    ...updatePresentationPreferencesBodySchema.properties,
    lockDensity: booleanSchema,
    requireHighContrast: booleanSchema,
    requireReducedMotion: booleanSchema,
  },
  required: [
    ...updatePresentationPreferencesBodySchema.required,
    "lockDensity",
    "requireHighContrast",
    "requireReducedMotion",
  ],
  type: "object",
} as const;

export const resetPresentationPreferencesBodySchema = {
  $id: "ResetPresentationPreferencesBodyV1",
  additionalProperties: false,
  properties: {
    expectedVersion: { maximum: 2_147_483_647, minimum: 1, type: "integer" },
  },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const updatePresentationPreferencesResponseSchema = {
  $id: "UpdatePresentationPreferencesResponseV1",
  additionalProperties: false,
  properties: {
    ...presentationPreferencesProperties,
    billingState: { const: PRESENTATION_BILLING_STATE },
    evidenceEventId: { pattern: uuidPattern, type: "string" },
    replayed: { type: "boolean" },
  },
  required: [
    ...presentationPreferencesSchema.required,
    "billingState",
    "evidenceEventId",
    "replayed",
  ],
  type: "object",
} as const;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function isPalette(value: unknown): value is PresentationPalette {
  return value === "light" || value === "dark";
}

function isDensity(value: unknown): value is PresentationDensity {
  return value === "comfortable" || value === "compact";
}

function isReducedMotion(value: unknown): value is PresentationReducedMotion {
  return value === "auto" || value === "reduce";
}

function isVersion(value: unknown, minimum = 0, maximum = 2_147_483_647): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function parsePreference<TValue extends boolean | string>(
  value: unknown,
  key: string,
  parseValue: (candidate: unknown) => candidate is TValue,
): EffectivePresentationPreference<string, TValue> {
  if (
    !exactRecord(value, [
      "effectiveValue",
      "key",
      "locked",
      "lockReason",
      "source",
      "tenantValue",
      "userValue",
    ]) ||
    value.key !== key ||
    !parseValue(value.effectiveValue) ||
    typeof value.locked !== "boolean" ||
    !["product_default", "tenant_global", "user_global"].includes(String(value.source)) ||
    (value.tenantValue !== null && !parseValue(value.tenantValue)) ||
    (value.userValue !== null && !parseValue(value.userValue)) ||
    (value.locked
      ? typeof value.lockReason !== "string" ||
        !new RegExp(lockReasonPattern).test(value.lockReason)
      : value.lockReason !== null) ||
    (value.source === "tenant_global" && value.tenantValue === null) ||
    (value.source === "user_global" && value.userValue === null)
  ) {
    throw new Error("Invalid effective presentation preference");
  }
  return {
    effectiveValue: value.effectiveValue,
    key,
    locked: value.locked,
    lockReason: value.lockReason as string | null,
    source: value.source as PresentationPreferenceSource,
    tenantValue: value.tenantValue,
    userValue: value.userValue,
  };
}

export function parseUpdatePresentationPreferencesBody(
  value: unknown,
): UpdatePresentationPreferencesBody {
  if (
    !exactRecord(value, [
      "density",
      "expectedVersion",
      "highContrast",
      "palette",
      "reducedMotion",
    ]) ||
    !isVersion(value.expectedVersion, 0, 2_147_483_646) ||
    typeof value.highContrast !== "boolean" ||
    !isPalette(value.palette) ||
    !isDensity(value.density) ||
    !isReducedMotion(value.reducedMotion)
  ) {
    throw new Error("Invalid presentation preferences update");
  }
  return {
    density: value.density,
    expectedVersion: value.expectedVersion,
    highContrast: value.highContrast,
    palette: value.palette,
    reducedMotion: value.reducedMotion,
  };
}

export function parseUpdateTenantPresentationDefaultsBody(
  value: unknown,
): UpdateTenantPresentationDefaultsBody {
  if (
    !exactRecord(value, [
      "density",
      "expectedVersion",
      "highContrast",
      "lockDensity",
      "palette",
      "reducedMotion",
      "requireHighContrast",
      "requireReducedMotion",
    ]) ||
    typeof value.lockDensity !== "boolean" ||
    typeof value.requireHighContrast !== "boolean" ||
    typeof value.requireReducedMotion !== "boolean"
  ) {
    throw new Error("Invalid tenant presentation defaults update");
  }
  const appearance = parseUpdatePresentationPreferencesBody({
    density: value.density,
    expectedVersion: value.expectedVersion,
    highContrast: value.highContrast,
    palette: value.palette,
    reducedMotion: value.reducedMotion,
  });
  if (
    (value.requireHighContrast && !appearance.highContrast) ||
    (value.requireReducedMotion && appearance.reducedMotion !== "reduce")
  ) {
    throw new Error("Invalid tenant presentation accessibility floor");
  }
  return {
    ...appearance,
    lockDensity: value.lockDensity,
    requireHighContrast: value.requireHighContrast,
    requireReducedMotion: value.requireReducedMotion,
  };
}

export function parseResetPresentationPreferencesBody(
  value: unknown,
): ResetPresentationPreferencesBody {
  if (!exactRecord(value, ["expectedVersion"]) || !isVersion(value.expectedVersion, 1)) {
    throw new Error("Invalid presentation preferences reset");
  }
  return { expectedVersion: value.expectedVersion };
}

export function parsePresentationPreferences(value: unknown): PresentationPreferences {
  if (
    !exactRecord(value, [
      "appearance",
      "canManageTenantDefaults",
      "tenantVersion",
      "userVersion",
    ]) ||
    !exactRecord(value.appearance, ["density", "highContrast", "palette", "reducedMotion"]) ||
    typeof value.canManageTenantDefaults !== "boolean" ||
    !isVersion(value.tenantVersion) ||
    !isVersion(value.userVersion)
  ) {
    throw new Error("Invalid presentation preferences");
  }
  return {
    appearance: {
      density: parsePreference(
        value.appearance.density,
        "appearance.density.v1",
        isDensity,
      ) as PresentationAppearancePreferences["density"],
      highContrast: parsePreference(
        value.appearance.highContrast,
        "appearance.high_contrast.v1",
        (candidate): candidate is boolean => typeof candidate === "boolean",
      ) as PresentationAppearancePreferences["highContrast"],
      palette: parsePreference(
        value.appearance.palette,
        "appearance.palette.v1",
        isPalette,
      ) as PresentationAppearancePreferences["palette"],
      reducedMotion: parsePreference(
        value.appearance.reducedMotion,
        "appearance.reduced_motion.v1",
        isReducedMotion,
      ) as PresentationAppearancePreferences["reducedMotion"],
    },
    canManageTenantDefaults: value.canManageTenantDefaults,
    tenantVersion: value.tenantVersion,
    userVersion: value.userVersion,
  };
}

export function parseUpdatePresentationPreferencesResponse(
  value: unknown,
): UpdatePresentationPreferencesResponse {
  if (
    !exactRecord(value, [
      "appearance",
      "billingState",
      "canManageTenantDefaults",
      "evidenceEventId",
      "replayed",
      "tenantVersion",
      "userVersion",
    ]) ||
    value.billingState !== PRESENTATION_BILLING_STATE ||
    typeof value.evidenceEventId !== "string" ||
    !new RegExp(uuidPattern).test(value.evidenceEventId) ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("Invalid presentation preferences response");
  }
  const preferences = parsePresentationPreferences({
    appearance: value.appearance,
    canManageTenantDefaults: value.canManageTenantDefaults,
    tenantVersion: value.tenantVersion,
    userVersion: value.userVersion,
  });
  return {
    ...preferences,
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId: value.evidenceEventId,
    replayed: value.replayed,
  };
}
