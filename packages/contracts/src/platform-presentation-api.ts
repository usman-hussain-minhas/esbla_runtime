export const presentationPalettes = ["light", "dark"] as const;
export const PRESENTATION_BILLING_STATE = "non_billable" as const;
export type PresentationPalette = (typeof presentationPalettes)[number];
export type PresentationPreferenceSource = "code_default" | "tenant_default" | "user_override";

export interface PresentationPreferences {
  readonly highContrast: boolean;
  readonly palette: PresentationPalette;
  readonly source: PresentationPreferenceSource;
  readonly version: number;
}

export interface UpdatePresentationPreferencesBody {
  readonly expectedVersion: number;
  readonly highContrast: boolean;
  readonly palette: PresentationPalette;
}

export interface UpdatePresentationPreferencesResponse extends PresentationPreferences {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly evidenceEventId: string;
  readonly replayed: boolean;
}

const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export const presentationPreferencesSchema = {
  $id: "PresentationPreferencesV1",
  additionalProperties: false,
  properties: {
    highContrast: { type: "boolean" },
    palette: { enum: presentationPalettes },
    source: { enum: ["code_default", "tenant_default", "user_override"] },
    version: { maximum: 2_147_483_647, minimum: 0, type: "integer" },
  },
  required: ["highContrast", "palette", "source", "version"],
  type: "object",
} as const;

export const updatePresentationPreferencesBodySchema = {
  $id: "UpdatePresentationPreferencesBodyV1",
  additionalProperties: false,
  properties: {
    expectedVersion: { maximum: 2_147_483_646, minimum: 0, type: "integer" },
    highContrast: { type: "boolean" },
    palette: { enum: presentationPalettes },
  },
  required: ["expectedVersion", "highContrast", "palette"],
  type: "object",
} as const;

export const updatePresentationPreferencesResponseSchema = {
  $id: "UpdatePresentationPreferencesResponseV1",
  additionalProperties: false,
  properties: {
    ...presentationPreferencesSchema.properties,
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

function isVersion(value: unknown, maximum = 2_147_483_647): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

export function parseUpdatePresentationPreferencesBody(
  value: unknown,
): UpdatePresentationPreferencesBody {
  if (
    !exactRecord(value, ["expectedVersion", "highContrast", "palette"]) ||
    !isVersion(value.expectedVersion, 2_147_483_646) ||
    typeof value.highContrast !== "boolean" ||
    !isPalette(value.palette)
  ) {
    throw new Error("Invalid presentation preferences update");
  }
  return {
    expectedVersion: value.expectedVersion,
    highContrast: value.highContrast,
    palette: value.palette,
  };
}

export function parsePresentationPreferences(value: unknown): PresentationPreferences {
  if (
    !exactRecord(value, ["highContrast", "palette", "source", "version"]) ||
    typeof value.highContrast !== "boolean" ||
    !isPalette(value.palette) ||
    !["code_default", "tenant_default", "user_override"].includes(String(value.source)) ||
    !isVersion(value.version)
  ) {
    throw new Error("Invalid presentation preferences");
  }
  return {
    highContrast: value.highContrast,
    palette: value.palette,
    source: value.source as PresentationPreferenceSource,
    version: value.version,
  };
}

export function parseUpdatePresentationPreferencesResponse(
  value: unknown,
): UpdatePresentationPreferencesResponse {
  if (
    !exactRecord(value, [
      "billingState",
      "evidenceEventId",
      "highContrast",
      "palette",
      "replayed",
      "source",
      "version",
    ]) ||
    value.billingState !== PRESENTATION_BILLING_STATE ||
    typeof value.evidenceEventId !== "string" ||
    !new RegExp(uuidPattern).test(value.evidenceEventId) ||
    typeof value.replayed !== "boolean"
  ) {
    throw new Error("Invalid presentation preferences response");
  }
  const preferences = parsePresentationPreferences({
    highContrast: value.highContrast,
    palette: value.palette,
    source: value.source,
    version: value.version,
  });
  return {
    ...preferences,
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId: value.evidenceEventId,
    replayed: value.replayed,
  };
}
