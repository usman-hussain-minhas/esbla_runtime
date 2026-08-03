import { createHash } from "node:crypto";
import type {
  PresentationAppearancePreferences,
  PresentationDensity,
  PresentationNavigationDiscovery,
  PresentationPalette,
  PresentationPersonalSurfaceEditorWorkspace,
  PresentationPreferences,
  PresentationReducedMotion,
  PresentationServiceGroupDiscovery,
  PresentationShortcutContextId,
  PresentationShortcutContextKind,
  PresentationShortcutDiscovery,
  PresentationShortcutDiscoveryQuery,
  PresentationShortcutSet,
  PresentationShortcutSettingKey,
  PresentationShortcutTarget,
  PresentationShortcutTargetId,
  PresentationSurfaceBaseMutationResponse,
  PresentationSurfaceBaseVersion,
  PresentationSurfaceBaseWorkspace,
  PresentationSurfaceDefinition,
  PresentationSurfaceDraft,
  PresentationSurfaceLayout,
  PresentationWidgetDefinition,
  PresentationWidgetPlacement,
  PublishPresentationSurfaceDraftBody,
  ResetPresentationPreferencesBody,
  ResetPresentationSurfaceOverlayBody,
  ResetPresentationSurfaceOverlayResponse,
  RollbackPresentationSurfaceBaseBody,
  UpdatePresentationPreferencesBody,
  UpdatePresentationPreferencesResponse,
  UpdatePresentationShortcutBody,
  UpdatePresentationShortcutResponse,
  UpdatePresentationSurfaceOverlayBody,
  UpdatePresentationSurfaceOverlayResponse,
  UpdateTenantPresentationDefaultsBody,
  UpsertPresentationSurfaceDraftBody,
  UpsertPresentationSurfaceDraftResponse,
  ValidatePresentationSurfaceDraftBody,
  ValidatePresentationSurfaceDraftResponse,
  ZenV1SurfaceContract,
  ZenV1SurfaceId,
} from "@esbla/contracts";
import {
  canonicalizePresentationSettingDefinition,
  canonicalizePresentationSurfaceContract,
  canonicalizePresentationSurfaceDefinition,
  canonicalizePresentationWidgetDefinition,
  getPresentationShortcutSurfaceContextDefinition,
  getPresentationShortcutTargetDefinition,
  getPresentationShortcutTargetServiceGroupId,
  getPresentationWidgetDefinition,
  getZenV1RegisteredSurfaceInstances,
  getZenV1RegisteredSurfacePlacements,
  getZenV1SurfaceContract,
  PRESENTATION_BILLING_STATE,
  PRESENTATION_SERVICE_GROUP_DEFINITIONS,
  PRESENTATION_SETTING_DEFINITIONS,
  PRESENTATION_SHORTCUT_MAXIMUM_ITEMS,
  PRESENTATION_SHORTCUT_TARGET_DEFINITIONS,
  PRESENTATION_SURFACE_DEFINITIONS,
  PRESENTATION_WIDGET_DEFINITIONS,
  parseExactPresentationSurfacePlacementSet,
  parsePresentationPreferences,
  parsePresentationShortcutDiscoveryQuery,
  parsePresentationSurfaceBaseMutationResponse,
  parsePresentationSurfaceBaseVersion,
  parsePresentationSurfaceDraft,
  parsePresentationWidgetDefinition,
  parseResetPresentationPreferencesBody,
  parseResetPresentationSurfaceOverlayBody,
  parseResetPresentationSurfaceOverlayResponse,
  parseRollbackPresentationSurfaceBaseBody,
  parseUpdatePresentationPreferencesBody,
  parseUpdatePresentationShortcutBody,
  parseUpdatePresentationSurfaceOverlayBody,
  parseUpdateTenantPresentationDefaultsBody,
  parseUpsertPresentationSurfaceDraftBody,
  parseUpsertPresentationSurfaceDraftResponse,
  parseValidatePresentationSurfaceDraftBody,
  presentationSettingKeys,
  validatePresentationCompositionRegistries,
  ZEN_V1_SURFACE_CONTRACTS,
  zenV1SurfaceIds,
} from "@esbla/contracts";
import type { Pool } from "pg";
import type { OperationContext, TenantTransaction } from "./context.js";
import { withTenantTransaction } from "./context.js";
import { PlatformError } from "./errors.js";
import { assertPolicyAllowed, evaluatePolicy } from "./policy.js";
import {
  type PresentationOrderedSetOperation,
  type PresentationSettingCandidate,
  parsePresentationOrderedSetPatch,
  resolvePresentationSetting,
} from "./presentation-setting.js";
import { appendEvidence, deriveStableUuid } from "./proof.js";

const APPEARANCE_PALETTE_KEY = "appearance.palette.v1";
const APPEARANCE_HIGH_CONTRAST_KEY = "appearance.high_contrast.v1";
const APPEARANCE_REDUCED_MOTION_KEY = "appearance.reduced_motion.v1";
const APPEARANCE_DENSITY_KEY = "appearance.density.v1";
const APPEARANCE_SETTING_KEYS = [
  APPEARANCE_DENSITY_KEY,
  APPEARANCE_HIGH_CONTRAST_KEY,
  APPEARANCE_PALETTE_KEY,
  APPEARANCE_REDUCED_MOTION_KEY,
] as const;
const PREFERENCE_EVENT_TYPE = "platform.presentation.preferences.updated";
const PREFERENCE_RESET_EVENT_TYPE = "platform.presentation.preferences.reset";
const TENANT_PREFERENCE_EVENT_TYPE = "platform.presentation.tenant_defaults.updated";
const TENANT_PREFERENCE_RESET_EVENT_TYPE = "platform.presentation.tenant_defaults.reset";
const PREFERENCE_SUBJECT_TYPE = "platform_presentation_preferences";
const TENANT_PREFERENCE_SUBJECT_TYPE = "platform_presentation_tenant_defaults";
const SHORTCUT_EVENT_TYPE = "platform.presentation.shortcut.updated";
const SHORTCUT_SUBJECT_TYPE = "platform_presentation_shortcuts";
const SURFACE_OVERLAY_EVENT_TYPE = "platform.presentation.surface_overlay.updated";
const SURFACE_OVERLAY_RESET_EVENT_TYPE = "platform.presentation.surface_overlay.reset";
const SURFACE_OVERLAY_SUBJECT_TYPE = "platform_presentation_surface_overlay";
const SURFACE_BASE_DRAFT_EVENT_TYPE = "platform.studio.surface_base.draft.updated";
const SURFACE_BASE_PUBLISH_EVENT_TYPE = "platform.studio.surface_base.published";
const SURFACE_BASE_ROLLBACK_EVENT_TYPE = "platform.studio.surface_base.rolled_back";
const SURFACE_BASE_SUBJECT_TYPE = "platform_presentation_surface_base";
const SURFACE_PERSONALIZATION_LOCK_NAMESPACE = "platform.presentation.surface.personalization";

interface PresentationCompositionRegistryInput {
  readonly surfaceContracts?: readonly ZenV1SurfaceContract[];
  readonly surfaceDefinitions?: readonly PresentationSurfaceDefinition[];
  readonly widgetDefinitions?: readonly PresentationWidgetDefinition[];
}

export function assertPresentationCompositionRegistriesCurrent(
  input: PresentationCompositionRegistryInput = {},
): void {
  const surfaceContracts = input.surfaceContracts ?? ZEN_V1_SURFACE_CONTRACTS;
  const surfaceDefinitions = input.surfaceDefinitions ?? PRESENTATION_SURFACE_DEFINITIONS;
  const widgetDefinitions = input.widgetDefinitions ?? PRESENTATION_WIDGET_DEFINITIONS;
  try {
    validatePresentationCompositionRegistries(
      surfaceDefinitions,
      surfaceContracts,
      widgetDefinitions,
    );
    for (const definition of surfaceDefinitions) {
      const { definitionHash, ...manifest } = definition;
      if (
        createHash("sha256")
          .update(canonicalizePresentationSurfaceDefinition(manifest))
          .digest("hex") !== definitionHash
      ) {
        throw new Error("Presentation surface definition hash mismatch");
      }
    }
    for (const contract of surfaceContracts) {
      const { canonicalHash, ...manifest } = contract;
      if (
        createHash("sha256")
          .update(canonicalizePresentationSurfaceContract(manifest))
          .digest("hex") !== canonicalHash
      ) {
        throw new Error("Presentation surface contract hash mismatch");
      }
    }
    for (const candidate of widgetDefinitions) {
      const definition = parsePresentationWidgetDefinition(candidate);
      const { canonicalHash, ...manifest } = definition;
      if (
        createHash("sha256")
          .update(canonicalizePresentationWidgetDefinition(manifest))
          .digest("hex") !== canonicalHash
      ) {
        throw new Error("Presentation widget definition hash mismatch");
      }
    }
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation composition registry is invalid");
  }
}

export function assertPresentationSettingRegistryCurrent(): void {
  if (
    PRESENTATION_SETTING_DEFINITIONS.length !== presentationSettingKeys.length ||
    new Set(presentationSettingKeys).size !== presentationSettingKeys.length ||
    PRESENTATION_SETTING_DEFINITIONS.some(
      ({ key }, index) => key !== presentationSettingKeys[index],
    )
  ) {
    throw new PlatformError("SETTING_INVALID", "Presentation setting registry is invalid");
  }
  for (const definition of PRESENTATION_SETTING_DEFINITIONS) {
    const { canonicalHash, ...manifest } = definition;
    if (
      createHash("sha256")
        .update(canonicalizePresentationSettingDefinition(manifest))
        .digest("hex") !== canonicalHash
    ) {
      throw new PlatformError("SETTING_INVALID", "Presentation setting registry is invalid");
    }
  }
}

assertPresentationCompositionRegistriesCurrent();
assertPresentationSettingRegistryCurrent();

export interface AppearanceValues {
  readonly density: PresentationDensity;
  readonly highContrast: boolean;
  readonly palette: PresentationPalette;
  readonly reducedMotion: PresentationReducedMotion;
}

export interface TenantAppearanceValues extends AppearanceValues {
  readonly lockDensity: boolean;
  readonly requireHighContrast: boolean;
  readonly requireReducedMotion: boolean;
}

export interface PresentationPreferenceResolutionInput {
  readonly codeDefault: AppearanceValues;
  readonly tenantDefault?: TenantAppearanceValues;
  readonly userOverride?: AppearanceValues;
}

interface StoredPreferenceLayer extends TenantAppearanceValues {
  readonly version: number;
}

function invalidStoredPreference(): PlatformError {
  return new PlatformError("SETTING_INVALID", "Presentation preference storage is invalid");
}

function parseStoredPreferenceLayer(
  subjectType: "tenant_default" | "user_override",
  rows: readonly {
    readonly locked: unknown;
    readonly setting_key: string;
    readonly value: unknown;
    readonly version: unknown;
  }[],
): StoredPreferenceLayer | undefined {
  if (rows.length === 0) return undefined;
  if (rows.length !== APPEARANCE_SETTING_KEYS.length) throw invalidStoredPreference();
  const byKey = new Map(rows.map((row) => [row.setting_key, row]));
  const density = byKey.get(APPEARANCE_DENSITY_KEY);
  const palette = byKey.get(APPEARANCE_PALETTE_KEY);
  const highContrast = byKey.get(APPEARANCE_HIGH_CONTRAST_KEY);
  const reducedMotion = byKey.get(APPEARANCE_REDUCED_MOTION_KEY);
  const version = density?.version;
  if (
    !density ||
    !palette ||
    !highContrast ||
    !reducedMotion ||
    (density.value !== "comfortable" && density.value !== "compact") ||
    (palette.value !== "light" && palette.value !== "dark") ||
    typeof highContrast.value !== "boolean" ||
    (reducedMotion.value !== "auto" && reducedMotion.value !== "reduce") ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1 ||
    APPEARANCE_SETTING_KEYS.some((key) => byKey.get(key)?.version !== version) ||
    APPEARANCE_SETTING_KEYS.some((key) => typeof byKey.get(key)?.locked !== "boolean") ||
    palette.locked !== false ||
    (subjectType === "user_override" &&
      APPEARANCE_SETTING_KEYS.some((key) => byKey.get(key)?.locked !== false)) ||
    (highContrast.locked && highContrast.value !== true) ||
    (reducedMotion.locked && reducedMotion.value !== "reduce")
  ) {
    throw invalidStoredPreference();
  }
  return {
    density: density.value,
    highContrast: highContrast.value,
    lockDensity: density.locked === true,
    palette: palette.value,
    reducedMotion: reducedMotion.value,
    requireHighContrast: highContrast.locked === true,
    requireReducedMotion: reducedMotion.locked === true,
    version: Number(version),
  };
}

export function parsePresentationPreferenceInput(
  value: unknown,
): UpdatePresentationPreferencesBody {
  try {
    return parseUpdatePresentationPreferencesBody(value);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation preferences are invalid");
  }
}

export function resolvePresentationPreferences(
  input: PresentationPreferenceResolutionInput,
): PresentationAppearancePreferences {
  if (
    input.codeDefault.density !== "comfortable" ||
    input.codeDefault.palette !== "light" ||
    input.codeDefault.highContrast !== false ||
    input.codeDefault.reducedMotion !== "auto"
  ) {
    throw invalidStoredPreference();
  }
  const candidates = (key: keyof AppearanceValues): readonly PresentationSettingCandidate[] => [
    ...(input.tenantDefault
      ? [
          {
            definitionVersion: 1,
            rowVersion: 1,
            scope: "tenant_global" as const,
            value: input.tenantDefault[key],
          },
        ]
      : []),
    ...(input.userOverride
      ? [
          {
            definitionVersion: 1,
            rowVersion: 1,
            scope: "user_global" as const,
            value: input.userOverride[key],
          },
        ]
      : []),
  ];
  const metadata = <TKey extends keyof AppearanceValues>(
    key: TKey,
    settingKey: PresentationAppearancePreferences[TKey]["key"],
    environment: Parameters<typeof resolvePresentationSetting>[2] = {},
  ): PresentationAppearancePreferences[TKey] => {
    const resolved = resolvePresentationSetting(settingKey, candidates(key), environment);
    const source = resolved.locked && input.tenantDefault ? "tenant_global" : resolved.sourceScope;
    if (source !== "product_default" && source !== "tenant_global" && source !== "user_global") {
      throw invalidStoredPreference();
    }
    return {
      effectiveValue: resolved.value,
      key: settingKey,
      locked: resolved.locked,
      lockReason: resolved.lockReason ?? null,
      source,
      tenantValue: input.tenantDefault?.[key] ?? null,
      userValue: input.userOverride?.[key] ?? null,
    } as PresentationAppearancePreferences[TKey];
  };
  const density = metadata("density", APPEARANCE_DENSITY_KEY, {
    ...(input.tenantDefault?.lockDensity
      ? {
          tenantLock: {
            reason: "tenant_density_lock",
            value: input.tenantDefault.density,
          },
        }
      : {}),
  });
  const highContrast = metadata("highContrast", APPEARANCE_HIGH_CONTRAST_KEY, {
    ...(input.tenantDefault?.requireHighContrast ? { requireHighContrast: true } : {}),
  });
  const palette = metadata("palette", APPEARANCE_PALETTE_KEY);
  const reducedMotion = metadata("reducedMotion", APPEARANCE_REDUCED_MOTION_KEY, {
    ...(input.tenantDefault?.requireReducedMotion ? { requireReducedMotion: true } : {}),
  });
  if (
    (density.effectiveValue !== "comfortable" && density.effectiveValue !== "compact") ||
    typeof highContrast.effectiveValue !== "boolean" ||
    (palette.effectiveValue !== "light" && palette.effectiveValue !== "dark") ||
    (reducedMotion.effectiveValue !== "auto" && reducedMotion.effectiveValue !== "reduce")
  ) {
    throw invalidStoredPreference();
  }
  return {
    density,
    highContrast,
    palette,
    reducedMotion,
  };
}

function preferenceSubjectId(context: OperationContext): string {
  return deriveStableUuid(
    "platform.presentation.preferences",
    context.tenantId,
    context.actorPrincipalId,
  );
}

function tenantPreferenceSubjectId(context: OperationContext): string {
  return deriveStableUuid("platform.presentation.tenant-defaults", context.tenantId);
}

function assertOwnPresentationPolicy(
  transaction: TenantTransaction,
  actionKey:
    | "platform.presentation.layouts.read_own"
    | "platform.presentation.layouts.reset_own"
    | "platform.presentation.layouts.write_own"
    | "platform.presentation.preferences.read_own"
    | "platform.presentation.preferences.write_own"
    | "platform.presentation.shortcuts.read_own"
    | "platform.presentation.shortcuts.write_own",
  resourceKey: string,
): void {
  const decision = evaluatePolicy(
    {
      actionKey,
      input: { targetPrincipalId: transaction.context.actorPrincipalId },
      resourceKey,
      transaction,
    },
    [
      {
        effect: "allow",
        id: "presentation.current-member-may-access-own-state",
        matches: (input, actor) => input.targetPrincipalId === actor.principalId,
      },
    ],
  );
  assertPolicyAllowed(decision, transaction, actionKey, resourceKey);
}

async function loadScopedPreference(
  transaction: TenantTransaction,
  subjectType: "tenant_default" | "user_override",
  subjectId: string,
  lock = false,
): Promise<StoredPreferenceLayer | undefined> {
  const result = await transaction.client.query<{
    locked: boolean;
    setting_key: string;
    value: unknown;
    version: number;
  }>(
    `SELECT setting_key, value, locked, version
     FROM presentation_setting_values
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND setting_key = ANY($4::text[])
     ORDER BY setting_key
     ${lock ? "FOR UPDATE" : ""}`,
    [transaction.context.tenantId, subjectType, subjectId, APPEARANCE_SETTING_KEYS],
  );
  return parseStoredPreferenceLayer(subjectType, result.rows);
}

async function hasCurrentTenantPresentationCapability(
  transaction: TenantTransaction,
): Promise<boolean> {
  const capability = await transaction.client.query<{ capability_current: boolean }>(
    `SELECT public.esbla_lock_membership_capability($1, $2, $3) AS capability_current`,
    [
      transaction.context.tenantId,
      transaction.context.actorPrincipalId,
      "platform.presentation.tenant_defaults.write",
    ],
  );
  return capability.rows[0]?.capability_current === true;
}

async function loadPreferencesInTransaction(
  transaction: TenantTransaction,
  canManageTenantDefaults?: boolean,
): Promise<PresentationPreferences> {
  const [tenantDefault, userOverride] = await Promise.all([
    loadScopedPreference(transaction, "tenant_default", transaction.context.tenantId),
    loadScopedPreference(transaction, "user_override", transaction.context.actorPrincipalId),
  ]);
  const resolved = resolvePresentationPreferences({
    codeDefault: {
      density: "comfortable",
      highContrast: false,
      palette: "light",
      reducedMotion: "auto",
    },
    ...(tenantDefault ? { tenantDefault } : {}),
    ...(userOverride ? { userOverride } : {}),
  });
  return {
    appearance: resolved,
    canManageTenantDefaults:
      canManageTenantDefaults ?? (await hasCurrentTenantPresentationCapability(transaction)),
    tenantVersion: tenantDefault?.version ?? 0,
    userVersion: userOverride?.version ?? 0,
  };
}

export async function getOwnPresentationPreferences(
  pool: Pool,
  context: OperationContext,
): Promise<PresentationPreferences> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.preferences.read_own",
        `principal:${transaction.context.actorPrincipalId}:presentation`,
      );
      return await loadPreferencesInTransaction(transaction);
    },
    { migrationBarrier: "shared" },
  );
}

export async function getOwnPresentationServiceGroups(
  pool: Pool,
  context: OperationContext,
): Promise<PresentationServiceGroupDiscovery> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.layouts.read_own",
        `principal:${transaction.context.actorPrincipalId}:service-groups`,
      );
      const { active, authorized } = await loadPresentationNavigationEligibility(transaction);
      return {
        serviceGroupIds: PRESENTATION_SERVICE_GROUP_DEFINITIONS.filter(({ services }) =>
          services.some((service) =>
            presentationServiceIsEligible(service, transaction.actor.roleKey, active, authorized),
          ),
        ).map(({ serviceGroupId }) => serviceGroupId),
      };
    },
    { migrationBarrier: "shared" },
  );
}

async function loadPresentationNavigationEligibility(transaction: TenantTransaction): Promise<{
  readonly active: ReadonlySet<string>;
  readonly authorized: ReadonlySet<string>;
}> {
  const activationServiceKeys = [
    ...new Set(
      PRESENTATION_SERVICE_GROUP_DEFINITIONS.flatMap(({ services }) =>
        services.map(({ activationServiceKey }) => activationServiceKey),
      ),
    ),
  ];
  const capabilityIds = [
    ...new Set(
      PRESENTATION_SERVICE_GROUP_DEFINITIONS.flatMap(({ services }) =>
        services.flatMap((service) => {
          const additionalVisibilityRules =
            "additionalVisibilityRules" in service ? service.additionalVisibilityRules : [];
          return [
            ...additionalVisibilityRules.flatMap(({ anyCapabilityIds }) => anyCapabilityIds),
            ...service.destinations.flatMap(({ anyCapabilityIds }) => anyCapabilityIds),
          ];
        }),
      ),
    ),
  ];
  const activations = await transaction.client.query<{ service_key: string }>(
    `SELECT service_key
     FROM service_activations
     WHERE tenant_id = $1 AND state = 'active' AND service_key = ANY($2::text[])
     ORDER BY service_key`,
    [transaction.context.tenantId, activationServiceKeys],
  );
  const capabilities = await transaction.client.query<{ capability_id: string }>(
    `SELECT capability_id
     FROM membership_capabilities
     WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = ANY($3::text[])
     ORDER BY capability_id`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityIds],
  );
  return {
    active: new Set(activations.rows.map(({ service_key }) => service_key)),
    authorized: new Set(capabilities.rows.map(({ capability_id }) => capability_id)),
  };
}

async function loadPresentationNavigationDiscovery(
  transaction: TenantTransaction,
): Promise<PresentationNavigationDiscovery> {
  const { active, authorized } = await loadPresentationNavigationEligibility(transaction);
  return {
    serviceGroups: PRESENTATION_SERVICE_GROUP_DEFINITIONS.flatMap((group) => {
      const eligibleServices = group.services.filter((service) =>
        presentationServiceIsEligible(service, transaction.actor.roleKey, active, authorized),
      );
      if (eligibleServices.length === 0) return [];
      return [
        {
          destinationIds: eligibleServices.flatMap(({ destinations }) =>
            destinations
              .filter((destination) =>
                presentationEligibilityRuleMatches(
                  destination,
                  transaction.actor.roleKey,
                  authorized,
                ),
              )
              .map(({ destinationId }) => destinationId),
          ),
          serviceGroupId: group.serviceGroupId,
        },
      ];
    }),
  };
}

function presentationServiceIsEligible(
  service: (typeof PRESENTATION_SERVICE_GROUP_DEFINITIONS)[number]["services"][number],
  roleKey: string,
  active: ReadonlySet<string>,
  authorized: ReadonlySet<string>,
): boolean {
  return (
    active.has(service.activationServiceKey) &&
    [
      ...service.destinations,
      ...("additionalVisibilityRules" in service ? service.additionalVisibilityRules : []),
    ].some((rule) => presentationEligibilityRuleMatches(rule, roleKey, authorized))
  );
}

function presentationEligibilityRuleMatches(
  rule: {
    readonly allowedRoleKeys: readonly string[];
    readonly anyCapabilityIds: readonly string[];
  },
  roleKey: string,
  authorized: ReadonlySet<string>,
): boolean {
  return (
    rule.allowedRoleKeys.includes(roleKey) &&
    rule.anyCapabilityIds.some((capabilityId) => authorized.has(capabilityId))
  );
}

export async function getOwnPresentationNavigation(
  pool: Pool,
  context: OperationContext,
): Promise<PresentationNavigationDiscovery> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.layouts.read_own",
        `principal:${transaction.context.actorPrincipalId}:navigation`,
      );
      return await loadPresentationNavigationDiscovery(transaction);
    },
    { migrationBarrier: "shared" },
  );
}

interface StoredShortcutPatch {
  readonly operations: readonly PresentationOrderedSetOperation[];
  readonly version: number;
}

function invalidShortcutStorage(): PlatformError {
  return new PlatformError("SETTING_INVALID", "Presentation shortcut storage is invalid");
}

function parsePresentationShortcutQueryInput(value: unknown): PresentationShortcutDiscoveryQuery {
  try {
    return parsePresentationShortcutDiscoveryQuery(value);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation shortcut query is invalid");
  }
}

function parsePresentationShortcutUpdateInput(value: unknown): UpdatePresentationShortcutBody {
  try {
    return parseUpdatePresentationShortcutBody(value);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation shortcut update is invalid");
  }
}

function shortcutCandidateScope(
  settingKey: PresentationShortcutSettingKey,
  contextKind: PresentationShortcutContextKind,
): "user_global" | "user_service" | "user_surface" {
  if (settingKey === "navigation.universal_shortcuts.v1") return "user_global";
  return contextKind === "surface" ? "user_surface" : "user_service";
}

function registeredShortcutTargets(
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
): readonly PresentationShortcutTarget[] {
  if (contextKind === "global" && contextId === "global") {
    return PRESENTATION_SHORTCUT_TARGET_DEFINITIONS;
  }
  if (contextKind === "service" && contextId !== "global" && !contextId.startsWith("surface.")) {
    return PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.filter(
      ({ id }) => getPresentationShortcutTargetServiceGroupId(id) === contextId,
    );
  }
  if (contextKind === "surface" && contextId.startsWith("surface.")) {
    let allowed: ReadonlySet<PresentationShortcutTargetId>;
    try {
      allowed = new Set(
        getPresentationShortcutSurfaceContextDefinition(contextId).allowedTargetIds,
      );
    } catch {
      throw invalidShortcutStorage();
    }
    return PRESENTATION_SHORTCUT_TARGET_DEFINITIONS.filter(({ id }) => allowed.has(id));
  }
  throw invalidShortcutStorage();
}

function eligibleShortcutTargetIds(
  discovery: PresentationNavigationDiscovery,
): ReadonlySet<PresentationShortcutTargetId> {
  const ids = new Set<PresentationShortcutTargetId>(["platform.mission_control"]);
  for (const group of discovery.serviceGroups) {
    ids.add(`service_group.${group.serviceGroupId}.mission_control`);
    for (const destinationId of group.destinationIds) ids.add(destinationId);
  }
  return ids;
}

function eligibleShortcutTargets(
  discovery: PresentationNavigationDiscovery,
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
): readonly PresentationShortcutTarget[] {
  const eligibleIds = eligibleShortcutTargetIds(discovery);
  return registeredShortcutTargets(contextKind, contextId).filter(({ id }) => eligibleIds.has(id));
}

function shortcutTargetActivationServiceKeys(
  targetId: PresentationShortcutTargetId,
): readonly string[] {
  const serviceGroupId = getPresentationShortcutTargetServiceGroupId(targetId);
  if (serviceGroupId === null) return [];
  const group = PRESENTATION_SERVICE_GROUP_DEFINITIONS.find(
    (candidate) => candidate.serviceGroupId === serviceGroupId,
  );
  if (!group) return [];
  if (targetId === `service_group.${serviceGroupId}.mission_control`) {
    return [
      ...new Set(group.services.map(({ activationServiceKey }) => activationServiceKey)),
    ].sort();
  }
  const service = group.services.find(({ destinations }) =>
    destinations.some(({ destinationId }) => destinationId === targetId),
  );
  return service ? [service.activationServiceKey] : [];
}

async function lockShortcutAppendTargetEligibility(
  transaction: TenantTransaction,
  targetId: PresentationShortcutTargetId,
): Promise<void> {
  const serviceGroupId = getPresentationShortcutTargetServiceGroupId(targetId);
  if (serviceGroupId === null) return;
  const group = PRESENTATION_SERVICE_GROUP_DEFINITIONS.find(
    (candidate) => candidate.serviceGroupId === serviceGroupId,
  );
  if (!group) throw new PlatformError("POLICY_DENIED", "Shortcut target is not currently eligible");
  const destinationMatch = group.services
    .flatMap((service) => service.destinations.map((destination) => ({ destination, service })))
    .find(({ destination }) => destination.destinationId === targetId);
  const services =
    targetId === `service_group.${serviceGroupId}.mission_control`
      ? group.services
      : destinationMatch
        ? [destinationMatch.service]
        : [];
  if (services.length === 0) {
    throw new PlatformError("POLICY_DENIED", "Shortcut target is not currently eligible");
  }
  const capabilityIds = [
    ...new Set(
      services.flatMap((service) => {
        if (destinationMatch && service === destinationMatch.service) {
          return destinationMatch.destination.anyCapabilityIds;
        }
        return [
          ...service.destinations.flatMap(({ anyCapabilityIds }) => anyCapabilityIds),
          ...("additionalVisibilityRules" in service
            ? service.additionalVisibilityRules.flatMap(({ anyCapabilityIds }) => anyCapabilityIds)
            : []),
        ];
      }),
    ),
  ].sort();
  const active = new Set(
    (transaction.lockedServiceActivations ?? [])
      .filter(({ state }) => state === "active")
      .map(({ serviceKey }) => serviceKey),
  );
  const authorized = new Set<string>();
  for (const capabilityId of capabilityIds) {
    const result = await transaction.client.query<{ capability_current: boolean }>(
      `SELECT public.esbla_lock_membership_capability($1, $2, $3) AS capability_current`,
      [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityId],
    );
    if (result.rows[0]?.capability_current === true) authorized.add(capabilityId);
  }
  const eligible = destinationMatch
    ? active.has(destinationMatch.service.activationServiceKey) &&
      presentationEligibilityRuleMatches(
        destinationMatch.destination,
        transaction.actor.roleKey,
        authorized,
      )
    : services.some((service) =>
        presentationServiceIsEligible(service, transaction.actor.roleKey, active, authorized),
      );
  if (!eligible) {
    throw new PlatformError("POLICY_DENIED", "Shortcut target is not currently eligible");
  }
}

async function loadStoredShortcutPatch(
  transaction: TenantTransaction,
  settingKey: PresentationShortcutSettingKey,
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
  lock: "none" | "update" = "none",
): Promise<StoredShortcutPatch | undefined> {
  const result = await transaction.client.query<{ patch: unknown; version: number }>(
    `SELECT patch, version
     FROM presentation_shortcut_user_patches
     WHERE tenant_id = $1 AND principal_id = $2 AND setting_key = $3
       AND context_kind = $4 AND context_id = $5
     ${lock === "update" ? "FOR UPDATE" : ""}`,
    [
      transaction.context.tenantId,
      transaction.context.actorPrincipalId,
      settingKey,
      contextKind,
      contextId,
    ],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (!Number.isSafeInteger(row.version) || row.version < 1) throw invalidShortcutStorage();
  let operations: readonly PresentationOrderedSetOperation[];
  try {
    operations = parsePresentationOrderedSetPatch(row.patch, { allowAppend: true });
  } catch {
    throw invalidShortcutStorage();
  }
  if (operations.length > PRESENTATION_SHORTCUT_MAXIMUM_ITEMS) {
    throw invalidShortcutStorage();
  }
  return { operations, version: row.version };
}

function resolveShortcutSet(
  settingKey: PresentationShortcutSettingKey,
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
  stored: StoredShortcutPatch | undefined,
  eligibleTargets: readonly PresentationShortcutTarget[],
): PresentationShortcutSet {
  const registeredTargets = registeredShortcutTargets(contextKind, contextId);
  let resolved: ReturnType<typeof resolvePresentationSetting>;
  try {
    resolved = resolvePresentationSetting(
      settingKey,
      stored
        ? [
            {
              definitionVersion: 1,
              rowVersion: stored.version,
              scope: shortcutCandidateScope(settingKey, contextKind),
              value: { operations: stored.operations },
            },
          ]
        : [],
      {
        authorizedIds: eligibleTargets.map(({ id }) => id),
        registeredIds: registeredTargets.map(({ id }) => id),
      },
    );
  } catch {
    throw invalidShortcutStorage();
  }
  if (
    !Array.isArray(resolved.value) ||
    resolved.value.some((targetId) => typeof targetId !== "string") ||
    resolved.tombstones.length > 20
  ) {
    throw invalidShortcutStorage();
  }
  const items = resolved.value.map((targetId) => {
    try {
      return getPresentationShortcutTargetDefinition(targetId);
    } catch {
      throw invalidShortcutStorage();
    }
  });
  return {
    contextId,
    contextKind,
    editable: true,
    eligibleTargets,
    items,
    settingKey,
    tombstoneCount: resolved.tombstones.length,
    version: stored?.version ?? 0,
  };
}

async function loadShortcutSet(
  transaction: TenantTransaction,
  discovery: PresentationNavigationDiscovery,
  settingKey: PresentationShortcutSettingKey,
  contextKind: PresentationShortcutContextKind,
  contextId: PresentationShortcutContextId,
  lock: "none" | "update" = "none",
): Promise<PresentationShortcutSet> {
  const stored = await loadStoredShortcutPatch(
    transaction,
    settingKey,
    contextKind,
    contextId,
    lock,
  );
  return resolveShortcutSet(
    settingKey,
    contextKind,
    contextId,
    stored,
    eligibleShortcutTargets(discovery, contextKind, contextId),
  );
}

export async function getOwnPresentationShortcuts(
  pool: Pool,
  context: OperationContext,
  untrustedQuery: unknown,
): Promise<PresentationShortcutDiscovery> {
  const query = parsePresentationShortcutQueryInput(untrustedQuery);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.shortcuts.read_own",
        `principal:${transaction.context.actorPrincipalId}:shortcuts`,
      );
      const discovery = await loadPresentationNavigationDiscovery(transaction);
      const universal = await loadShortcutSet(
        transaction,
        discovery,
        "navigation.universal_shortcuts.v1",
        "global",
        "global",
      );
      const contextualGroup = query.contextServiceGroupId
        ? discovery.serviceGroups.find(
            ({ serviceGroupId }) => serviceGroupId === query.contextServiceGroupId,
          )
        : undefined;
      const contextual =
        query.contextServiceGroupId && contextualGroup
          ? await loadShortcutSet(
              transaction,
              discovery,
              "navigation.contextual_shortcuts.v1",
              "service",
              query.contextServiceGroupId,
            )
          : query.contextSurfaceId
            ? await loadShortcutSet(
                transaction,
                discovery,
                "navigation.contextual_shortcuts.v1",
                "surface",
                query.contextSurfaceId,
              )
            : null;
      return { contextual, universal };
    },
    { migrationBarrier: "shared" },
  );
}

function shortcutSubjectId(
  context: OperationContext,
  input: Pick<UpdatePresentationShortcutBody, "contextId" | "contextKind" | "settingKey">,
): string {
  return deriveStableUuid(
    "platform.presentation.shortcuts",
    context.tenantId,
    context.actorPrincipalId,
    input.settingKey,
    input.contextKind,
    input.contextId,
  );
}

interface ShortcutEvidenceState {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly contextId: string;
  readonly contextKind: string;
  readonly expectedVersion: number;
  readonly operation: string;
  readonly settingKey: string;
  readonly targetId: string;
  readonly version: number;
}

function parseShortcutEvidenceState(value: string): ShortcutEvidenceState {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !==
        JSON.stringify(
          [
            "billingState",
            "contextId",
            "contextKind",
            "expectedVersion",
            "operation",
            "settingKey",
            "targetId",
            "version",
          ].sort(),
        )
    ) {
      throw new Error("invalid");
    }
    const state = parsed as Record<string, unknown>;
    if (
      state.billingState !== PRESENTATION_BILLING_STATE ||
      typeof state.contextId !== "string" ||
      typeof state.contextKind !== "string" ||
      !Number.isSafeInteger(state.expectedVersion) ||
      Number(state.expectedVersion) < 0 ||
      typeof state.operation !== "string" ||
      typeof state.settingKey !== "string" ||
      typeof state.targetId !== "string" ||
      !Number.isSafeInteger(state.version) ||
      Number(state.version) < 1
    ) {
      throw new Error("invalid");
    }
    return {
      billingState: PRESENTATION_BILLING_STATE,
      contextId: state.contextId,
      contextKind: state.contextKind,
      expectedVersion: Number(state.expectedVersion),
      operation: state.operation,
      settingKey: state.settingKey,
      targetId: state.targetId,
      version: Number(state.version),
    };
  } catch {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Shortcut retry evidence is invalid");
  }
}

function shortcutEvidenceMatches(
  state: ShortcutEvidenceState,
  input: UpdatePresentationShortcutBody,
): boolean {
  return (
    state.contextId === input.contextId &&
    state.contextKind === input.contextKind &&
    state.expectedVersion === input.expectedVersion &&
    state.operation === input.operation &&
    state.settingKey === input.settingKey &&
    state.targetId === input.targetId
  );
}

async function readShortcutReplay(
  transaction: TenantTransaction,
  input: UpdatePresentationShortcutBody,
  subjectId: string,
  currentSet: PresentationShortcutSet,
  eligibleTargets: readonly PresentationShortcutTarget[],
): Promise<UpdatePresentationShortcutResponse | null> {
  const priorEvidence = await transaction.client.query<{
    actor_principal_id: string;
    evidence_event_id: string;
    new_state: string;
  }>(
    `SELECT evidence_event_id, actor_principal_id, new_state
     FROM evidence_events
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND event_type = $4 AND correlation_id = $5`,
    [
      transaction.context.tenantId,
      SHORTCUT_SUBJECT_TYPE,
      subjectId,
      SHORTCUT_EVENT_TYPE,
      transaction.context.correlationId,
    ],
  );
  const replay = priorEvidence.rows[0];
  if (!replay) return null;
  const state = parseShortcutEvidenceState(replay.new_state);
  if (
    replay.actor_principal_id !== transaction.context.actorPrincipalId ||
    !shortcutEvidenceMatches(state, input)
  ) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Shortcut retry changed its semantics");
  }
  let replaySet = currentSet;
  if (currentSet.version < state.version) {
    const refreshedStored = await loadStoredShortcutPatch(
      transaction,
      input.settingKey,
      input.contextKind,
      input.contextId,
      "update",
    );
    replaySet = resolveShortcutSet(
      input.settingKey,
      input.contextKind,
      input.contextId,
      refreshedStored,
      eligibleTargets,
    );
  }
  if (replaySet.version < state.version) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Shortcut retry state is unavailable");
  }
  return {
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId: replay.evidence_event_id,
    replayed: true,
    set: replaySet,
  };
}

export async function updateOwnPresentationShortcut(
  pool: Pool,
  context: OperationContext,
  untrustedInput: unknown,
): Promise<UpdatePresentationShortcutResponse> {
  const input = parsePresentationShortcutUpdateInput(untrustedInput);
  const activationServiceKeys =
    input.operation === "append" ? shortcutTargetActivationServiceKeys(input.targetId) : [];
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.shortcuts.write_own",
        `principal:${transaction.context.actorPrincipalId}:shortcuts:${input.contextKind}:${input.contextId}`,
      );
      if (input.operation === "append") {
        await lockShortcutAppendTargetEligibility(transaction, input.targetId);
      }
      const discovery = await loadPresentationNavigationDiscovery(transaction);
      const eligibleTargets = eligibleShortcutTargets(
        discovery,
        input.contextKind,
        input.contextId,
      );
      const eligibleIds = new Set(eligibleTargets.map(({ id }) => id));
      if (input.operation === "append" && !eligibleIds.has(input.targetId)) {
        throw new PlatformError("POLICY_DENIED", "Shortcut target is not currently eligible");
      }
      const stored = await loadStoredShortcutPatch(
        transaction,
        input.settingKey,
        input.contextKind,
        input.contextId,
        "update",
      );
      const currentSet = resolveShortcutSet(
        input.settingKey,
        input.contextKind,
        input.contextId,
        stored,
        eligibleTargets,
      );
      const subjectId = shortcutSubjectId(context, input);
      const priorReplay = await readShortcutReplay(
        transaction,
        input,
        subjectId,
        currentSet,
        eligibleTargets,
      );
      if (priorReplay) return priorReplay;
      const currentVersion = stored?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Shortcut version has changed", {
          currentVersion,
        });
      }
      const currentIds = new Set(currentSet.items.map(({ id }) => id));
      const storedMentionsTarget = stored?.operations.some(({ id }) => id === input.targetId);
      if (
        (input.operation === "append" && currentIds.has(input.targetId)) ||
        (input.operation === "remove" && !currentIds.has(input.targetId) && !storedMentionsTarget)
      ) {
        throw new PlatformError("SETTING_INVALID", "Shortcut operation is not applicable");
      }
      const operations: readonly PresentationOrderedSetOperation[] = [
        ...(stored?.operations.filter(({ id }) => id !== input.targetId) ?? []),
        { id: input.targetId, operation: input.operation },
      ];
      const nextVersion = currentVersion + 1;
      const nextStored = { operations, version: nextVersion };
      const nextSet = resolveShortcutSet(
        input.settingKey,
        input.contextKind,
        input.contextId,
        nextStored,
        eligibleTargets,
      );
      const nextIds = new Set(nextSet.items.map(({ id }) => id));
      if (
        (input.operation === "append" && !nextIds.has(input.targetId)) ||
        (input.operation === "remove" && nextIds.has(input.targetId))
      ) {
        throw new PlatformError("SETTING_INVALID", "Shortcut operation did not resolve");
      }
      const serializedPatch = JSON.stringify({ operations });
      if (stored) {
        const updated = await transaction.client.query(
          `UPDATE presentation_shortcut_user_patches
           SET patch = $6::jsonb, version = $7, updated_at = now(),
               updated_by_principal_id = $2
           WHERE tenant_id = $1 AND principal_id = $2 AND setting_key = $3
             AND context_kind = $4 AND context_id = $5 AND version = $8`,
          [
            context.tenantId,
            context.actorPrincipalId,
            input.settingKey,
            input.contextKind,
            input.contextId,
            serializedPatch,
            nextVersion,
            currentVersion,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new PlatformError("IDEMPOTENCY_CONFLICT", "Shortcut version has changed");
        }
      } else {
        const inserted = await transaction.client.query(
          `INSERT INTO presentation_shortcut_user_patches
             (tenant_id, principal_id, setting_key, context_kind, context_id,
              patch, version, updated_by_principal_id)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, $2)
           ON CONFLICT DO NOTHING`,
          [
            context.tenantId,
            context.actorPrincipalId,
            input.settingKey,
            input.contextKind,
            input.contextId,
            serializedPatch,
          ],
        );
        if (inserted.rowCount !== 1) {
          const concurrentSet = await loadShortcutSet(
            transaction,
            discovery,
            input.settingKey,
            input.contextKind,
            input.contextId,
            "update",
          );
          const concurrentReplay = await readShortcutReplay(
            transaction,
            input,
            subjectId,
            concurrentSet,
            eligibleTargets,
          );
          if (concurrentReplay) return concurrentReplay;
          throw new PlatformError("IDEMPOTENCY_CONFLICT", "Shortcut version has changed");
        }
      }
      const newState = JSON.stringify({
        billingState: PRESENTATION_BILLING_STATE,
        contextId: input.contextId,
        contextKind: input.contextKind,
        expectedVersion: input.expectedVersion,
        operation: input.operation,
        settingKey: input.settingKey,
        targetId: input.targetId,
        version: nextVersion,
      });
      const priorState = stored
        ? JSON.stringify({ operations: stored.operations, version: stored.version })
        : null;
      const evidence = await appendEvidence(transaction, {
        eventType: SHORTCUT_EVENT_TYPE,
        newState,
        priorState,
        subjectId,
        subjectType: SHORTCUT_SUBJECT_TYPE,
      });
      return {
        billingState: PRESENTATION_BILLING_STATE,
        evidenceEventId: evidence.evidenceEventId,
        replayed: evidence.replayed,
        set: nextSet,
      };
    },
    activationServiceKeys.length > 0
      ? { migrationBarrier: "shared", serviceActivationKeys: activationServiceKeys }
      : { migrationBarrier: "shared" },
  );
}

type PreferenceMutationOperation =
  | "reset_tenant_defaults"
  | "reset_user_preferences"
  | "update_tenant_defaults"
  | "update_user_preferences";

function parsePreferenceEvidenceState<TInput>(
  value: string,
  operation: PreferenceMutationOperation,
  parseInput: (input: unknown) => TInput,
): {
  readonly request: TInput;
  readonly snapshot: PresentationPreferences;
} {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !==
        JSON.stringify(["billingState", "operation", "request", "snapshot"].sort())
    ) {
      throw new Error("invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (record.billingState !== PRESENTATION_BILLING_STATE || record.operation !== operation) {
      throw new Error("invalid");
    }
    return {
      request: parseInput(record.request),
      snapshot: parsePresentationPreferences(record.snapshot),
    };
  } catch {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference retry evidence is invalid");
  }
}

function preferenceMutationResponse(
  preferences: PresentationPreferences,
  evidenceEventId: string,
  replayed: boolean,
): UpdatePresentationPreferencesResponse {
  return {
    ...preferences,
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId,
    replayed,
  };
}

async function readPreferenceReplay<TInput>(
  transaction: TenantTransaction,
  input: TInput,
  operation: PreferenceMutationOperation,
  eventType: string,
  subjectType: string,
  subjectId: string,
  parseInput: (value: unknown) => TInput,
): Promise<UpdatePresentationPreferencesResponse | undefined> {
  const result = await transaction.client.query<{
    actor_principal_id: string;
    evidence_event_id: string;
    new_state: string;
  }>(
    `SELECT evidence_event_id, actor_principal_id, new_state
     FROM evidence_events
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND event_type = $4 AND correlation_id = $5`,
    [
      transaction.context.tenantId,
      subjectType,
      subjectId,
      eventType,
      transaction.context.correlationId,
    ],
  );
  const replay = result.rows[0];
  if (!replay) return undefined;
  const state = parsePreferenceEvidenceState(replay.new_state, operation, parseInput);
  if (
    replay.actor_principal_id !== transaction.context.actorPrincipalId ||
    JSON.stringify(state.request) !== JSON.stringify(input)
  ) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference retry changed its semantics");
  }
  return preferenceMutationResponse(state.snapshot, replay.evidence_event_id, true);
}

async function lockPreferenceSubject(
  transaction: TenantTransaction,
  subjectType: "tenant_default" | "user_override",
  subjectId: string,
): Promise<StoredPreferenceLayer | undefined> {
  await transaction.client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('platform.presentation.preferences:' || $1 || ':' || $2 || ':' || $3, 0)
     )`,
    [transaction.context.tenantId, subjectType, subjectId],
  );
  return await loadScopedPreference(transaction, subjectType, subjectId, true);
}

function preferenceRows(
  input: AppearanceValues,
  locks: {
    readonly lockDensity: boolean;
    readonly requireHighContrast: boolean;
    readonly requireReducedMotion: boolean;
  },
): readonly (readonly [string, boolean | string, boolean])[] {
  return [
    [APPEARANCE_DENSITY_KEY, input.density, locks.lockDensity],
    [APPEARANCE_HIGH_CONTRAST_KEY, input.highContrast, locks.requireHighContrast],
    [APPEARANCE_PALETTE_KEY, input.palette, false],
    [APPEARANCE_REDUCED_MOTION_KEY, input.reducedMotion, locks.requireReducedMotion],
  ];
}

async function writePreferenceLayer(
  transaction: TenantTransaction,
  subjectType: "tenant_default" | "user_override",
  subjectId: string,
  current: StoredPreferenceLayer | undefined,
  input: AppearanceValues,
  locks: {
    readonly lockDensity: boolean;
    readonly requireHighContrast: boolean;
    readonly requireReducedMotion: boolean;
  },
): Promise<void> {
  const nextVersion = (current?.version ?? 0) + 1;
  const rows = preferenceRows(input, locks);
  if (current) {
    const result = await transaction.client.query(
      `UPDATE presentation_setting_values AS stored
       SET value = candidate.value::jsonb,
           locked = candidate.locked,
           version = $4,
           updated_at = now(),
           updated_by_principal_id = $5
       FROM (
         VALUES ($6::text, $7::text, $8::boolean),
                ($9::text, $10::text, $11::boolean),
                ($12::text, $13::text, $14::boolean),
                ($15::text, $16::text, $17::boolean)
       ) AS candidate(setting_key, value, locked)
       WHERE stored.tenant_id = $1
         AND stored.subject_type = $2
         AND stored.subject_id = $3
         AND stored.setting_key = candidate.setting_key
         AND stored.version = $18`,
      [
        transaction.context.tenantId,
        subjectType,
        subjectId,
        nextVersion,
        transaction.context.actorPrincipalId,
        ...rows.flatMap(([key, value, locked]) => [key, JSON.stringify(value), locked]),
        current.version,
      ],
    );
    if (result.rowCount !== APPEARANCE_SETTING_KEYS.length) {
      throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference version has changed");
    }
    return;
  }
  const result = await transaction.client.query(
    `INSERT INTO presentation_setting_values
       (tenant_id, subject_type, subject_id, setting_key, value, locked, version,
        updated_by_principal_id)
     SELECT $1, $2, $3, candidate.setting_key, candidate.value::jsonb,
            candidate.locked, 1, $4
     FROM (
       VALUES ($5::text, $6::text, $7::boolean),
              ($8::text, $9::text, $10::boolean),
              ($11::text, $12::text, $13::boolean),
              ($14::text, $15::text, $16::boolean)
     ) AS candidate(setting_key, value, locked)
     ON CONFLICT DO NOTHING`,
    [
      transaction.context.tenantId,
      subjectType,
      subjectId,
      transaction.context.actorPrincipalId,
      ...rows.flatMap(([key, value, locked]) => [key, JSON.stringify(value), locked]),
    ],
  );
  if (result.rowCount !== APPEARANCE_SETTING_KEYS.length) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference version has changed");
  }
}

async function deletePreferenceLayer(
  transaction: TenantTransaction,
  subjectType: "tenant_default" | "user_override",
  subjectId: string,
  expectedVersion: number,
): Promise<void> {
  const result = await transaction.client.query(
    `DELETE FROM presentation_setting_values
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND version = $4 AND setting_key = ANY($5::text[])`,
    [
      transaction.context.tenantId,
      subjectType,
      subjectId,
      expectedVersion,
      APPEARANCE_SETTING_KEYS,
    ],
  );
  if (result.rowCount !== APPEARANCE_SETTING_KEYS.length) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference version has changed");
  }
}

async function recordPreferenceMutation(
  transaction: TenantTransaction,
  operation: PreferenceMutationOperation,
  eventType: string,
  subjectType: string,
  subjectId: string,
  request:
    | UpdatePresentationPreferencesBody
    | UpdateTenantPresentationDefaultsBody
    | ResetPresentationPreferencesBody,
  current: StoredPreferenceLayer | undefined,
  snapshot: PresentationPreferences,
): Promise<UpdatePresentationPreferencesResponse> {
  const evidence = await appendEvidence(transaction, {
    eventType,
    newState: JSON.stringify({
      billingState: PRESENTATION_BILLING_STATE,
      operation,
      request,
      snapshot,
    }),
    priorState: current ? JSON.stringify(current) : null,
    subjectId,
    subjectType,
  });
  return preferenceMutationResponse(snapshot, evidence.evidenceEventId, evidence.replayed);
}

async function assertCurrentTenantPresentationCapability(
  transaction: TenantTransaction,
): Promise<void> {
  const capabilityCurrent = await hasCurrentTenantPresentationCapability(transaction);
  const actionKey = "platform.presentation.tenant_defaults.write";
  const resourceKey = `tenant:${transaction.context.tenantId}:presentation-defaults`;
  const decision = evaluatePolicy(
    {
      actionKey,
      input: { capabilityCurrent },
      resourceKey,
      transaction,
    },
    [
      {
        effect: "allow",
        id: "presentation.current-explicit-capability-may-manage-tenant-defaults",
        matches: (input) => input.capabilityCurrent,
      },
    ],
  );
  assertPolicyAllowed(decision, transaction, actionKey, resourceKey);
}

export async function updateOwnPresentationPreferences(
  pool: Pool,
  context: OperationContext,
  untrustedInput: unknown,
): Promise<UpdatePresentationPreferencesResponse> {
  const input = parsePresentationPreferenceInput(untrustedInput);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.preferences.write_own",
        `principal:${transaction.context.actorPrincipalId}:presentation`,
      );
      const subjectId = preferenceSubjectId(context);
      const current = await lockPreferenceSubject(
        transaction,
        "user_override",
        context.actorPrincipalId,
      );
      const replay = await readPreferenceReplay(
        transaction,
        input,
        "update_user_preferences",
        PREFERENCE_EVENT_TYPE,
        PREFERENCE_SUBJECT_TYPE,
        subjectId,
        parsePresentationPreferenceInput,
      );
      if (replay) return replay;
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference version has changed", {
          currentVersion,
        });
      }
      await writePreferenceLayer(
        transaction,
        "user_override",
        context.actorPrincipalId,
        current,
        input,
        {
          lockDensity: false,
          requireHighContrast: false,
          requireReducedMotion: false,
        },
      );
      const snapshot = await loadPreferencesInTransaction(transaction);
      return await recordPreferenceMutation(
        transaction,
        "update_user_preferences",
        PREFERENCE_EVENT_TYPE,
        PREFERENCE_SUBJECT_TYPE,
        subjectId,
        input,
        current,
        snapshot,
      );
    },
    { migrationBarrier: "shared" },
  );
}

export async function resetOwnPresentationPreferences(
  pool: Pool,
  context: OperationContext,
  untrustedInput: unknown,
): Promise<UpdatePresentationPreferencesResponse> {
  let input: ResetPresentationPreferencesBody;
  try {
    input = parseResetPresentationPreferencesBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation preference reset is invalid");
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.preferences.write_own",
        `principal:${transaction.context.actorPrincipalId}:presentation`,
      );
      const subjectId = preferenceSubjectId(context);
      const current = await lockPreferenceSubject(
        transaction,
        "user_override",
        context.actorPrincipalId,
      );
      const replay = await readPreferenceReplay(
        transaction,
        input,
        "reset_user_preferences",
        PREFERENCE_RESET_EVENT_TYPE,
        PREFERENCE_SUBJECT_TYPE,
        subjectId,
        parseResetPresentationPreferencesBody,
      );
      if (replay) return replay;
      if (!current || current.version !== input.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference version has changed", {
          currentVersion: current?.version ?? 0,
        });
      }
      await deletePreferenceLayer(
        transaction,
        "user_override",
        context.actorPrincipalId,
        input.expectedVersion,
      );
      const snapshot = await loadPreferencesInTransaction(transaction);
      return await recordPreferenceMutation(
        transaction,
        "reset_user_preferences",
        PREFERENCE_RESET_EVENT_TYPE,
        PREFERENCE_SUBJECT_TYPE,
        subjectId,
        input,
        current,
        snapshot,
      );
    },
    { migrationBarrier: "shared" },
  );
}

export async function updateTenantPresentationDefaults(
  pool: Pool,
  context: OperationContext,
  untrustedInput: unknown,
): Promise<UpdatePresentationPreferencesResponse> {
  let input: UpdateTenantPresentationDefaultsBody;
  try {
    input = parseUpdateTenantPresentationDefaultsBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Tenant presentation defaults are invalid");
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentTenantPresentationCapability(transaction);
      const subjectId = tenantPreferenceSubjectId(context);
      const current = await lockPreferenceSubject(transaction, "tenant_default", context.tenantId);
      const replay = await readPreferenceReplay(
        transaction,
        input,
        "update_tenant_defaults",
        TENANT_PREFERENCE_EVENT_TYPE,
        TENANT_PREFERENCE_SUBJECT_TYPE,
        subjectId,
        parseUpdateTenantPresentationDefaultsBody,
      );
      if (replay) return replay;
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Tenant preference version has changed", {
          currentVersion,
        });
      }
      await writePreferenceLayer(transaction, "tenant_default", context.tenantId, current, input, {
        lockDensity: input.lockDensity,
        requireHighContrast: input.requireHighContrast,
        requireReducedMotion: input.requireReducedMotion,
      });
      const snapshot = await loadPreferencesInTransaction(transaction, true);
      return await recordPreferenceMutation(
        transaction,
        "update_tenant_defaults",
        TENANT_PREFERENCE_EVENT_TYPE,
        TENANT_PREFERENCE_SUBJECT_TYPE,
        subjectId,
        input,
        current,
        snapshot,
      );
    },
    { migrationBarrier: "shared" },
  );
}

export async function resetTenantPresentationDefaults(
  pool: Pool,
  context: OperationContext,
  untrustedInput: unknown,
): Promise<UpdatePresentationPreferencesResponse> {
  let input: ResetPresentationPreferencesBody;
  try {
    input = parseResetPresentationPreferencesBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Tenant presentation reset is invalid");
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentTenantPresentationCapability(transaction);
      const subjectId = tenantPreferenceSubjectId(context);
      const current = await lockPreferenceSubject(transaction, "tenant_default", context.tenantId);
      const replay = await readPreferenceReplay(
        transaction,
        input,
        "reset_tenant_defaults",
        TENANT_PREFERENCE_RESET_EVENT_TYPE,
        TENANT_PREFERENCE_SUBJECT_TYPE,
        subjectId,
        parseResetPresentationPreferencesBody,
      );
      if (replay) return replay;
      if (!current || current.version !== input.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Tenant preference version has changed", {
          currentVersion: current?.version ?? 0,
        });
      }
      await deletePreferenceLayer(
        transaction,
        "tenant_default",
        context.tenantId,
        input.expectedVersion,
      );
      const snapshot = await loadPreferencesInTransaction(transaction, true);
      return await recordPreferenceMutation(
        transaction,
        "reset_tenant_defaults",
        TENANT_PREFERENCE_RESET_EVENT_TYPE,
        TENANT_PREFERENCE_SUBJECT_TYPE,
        subjectId,
        input,
        current,
        snapshot,
      );
    },
    { migrationBarrier: "shared" },
  );
}

function parseSurfacePlacements(value: unknown): readonly PresentationWidgetPlacement[] {
  try {
    return parseUpdatePresentationSurfaceOverlayBody({
      expectedVersion: 0,
      placements: value,
    }).placements;
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface layout is invalid");
  }
}

function canonicalPlacements(placements: readonly PresentationWidgetPlacement[]): string {
  return JSON.stringify(
    placements.map((placement) => ({
      column: placement.column,
      columnSpan: placement.columnSpan,
      instanceId: placement.instanceId,
      row: placement.row,
      rowSpan: placement.rowSpan,
      widgetDefinitionId: placement.widgetDefinitionId,
      widgetDefinitionVersion: placement.widgetDefinitionVersion,
    })),
  );
}

const legacyV1PlacementKeys = [
  "column",
  "columnSpan",
  "instanceId",
  "row",
  "rowSpan",
  "widgetDefinitionId",
] as const;
const currentPlacementKeys = [...legacyV1PlacementKeys, "widgetDefinitionVersion"] as const;

function exactPlacementKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function upgradeLegacyV1SurfacePlacements(surfaceId: ZenV1SurfaceId, value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return value;
  if (value.every((placement) => exactPlacementKeys(placement, currentPlacementKeys))) {
    return value;
  }
  if (!value.every((placement) => exactPlacementKeys(placement, legacyV1PlacementKeys))) {
    return value;
  }
  const expected = new Map(
    getZenV1SurfaceContract(surfaceId).basePlacements.map((placement) => [
      `${placement.instanceId}:${placement.widgetDefinitionId}`,
      placement.widgetDefinitionVersion,
    ]),
  );
  const upgraded = value.map((placement) => {
    const version = expected.get(
      `${String(placement.instanceId)}:${String(placement.widgetDefinitionId)}`,
    );
    if (version !== 1) return placement;
    return { ...placement, widgetDefinitionVersion: version };
  });
  return upgraded.every((placement) => exactPlacementKeys(placement, currentPlacementKeys))
    ? upgraded
    : value;
}

function upgradeLegacyV1SurfacePlacementProperties(
  surfaceId: ZenV1SurfaceId,
  value: unknown,
  properties: readonly string[],
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let upgraded = record;
  for (const property of properties) {
    if (!Object.hasOwn(record, property)) continue;
    const next = upgradeLegacyV1SurfacePlacements(surfaceId, record[property]);
    if (next === record[property]) continue;
    if (upgraded === record) upgraded = { ...record };
    upgraded[property] = next;
  }
  return upgraded;
}

function rectanglesOverlap(
  left: PresentationWidgetPlacement,
  right: PresentationWidgetPlacement,
): boolean {
  return (
    left.column < right.column + right.columnSpan &&
    right.column < left.column + left.columnSpan &&
    left.row < right.row + right.rowSpan &&
    right.row < left.row + left.rowSpan
  );
}

export function validatePersonalSurfacePlacements(
  surfaceId: ZenV1SurfaceId,
  untrustedPlacements: unknown,
): readonly PresentationWidgetPlacement[] {
  return validateRegisteredSurfacePlacementSubset(surfaceId, untrustedPlacements);
}

function validateRegisteredSurfacePlacementSubset(
  surfaceId: ZenV1SurfaceId,
  untrustedPlacements: unknown,
): readonly PresentationWidgetPlacement[] {
  const placements = parseSurfacePlacements(untrustedPlacements);
  const registeredPlacements = getZenV1RegisteredSurfacePlacements(surfaceId);
  if (placements.length > registeredPlacements.length) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface instance set is invalid");
  }
  const expected = new Map(
    registeredPlacements.map((placement) => [
      placement.instanceId,
      `${placement.widgetDefinitionId}@${placement.widgetDefinitionVersion}`,
    ]),
  );
  for (const placement of placements) {
    if (
      expected.get(placement.instanceId) !==
      `${placement.widgetDefinitionId}@${placement.widgetDefinitionVersion}`
    ) {
      throw new PlatformError(
        "SETTING_INVALID",
        "Presentation surface registry binding is invalid",
      );
    }
  }
  return placements;
}

function validateEligiblePersonalSurfacePlacements(
  surfaceId: ZenV1SurfaceId,
  untrustedPlacements: unknown,
  eligibleWidgetDefinitionIds: ReadonlySet<string>,
  basePlacements: readonly PresentationWidgetPlacement[],
): readonly PresentationWidgetPlacement[] {
  const placements = validateRegisteredSurfacePlacementSubset(surfaceId, untrustedPlacements);
  const expected = new Map(
    getZenV1RegisteredSurfacePlacements(surfaceId)
      .filter(({ widgetDefinitionId }) => eligibleWidgetDefinitionIds.has(widgetDefinitionId))
      .map((placement) => [
        placement.instanceId,
        `${placement.widgetDefinitionId}@${placement.widgetDefinitionVersion}`,
      ]),
  );
  if (expected.size === 0) {
    throw new PlatformError("POLICY_DENIED", "Presentation surface is not currently eligible");
  }
  for (const placement of placements) {
    if (
      expected.get(placement.instanceId) !==
      `${placement.widgetDefinitionId}@${placement.widgetDefinitionVersion}`
    ) {
      throw new PlatformError("POLICY_DENIED", "Presentation surface is not currently eligible");
    }
  }
  const requiredInstanceIds = new Set(
    getZenV1SurfaceContract(surfaceId)
      .defaultInstances.filter(
        ({ instanceId, placementPolicy }) =>
          placementPolicy === "default_required" &&
          expected.has(instanceId) &&
          basePlacements.some((placement) => placement.instanceId === instanceId),
      )
      .map(({ instanceId }) => instanceId),
  );
  if (
    [...requiredInstanceIds].some(
      (instanceId) => !placements.some((placement) => placement.instanceId === instanceId),
    )
  ) {
    throw new PlatformError("POLICY_DENIED", "A required presentation widget cannot be removed");
  }
  return placements;
}

interface StoredSurfaceBase {
  readonly basedOnVersion: number | null;
  readonly basePlacements: readonly PresentationWidgetPlacement[];
  readonly baseVersion: number;
  readonly definitionHash: string;
  readonly headRowVersion: number;
}

interface StoredSurfaceOverlay {
  readonly baseVersion: number;
  readonly placements: readonly PresentationWidgetPlacement[];
  readonly version: number;
}

function codeDefaultSurfaceBase(surfaceId: ZenV1SurfaceId): StoredSurfaceBase {
  const contract = getZenV1SurfaceContract(surfaceId);
  return {
    basedOnVersion: null,
    basePlacements: contract.basePlacements,
    baseVersion: contract.baseVersion,
    definitionHash: contract.definitionHash,
    headRowVersion: 0,
  };
}

async function loadStoredSurfaceBase(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  lock: "none" | "share" | "update" = "none",
): Promise<StoredSurfaceBase | undefined> {
  const result = await transaction.client.query<{
    based_on_version: number | null;
    base_version: number;
    definition_hash: string;
    head_row_version: number;
    layout: unknown;
  }>(
    `SELECT v.base_version, v.based_on_version, v.definition_hash, v.layout,
            h.row_version AS head_row_version
     FROM presentation_surface_heads AS h
     JOIN presentation_surface_versions AS v
       ON v.tenant_id = h.tenant_id
      AND v.surface_id = h.surface_id
      AND v.base_version = h.current_base_version
     WHERE h.tenant_id = $1 AND h.surface_id = $2
     ${lock === "update" ? "FOR UPDATE OF h" : lock === "share" ? "FOR SHARE OF h" : ""}`,
    [transaction.context.tenantId, surfaceId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  let parsed: PresentationSurfaceBaseVersion;
  try {
    parsed = parsePresentationSurfaceBaseVersion({
      basedOnVersion: row.based_on_version,
      baseVersion: row.base_version,
      definitionHash: row.definition_hash,
      placements: row.layout,
      surfaceId,
    });
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface base has drifted");
  }
  if (!Number.isSafeInteger(row.head_row_version) || row.head_row_version < 1) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface base has drifted");
  }
  return {
    basedOnVersion: parsed.basedOnVersion,
    basePlacements: parsed.placements,
    baseVersion: parsed.baseVersion,
    definitionHash: parsed.definitionHash,
    headRowVersion: row.head_row_version,
  };
}

async function materializeSurfaceBase(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<StoredSurfaceBase> {
  const contract = getZenV1SurfaceContract(surfaceId);
  const serializedBase = canonicalPlacements(contract.basePlacements);
  await transaction.client.query(
    `INSERT INTO presentation_surface_versions
       (tenant_id, surface_id, base_version, based_on_version, definition_hash, layout,
        published_by_principal_id)
     VALUES ($1, $2, $3, NULL, $4, $5::jsonb, $6)
     ON CONFLICT (tenant_id, surface_id, base_version) DO NOTHING`,
    [
      transaction.context.tenantId,
      surfaceId,
      contract.baseVersion,
      contract.definitionHash,
      serializedBase,
      transaction.context.actorPrincipalId,
    ],
  );
  await transaction.client.query(
    `INSERT INTO presentation_surface_heads
       (tenant_id, surface_id, current_base_version, row_version,
        updated_by_principal_id)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (tenant_id, surface_id) DO NOTHING`,
    [
      transaction.context.tenantId,
      surfaceId,
      contract.baseVersion,
      transaction.context.actorPrincipalId,
    ],
  );
  const stored = await loadStoredSurfaceBase(transaction, surfaceId);
  if (!stored) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface base is unavailable");
  }
  return stored;
}

async function materializeCodeOwnedSurfaceBases(
  transaction: TenantTransaction,
): Promise<ReadonlyMap<ZenV1SurfaceId, StoredSurfaceBase>> {
  const bases = new Map<ZenV1SurfaceId, StoredSurfaceBase>();
  for (const surfaceId of zenV1SurfaceIds) {
    bases.set(surfaceId, await materializeSurfaceBase(transaction, surfaceId));
  }
  return bases;
}

async function loadOwnSurfaceOverlay(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<StoredSurfaceOverlay | undefined> {
  const result = await transaction.client.query<{
    base_version: number;
    layout: unknown;
    version: number;
  }>(
    `SELECT base_version, layout, version
     FROM presentation_surface_overlays
     WHERE tenant_id = $1 AND principal_id = $2 AND surface_id = $3`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, surfaceId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (
    !Number.isSafeInteger(row.base_version) ||
    row.base_version < 1 ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1
  ) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface overlay is invalid");
  }
  return {
    baseVersion: row.base_version,
    placements: validateRegisteredSurfacePlacementSubset(surfaceId, row.layout),
    version: row.version,
  };
}

async function loadStoredSurfaceVersion(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  baseVersion: number,
): Promise<PresentationSurfaceBaseVersion | undefined> {
  const result = await transaction.client.query<{
    based_on_version: number | null;
    base_version: number;
    definition_hash: string;
    layout: unknown;
  }>(
    `SELECT base_version, based_on_version, definition_hash, layout
     FROM presentation_surface_versions
     WHERE tenant_id = $1 AND surface_id = $2 AND base_version = $3`,
    [transaction.context.tenantId, surfaceId, baseVersion],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  try {
    return parsePresentationSurfaceBaseVersion({
      basedOnVersion: row.based_on_version,
      baseVersion: row.base_version,
      definitionHash: row.definition_hash,
      placements: row.layout,
      surfaceId,
    });
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface history has drifted");
  }
}

function rebasePlacement(
  historicalBase: PresentationWidgetPlacement,
  currentBase: PresentationWidgetPlacement,
  personal: PresentationWidgetPlacement,
): PresentationWidgetPlacement {
  return {
    column: personal.column === historicalBase.column ? currentBase.column : personal.column,
    columnSpan:
      personal.columnSpan === historicalBase.columnSpan
        ? currentBase.columnSpan
        : personal.columnSpan,
    instanceId: currentBase.instanceId,
    row: personal.row === historicalBase.row ? currentBase.row : personal.row,
    rowSpan: personal.rowSpan === historicalBase.rowSpan ? currentBase.rowSpan : personal.rowSpan,
    widgetDefinitionId: currentBase.widgetDefinitionId,
    widgetDefinitionVersion: currentBase.widgetDefinitionVersion,
  };
}

async function rebaseSurfaceOverlay(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  base: StoredSurfaceBase,
  overlay: StoredSurfaceOverlay | undefined,
): Promise<StoredSurfaceOverlay | undefined> {
  if (!overlay || overlay.baseVersion === base.baseVersion) return overlay;
  const historical = await loadStoredSurfaceVersion(transaction, surfaceId, overlay.baseVersion);
  if (!historical) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface overlay base is unavailable");
  }
  const historicalByInstance = new Map(
    historical.placements.map((placement) => [placement.instanceId, placement]),
  );
  const currentByInstance = new Map(
    base.basePlacements.map((placement) => [placement.instanceId, placement]),
  );
  const registeredByInstance = new Map(
    getZenV1RegisteredSurfacePlacements(surfaceId).map((placement) => [
      placement.instanceId,
      placement,
    ]),
  );
  const rebased = overlay.placements.map((personal) => {
    const historicalPlacement = historicalByInstance.get(personal.instanceId);
    const current = currentByInstance.get(personal.instanceId);
    const registered = registeredByInstance.get(personal.instanceId);
    if (!historicalPlacement || !current) {
      if (
        !registered ||
        personal.widgetDefinitionId !== registered.widgetDefinitionId ||
        personal.widgetDefinitionVersion !== registered.widgetDefinitionVersion
      ) {
        throw new PlatformError(
          "SETTING_INVALID",
          "Presentation surface overlay rebase conflicted",
          {
            conflict: "instance_binding_changed",
          },
        );
      }
      return personal;
    }
    if (
      historicalPlacement.widgetDefinitionId !== current.widgetDefinitionId ||
      personal.widgetDefinitionId !== current.widgetDefinitionId ||
      historicalPlacement.widgetDefinitionVersion !== current.widgetDefinitionVersion ||
      personal.widgetDefinitionVersion !== current.widgetDefinitionVersion
    ) {
      throw new PlatformError("SETTING_INVALID", "Presentation surface overlay rebase conflicted", {
        conflict: "instance_binding_changed",
      });
    }
    return rebasePlacement(historicalPlacement, current, personal);
  });
  let placements: readonly PresentationWidgetPlacement[];
  try {
    placements = validateRegisteredSurfacePlacementSubset(surfaceId, rebased);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface overlay rebase conflicted", {
      conflict: "geometry_invalid",
    });
  }
  return { baseVersion: base.baseVersion, placements, version: overlay.version };
}

export function reconcileRequiredPresentationSurfacePlacements(
  input: Readonly<{
    basePlacements: readonly PresentationWidgetPlacement[];
    personalPlacements: readonly PresentationWidgetPlacement[];
    requiredInstanceIds: ReadonlySet<string>;
  }>,
): Readonly<{
  conflictedInstanceIds: readonly string[];
  placements: readonly PresentationWidgetPlacement[];
}> {
  const personalByInstance = new Map(
    input.personalPlacements.map((placement) => [placement.instanceId, placement]),
  );
  let required = input.basePlacements
    .filter(({ instanceId }) => input.requiredInstanceIds.has(instanceId))
    .map((base) => personalByInstance.get(base.instanceId) ?? base);
  if (
    required.some((placement, index) =>
      required.slice(index + 1).some((candidate) => rectanglesOverlap(placement, candidate)),
    )
  ) {
    required = input.basePlacements.filter(({ instanceId }) =>
      input.requiredInstanceIds.has(instanceId),
    );
  }
  const accepted = [...required];
  const conflictedInstanceIds: string[] = [];
  for (const personal of input.personalPlacements) {
    if (input.requiredInstanceIds.has(personal.instanceId)) continue;
    if (accepted.some((current) => rectanglesOverlap(current, personal))) {
      conflictedInstanceIds.push(personal.instanceId);
    } else {
      accepted.push(personal);
    }
  }
  const sourceOrder = new Map(
    input.basePlacements.map(({ instanceId }, index) => [instanceId, index]),
  );
  accepted.sort(
    (left, right) =>
      (sourceOrder.get(left.instanceId) ?? Number.MAX_SAFE_INTEGER) -
      (sourceOrder.get(right.instanceId) ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    conflictedInstanceIds: Object.freeze(conflictedInstanceIds),
    placements: Object.freeze(accepted),
  };
}

function surfaceLayoutResponse(
  surfaceId: ZenV1SurfaceId,
  base: StoredSurfaceBase,
  overlay?: StoredSurfaceOverlay,
  eligibleWidgetDefinitionIds?: ReadonlySet<string>,
): PresentationSurfaceLayout {
  if (overlay && overlay.baseVersion !== base.baseVersion) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface overlay base is stale");
  }
  const contract = getZenV1SurfaceContract(surfaceId);
  const codeDefault =
    base.baseVersion === contract.baseVersion &&
    canonicalPlacements(base.basePlacements) === canonicalPlacements(contract.basePlacements);
  const filterEligible = (placements: readonly PresentationWidgetPlacement[]) =>
    eligibleWidgetDefinitionIds
      ? placements.filter(({ widgetDefinitionId }) =>
          eligibleWidgetDefinitionIds.has(widgetDefinitionId),
        )
      : placements;
  const basePlacements = filterEligible(base.basePlacements);
  let effectivePlacements: PresentationWidgetPlacement[] = [...basePlacements];
  const diagnostics: Array<{
    readonly code: "overlay_placement_conflict";
    readonly instanceId: string;
  }> = [];
  if (overlay) {
    const proposed = filterEligible(overlay.placements);
    const requiredInstanceIds = new Set(
      contract.defaultInstances
        .filter(
          ({ instanceId, placementPolicy }) =>
            placementPolicy === "default_required" &&
            basePlacements.some((placement) => placement.instanceId === instanceId),
        )
        .map(({ instanceId }) => instanceId),
    );
    const reconciled = reconcileRequiredPresentationSurfacePlacements({
      basePlacements,
      personalPlacements: proposed,
      requiredInstanceIds,
    });
    diagnostics.push(
      ...reconciled.conflictedInstanceIds.map((instanceId) => ({
        code: "overlay_placement_conflict" as const,
        instanceId,
      })),
    );
    const policySafeProposed = reconciled.placements;
    const overlaps = policySafeProposed.some((placement, index) =>
      policySafeProposed
        .slice(index + 1)
        .some((candidate) => rectanglesOverlap(placement, candidate)),
    );
    if (!overlaps) {
      effectivePlacements = [...policySafeProposed];
    } else {
      effectivePlacements = [];
      for (const candidate of policySafeProposed) {
        if (!effectivePlacements.some((other) => rectanglesOverlap(candidate, other))) {
          effectivePlacements.push(candidate);
        } else {
          diagnostics.push({
            code: "overlay_placement_conflict",
            instanceId: candidate.instanceId,
          });
        }
      }
    }
  }
  return {
    baseDefinitionHash: base.definitionHash,
    basePlacements,
    baseVersion: base.baseVersion,
    diagnostics,
    effectivePlacements,
    overlayVersion: overlay?.version ?? 0,
    source: overlay ? "user_overlay" : codeDefault ? "code_default" : "tenant_base",
    surfaceId,
  };
}

async function hasCurrentOwnPresentationLayoutCapability(
  transaction: TenantTransaction,
  actionKey:
    | "platform.presentation.layouts.read_own"
    | "platform.presentation.layouts.reset_own"
    | "platform.presentation.layouts.write_own",
): Promise<boolean> {
  const capability = await transaction.client.query<{ capability_current: boolean }>(
    `SELECT public.esbla_lock_membership_capability($1, $2, $3) AS capability_current`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  return capability.rows[0]?.capability_current === true;
}

async function assertCurrentOwnPresentationLayoutCapability(
  transaction: TenantTransaction,
  actionKey:
    | "platform.presentation.layouts.read_own"
    | "platform.presentation.layouts.reset_own"
    | "platform.presentation.layouts.write_own",
  surfaceId: ZenV1SurfaceId,
): Promise<void> {
  const decision = evaluatePolicy(
    {
      actionKey,
      input: {
        capabilityCurrent: await hasCurrentOwnPresentationLayoutCapability(transaction, actionKey),
      },
      resourceKey: `principal:${transaction.context.actorPrincipalId}:surface:${surfaceId}`,
      transaction,
    },
    [
      {
        effect: "allow",
        id: "presentation.current-explicit-capability-may-access-own-layout",
        matches: (input) => input.capabilityCurrent,
      },
    ],
  );
  assertPolicyAllowed(
    decision,
    transaction,
    actionKey,
    `principal:${transaction.context.actorPrincipalId}:surface:${surfaceId}`,
  );
}

interface SurfacePersonalizationSetting {
  readonly enabled: boolean;
  readonly version: number;
}

async function lockSurfacePersonalizationSetting(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  mode: "exclusive" | "shared",
): Promise<void> {
  const lockKey = `${SURFACE_PERSONALIZATION_LOCK_NAMESPACE}:${transaction.context.tenantId}:${surfaceId}`;
  await transaction.client.query(
    mode === "exclusive"
      ? `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`
      : `SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`,
    [lockKey],
  );
}

async function loadSurfacePersonalizationSetting(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  lock: "exclusive" | "none" | "shared" = "none",
): Promise<SurfacePersonalizationSetting> {
  if (lock !== "none") {
    await lockSurfacePersonalizationSetting(transaction, surfaceId, lock);
  }
  const result = await transaction.client.query<{
    personalization_enabled: boolean;
    version: number;
  }>(
    `SELECT personalization_enabled, version
     FROM presentation_surface_settings
     WHERE tenant_id = $1 AND surface_id = $2`,
    [transaction.context.tenantId, surfaceId],
  );
  const row = result.rows[0];
  if (
    row &&
    (typeof row.personalization_enabled !== "boolean" ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1)
  ) {
    throw new PlatformError("SETTING_INVALID", "Surface personalization setting is invalid");
  }
  const resolved = resolvePresentationSetting(
    "surface.personalization_enabled.v1",
    row
      ? [
          {
            definitionVersion: 1,
            rowVersion: row.version,
            scope: "tenant_surface",
            value: row.personalization_enabled,
          },
        ]
      : [],
    {},
  );
  if (
    typeof resolved.value !== "boolean" ||
    (resolved.sourceScope !== "product_default" && resolved.sourceScope !== "tenant_surface")
  ) {
    throw new PlatformError("SETTING_INVALID", "Surface personalization setting is invalid");
  }
  return { enabled: resolved.value, version: row?.version ?? 0 };
}

async function assertSurfacePersonalizationEnabled(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<void> {
  if (!(await loadSurfacePersonalizationSetting(transaction, surfaceId, "shared")).enabled) {
    throw new PlatformError("POLICY_DENIED", "Personal surface editing is disabled");
  }
}

async function widgetIsActorRelevant(
  transaction: TenantTransaction,
  definition: PresentationWidgetDefinition,
): Promise<boolean> {
  const routeDestinations =
    definition.fullScreenRoute === null
      ? []
      : PRESENTATION_SERVICE_GROUP_DEFINITIONS.flatMap(({ services }) =>
          services.flatMap(({ destinations }) =>
            destinations.filter(({ href }) => href === definition.fullScreenRoute),
          ),
        );
  if (
    routeDestinations.length > 0 &&
    !routeDestinations.some(({ allowedRoleKeys }) =>
      allowedRoleKeys.includes(transaction.actor.roleKey),
    )
  ) {
    return false;
  }
  if (definition.id !== "hr.workforce.direct-reports") return true;
  const result = await transaction.client.query<{
    value: unknown;
    value_type: string;
    version: number;
  }>(
    `SELECT value, value_type, version
     FROM tenant_settings
     WHERE tenant_id = $1 AND setting_key = 'hr.workforce_profile.manager_visibility'`,
    [transaction.context.tenantId],
  );
  const setting = result.rows[0];
  if (!setting) return true;
  if (
    result.rows.length !== 1 ||
    setting.value_type !== "enum" ||
    (setting.value !== "minimized" && setting.value !== "none") ||
    !Number.isSafeInteger(setting.version) ||
    setting.version < 1
  ) {
    throw new PlatformError("SETTING_INVALID", "Widget actor relevance setting is invalid");
  }
  return setting.value === "minimized";
}

async function loadEligibleWidgetDefinitionIds(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  authorityLock: "none" | "share" = "none",
): Promise<ReadonlySet<string>> {
  const definitions = [
    ...new Map(
      getZenV1RegisteredSurfaceInstances(surfaceId).map(
        ({ widgetDefinitionId, widgetDefinitionVersion }) => [
          `${widgetDefinitionId}@${widgetDefinitionVersion}`,
          { widgetDefinitionId, widgetDefinitionVersion },
        ],
      ),
    ).values(),
  ]
    .map(({ widgetDefinitionId, widgetDefinitionVersion }) =>
      getPresentationWidgetDefinition(widgetDefinitionId, widgetDefinitionVersion),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const serviceKeys = [
    ...new Set(
      definitions.flatMap((definition) =>
        definition.activationPolicy === "any_provider"
          ? definition.providerEligibility.map(({ activationServiceKey }) => activationServiceKey)
          : [definition.activationServiceKey],
      ),
    ),
  ].sort();
  const capabilityIds = [
    ...new Set(
      definitions.flatMap((definition) =>
        definition.activationPolicy === "any_provider"
          ? definition.providerEligibility.flatMap(
              ({ requiredCapabilityIds }) => requiredCapabilityIds,
            )
          : definition.requiredCapabilityIds,
      ),
    ),
  ].sort();
  const activeServiceKeys = new Set<string>();
  const currentCapabilityIds = new Set<string>();

  if (authorityLock === "share") {
    for (const serviceKey of serviceKeys) {
      const activation = await transaction.client.query<{ activation_state: string | null }>(
        `SELECT public.esbla_lock_service_activation($1, $2, $3) AS activation_state`,
        [transaction.context.tenantId, transaction.context.actorPrincipalId, serviceKey],
      );
      if (activation.rows[0]?.activation_state === "active") activeServiceKeys.add(serviceKey);
    }
    for (const capabilityId of capabilityIds) {
      const capability = await transaction.client.query<{ capability_current: boolean }>(
        `SELECT public.esbla_lock_membership_capability($1, $2, $3) AS capability_current`,
        [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityId],
      );
      if (capability.rows[0]?.capability_current === true) {
        currentCapabilityIds.add(capabilityId);
      }
    }
  } else {
    if (serviceKeys.length > 0) {
      const activations = await transaction.client.query<{ service_key: string }>(
        `SELECT service_key
         FROM service_activations
         WHERE tenant_id = $1 AND service_key = ANY($2::text[]) AND state = 'active'
         ORDER BY service_key`,
        [transaction.context.tenantId, serviceKeys],
      );
      for (const { service_key: serviceKey } of activations.rows) {
        activeServiceKeys.add(serviceKey);
      }
    }
    if (capabilityIds.length > 0) {
      const capabilities = await transaction.client.query<{ capability_id: string }>(
        `SELECT capability_id
         FROM membership_capabilities
         WHERE tenant_id = $1 AND principal_id = $2
           AND capability_id = ANY($3::text[])
         ORDER BY capability_id`,
        [transaction.context.tenantId, transaction.context.actorPrincipalId, capabilityIds],
      );
      for (const { capability_id: capabilityId } of capabilities.rows) {
        currentCapabilityIds.add(capabilityId);
      }
    }
  }

  const eligible = new Set<string>();
  for (const definition of definitions) {
    const actorRelevant = await widgetIsActorRelevant(transaction, definition);
    const exactServiceEligible =
      definition.activationPolicy === "exact_service" &&
      actorRelevant &&
      activeServiceKeys.has(definition.activationServiceKey) &&
      definition.requiredCapabilityIds.every((capabilityId) =>
        currentCapabilityIds.has(capabilityId),
      );
    const providerEligible =
      definition.activationPolicy === "any_provider" &&
      actorRelevant &&
      definition.providerEligibility.some(
        (provider) =>
          activeServiceKeys.has(provider.activationServiceKey) &&
          provider.requiredCapabilityIds.every((capabilityId) =>
            currentCapabilityIds.has(capabilityId),
          ),
      );
    if (exactServiceEligible || providerEligible) {
      eligible.add(definition.id);
    }
  }
  return eligible;
}

function eligibleRegisteredSurfacePlacements(
  surfaceId: ZenV1SurfaceId,
  eligibleWidgetDefinitionIds: ReadonlySet<string>,
): readonly PresentationWidgetPlacement[] {
  return getZenV1RegisteredSurfacePlacements(surfaceId).filter(({ widgetDefinitionId }) =>
    eligibleWidgetDefinitionIds.has(widgetDefinitionId),
  );
}

async function loadTenantEligibleWidgetDefinitionIds(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  authorityLock: "none" | "share" = "none",
): Promise<ReadonlySet<string>> {
  const definitions = [
    ...new Map(
      getZenV1RegisteredSurfaceInstances(surfaceId).map(
        ({ widgetDefinitionId, widgetDefinitionVersion }) => [
          `${widgetDefinitionId}@${widgetDefinitionVersion}`,
          getPresentationWidgetDefinition(widgetDefinitionId, widgetDefinitionVersion),
        ],
      ),
    ).values(),
  ];
  const serviceKeys = [
    ...new Set(
      definitions.flatMap((definition) =>
        definition.activationPolicy === "any_provider"
          ? definition.providerEligibility.map(({ activationServiceKey }) => activationServiceKey)
          : [definition.activationServiceKey],
      ),
    ),
  ].sort();
  const activeServiceKeys = new Set<string>();
  if (authorityLock === "share") {
    for (const serviceKey of serviceKeys) {
      const activation = await transaction.client.query<{ activation_state: string | null }>(
        `SELECT public.esbla_lock_service_activation($1, $2, $3) AS activation_state`,
        [transaction.context.tenantId, transaction.context.actorPrincipalId, serviceKey],
      );
      if (activation.rows[0]?.activation_state === "active") activeServiceKeys.add(serviceKey);
    }
  } else if (serviceKeys.length > 0) {
    const activations = await transaction.client.query<{ service_key: string }>(
      `SELECT service_key
       FROM service_activations
       WHERE tenant_id = $1 AND service_key = ANY($2::text[]) AND state = 'active'
       ORDER BY service_key`,
      [transaction.context.tenantId, serviceKeys],
    );
    for (const { service_key: serviceKey } of activations.rows) {
      activeServiceKeys.add(serviceKey);
    }
  }
  return new Set(
    definitions
      .filter((definition) =>
        definition.activationPolicy === "any_provider"
          ? definition.providerEligibility.some(({ activationServiceKey }) =>
              activeServiceKeys.has(activationServiceKey),
            )
          : activeServiceKeys.has(definition.activationServiceKey),
      )
      .map(({ id }) => id),
  );
}

async function loadOwnPresentationSurfaceState(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<
  Readonly<{
    eligibleWidgetDefinitionIds: ReadonlySet<string>;
    layout: PresentationSurfaceLayout;
  }>
> {
  assertOwnPresentationPolicy(
    transaction,
    "platform.presentation.layouts.read_own",
    `principal:${transaction.context.actorPrincipalId}:surface:${surfaceId}`,
  );
  await assertCurrentOwnPresentationLayoutCapability(
    transaction,
    "platform.presentation.layouts.read_own",
    surfaceId,
  );
  const base =
    (await loadStoredSurfaceBase(transaction, surfaceId)) ?? codeDefaultSurfaceBase(surfaceId);
  const overlay = await rebaseSurfaceOverlay(
    transaction,
    surfaceId,
    base,
    await loadOwnSurfaceOverlay(transaction, surfaceId),
  );
  const eligibleWidgetDefinitionIds = await loadEligibleWidgetDefinitionIds(transaction, surfaceId);
  if (surfaceId === "surface.hr.mission-control" && eligibleWidgetDefinitionIds.size === 0) {
    throw new PlatformError("POLICY_DENIED", "Presentation surface is not currently eligible");
  }
  return {
    eligibleWidgetDefinitionIds,
    layout: surfaceLayoutResponse(surfaceId, base, overlay, eligibleWidgetDefinitionIds),
  };
}

async function loadOwnPresentationSurfaceLayout(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<PresentationSurfaceLayout> {
  return (await loadOwnPresentationSurfaceState(transaction, surfaceId)).layout;
}

export async function getOwnPresentationSurfaceLayout(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
): Promise<PresentationSurfaceLayout> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => await loadOwnPresentationSurfaceLayout(transaction, surfaceId),
    { migrationBarrier: "shared" },
  );
}

export async function getOwnPresentationPersonalSurfaceEditorWorkspace(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
): Promise<PresentationPersonalSurfaceEditorWorkspace> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      const { eligibleWidgetDefinitionIds, layout } = await loadOwnPresentationSurfaceState(
        transaction,
        surfaceId,
      );
      const personalization = await loadSurfacePersonalizationSetting(
        transaction,
        surfaceId,
        "shared",
      );
      const writeCapable = await hasCurrentOwnPresentationLayoutCapability(
        transaction,
        "platform.presentation.layouts.write_own",
      );
      const resetCapable = await hasCurrentOwnPresentationLayoutCapability(
        transaction,
        "platform.presentation.layouts.reset_own",
      );
      const editable = personalization.enabled && writeCapable;
      return {
        availablePlacements: eligibleRegisteredSurfacePlacements(
          surfaceId,
          eligibleWidgetDefinitionIds,
        ),
        editable,
        layout,
        lockReason: editable
          ? null
          : personalization.enabled
            ? "layout_write_capability_absent"
            : "tenant_personalization_disabled",
        resettable: personalization.enabled && resetCapable,
      };
    },
    { migrationBarrier: "shared" },
  );
}

function surfaceOverlaySubjectId(context: OperationContext, surfaceId: ZenV1SurfaceId): string {
  return deriveStableUuid(
    "platform.presentation.surface-overlay",
    context.tenantId,
    context.actorPrincipalId,
    surfaceId,
  );
}

interface SurfaceOverlayEvidenceState {
  readonly baseVersion: number;
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly expectedVersion: number;
  readonly materializedBaseDefinitionHashes: readonly string[];
  readonly placements: readonly PresentationWidgetPlacement[];
  readonly surfaceId: ZenV1SurfaceId;
  readonly version: number;
}

function parseSurfaceOverlayEvidenceState(
  value: string,
  expectedSurfaceId: ZenV1SurfaceId,
): SurfaceOverlayEvidenceState {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !==
        JSON.stringify(
          [
            "baseVersion",
            "billingState",
            "expectedVersion",
            "materializedBaseDefinitionHashes",
            "placements",
            "surfaceId",
            "version",
          ].sort(),
        )
    ) {
      throw new Error("invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.billingState !== PRESENTATION_BILLING_STATE ||
      record.surfaceId !== expectedSurfaceId ||
      !Number.isSafeInteger(record.baseVersion) ||
      Number(record.baseVersion) < 1 ||
      !Number.isSafeInteger(record.expectedVersion) ||
      Number(record.expectedVersion) < 0 ||
      !Array.isArray(record.materializedBaseDefinitionHashes) ||
      JSON.stringify(record.materializedBaseDefinitionHashes) !==
        JSON.stringify(
          zenV1SurfaceIds.map((surfaceId) => getZenV1SurfaceContract(surfaceId).definitionHash),
        ) ||
      !Number.isSafeInteger(record.version) ||
      Number(record.version) < 1
    ) {
      throw new Error("invalid");
    }
    return {
      baseVersion: Number(record.baseVersion),
      billingState: PRESENTATION_BILLING_STATE,
      expectedVersion: Number(record.expectedVersion),
      materializedBaseDefinitionHashes: record.materializedBaseDefinitionHashes,
      placements: validateRegisteredSurfacePlacementSubset(
        expectedSurfaceId,
        upgradeLegacyV1SurfacePlacements(expectedSurfaceId, record.placements),
      ),
      surfaceId: expectedSurfaceId,
      version: Number(record.version),
    };
  } catch {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay retry evidence is invalid");
  }
}

async function loadSurfaceOverlayUpdateReplay(
  transaction: TenantTransaction,
  input: {
    readonly base: StoredSurfaceBase;
    readonly context: OperationContext;
    readonly expectedVersion: number;
    readonly eligibleWidgetDefinitionIds: ReadonlySet<string>;
    readonly placements: readonly PresentationWidgetPlacement[];
    readonly subjectId: string;
    readonly surfaceId: ZenV1SurfaceId;
  },
): Promise<UpdatePresentationSurfaceOverlayResponse | undefined> {
  const priorEvidence = await transaction.client.query<{
    actor_principal_id: string;
    evidence_event_id: string;
    new_state: string;
  }>(
    `SELECT actor_principal_id, evidence_event_id, new_state
     FROM evidence_events
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND event_type = $4 AND correlation_id = $5`,
    [
      input.context.tenantId,
      SURFACE_OVERLAY_SUBJECT_TYPE,
      input.subjectId,
      SURFACE_OVERLAY_EVENT_TYPE,
      input.context.correlationId,
    ],
  );
  const replay = priorEvidence.rows[0];
  if (!replay) return undefined;
  const state = parseSurfaceOverlayEvidenceState(replay.new_state, input.surfaceId);
  if (
    replay.actor_principal_id !== input.context.actorPrincipalId ||
    state.expectedVersion !== input.expectedVersion ||
    canonicalPlacements(state.placements) !== canonicalPlacements(input.placements)
  ) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay retry changed its semantics");
  }
  const replayOverlay = await rebaseSurfaceOverlay(transaction, input.surfaceId, input.base, {
    baseVersion: state.baseVersion,
    placements: state.placements,
    version: state.version,
  });
  if (!replayOverlay) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay retry evidence is invalid");
  }
  return {
    ...surfaceLayoutResponse(
      input.surfaceId,
      input.base,
      replayOverlay,
      input.eligibleWidgetDefinitionIds,
    ),
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId: replay.evidence_event_id,
    replayed: true,
  };
}

export async function updateOwnPresentationSurfaceOverlay(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
  untrustedInput: unknown,
): Promise<UpdatePresentationSurfaceOverlayResponse> {
  let parsedInput: UpdatePresentationSurfaceOverlayBody;
  try {
    parsedInput = parseUpdatePresentationSurfaceOverlayBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface overlay is invalid");
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.layouts.write_own",
        `principal:${transaction.context.actorPrincipalId}:surface:${surfaceId}`,
      );
      await assertCurrentOwnPresentationLayoutCapability(
        transaction,
        "platform.presentation.layouts.write_own",
        surfaceId,
      );
      await assertSurfacePersonalizationEnabled(transaction, surfaceId);
      const eligibleWidgetDefinitionIds = await loadEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
        "share",
      );
      if (eligibleWidgetDefinitionIds.size === 0) {
        throw new PlatformError("POLICY_DENIED", "Presentation surface is not currently eligible");
      }
      const bases = await materializeCodeOwnedSurfaceBases(transaction);
      const base = bases.get(surfaceId);
      if (!base) {
        throw new PlatformError("SETTING_INVALID", "Presentation surface base is unavailable");
      }
      const eligiblePlacements = validateEligiblePersonalSurfacePlacements(
        surfaceId,
        parsedInput.placements,
        eligibleWidgetDefinitionIds,
        base.basePlacements,
      );
      const current = await rebaseSurfaceOverlay(
        transaction,
        surfaceId,
        base,
        await loadOwnSurfaceOverlay(transaction, surfaceId),
      );
      const placements = eligiblePlacements;
      const subjectId = surfaceOverlaySubjectId(context, surfaceId);
      const replay = await loadSurfaceOverlayUpdateReplay(transaction, {
        base,
        context,
        eligibleWidgetDefinitionIds,
        expectedVersion: parsedInput.expectedVersion,
        placements,
        subjectId,
        surfaceId,
      });
      if (replay) {
        return replay;
      }

      const currentVersion = current?.version ?? 0;
      if (currentVersion !== parsedInput.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay version has changed", {
          currentVersion,
        });
      }
      const nextVersion = currentVersion + 1;
      const serializedLayout = canonicalPlacements(placements);
      if (current) {
        const updated = await transaction.client.query(
          `UPDATE presentation_surface_overlays
           SET base_version = $4, layout = $5::jsonb, version = $6,
               updated_at = now(), updated_by_principal_id = $2
           WHERE tenant_id = $1 AND principal_id = $2 AND surface_id = $3
             AND version = $7`,
          [
            context.tenantId,
            context.actorPrincipalId,
            surfaceId,
            base.baseVersion,
            serializedLayout,
            nextVersion,
            currentVersion,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay version has changed");
        }
      } else {
        const inserted = await transaction.client.query(
          `INSERT INTO presentation_surface_overlays
             (tenant_id, principal_id, surface_id, base_version, layout, version,
              updated_by_principal_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, 1, $2)
           ON CONFLICT (tenant_id, principal_id, surface_id) DO NOTHING`,
          [
            context.tenantId,
            context.actorPrincipalId,
            surfaceId,
            base.baseVersion,
            serializedLayout,
          ],
        );
        if (inserted.rowCount !== 1) {
          const concurrentReplay = await loadSurfaceOverlayUpdateReplay(transaction, {
            base,
            context,
            eligibleWidgetDefinitionIds,
            expectedVersion: parsedInput.expectedVersion,
            placements,
            subjectId,
            surfaceId,
          });
          if (concurrentReplay) return concurrentReplay;
          throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay version has changed");
        }
      }
      const evidenceState: SurfaceOverlayEvidenceState = {
        baseVersion: base.baseVersion,
        billingState: PRESENTATION_BILLING_STATE,
        expectedVersion: parsedInput.expectedVersion,
        materializedBaseDefinitionHashes: zenV1SurfaceIds.map((candidateSurfaceId) => {
          const materialized = bases.get(candidateSurfaceId);
          if (!materialized) {
            throw new PlatformError("SETTING_INVALID", "Presentation surface base is unavailable");
          }
          return materialized.definitionHash;
        }),
        placements,
        surfaceId,
        version: nextVersion,
      };
      const evidence = await appendEvidence(transaction, {
        eventType: SURFACE_OVERLAY_EVENT_TYPE,
        newState: JSON.stringify(evidenceState),
        priorState: current
          ? JSON.stringify({
              baseVersion: current.baseVersion,
              placements: current.placements,
              version: current.version,
            })
          : null,
        subjectId,
        subjectType: SURFACE_OVERLAY_SUBJECT_TYPE,
      });
      return {
        ...surfaceLayoutResponse(
          surfaceId,
          base,
          {
            baseVersion: base.baseVersion,
            placements,
            version: nextVersion,
          },
          eligibleWidgetDefinitionIds,
        ),
        billingState: PRESENTATION_BILLING_STATE,
        evidenceEventId: evidence.evidenceEventId,
        replayed: evidence.replayed,
      };
    },
    { migrationBarrier: "shared" },
  );
}

type StudioSurfaceBaseAction =
  | "platform.studio.surface_base.draft"
  | "platform.studio.surface_base.publish"
  | "platform.studio.surface_base.read"
  | "platform.studio.surface_base.rollback"
  | "platform.studio.surface_base.validate";

const STUDIO_SURFACE_BASE_ACTIONS = [
  "platform.studio.surface_base.draft",
  "platform.studio.surface_base.publish",
  "platform.studio.surface_base.rollback",
  "platform.studio.surface_base.validate",
] as const satisfies readonly StudioSurfaceBaseAction[];

async function assertCurrentStudioSurfaceBaseCapability(
  transaction: TenantTransaction,
  actionKey: StudioSurfaceBaseAction,
  surfaceId: ZenV1SurfaceId,
): Promise<void> {
  const capability = await transaction.client.query<{ capability_current: boolean }>(
    `SELECT public.esbla_lock_membership_capability($1, $2, $3) AS capability_current`,
    [transaction.context.tenantId, transaction.context.actorPrincipalId, actionKey],
  );
  const decision = evaluatePolicy(
    {
      actionKey,
      input: { capabilityCurrent: capability.rows[0]?.capability_current === true },
      resourceKey: `tenant:${transaction.context.tenantId}:surface:${surfaceId}:base`,
      transaction,
    },
    [
      {
        effect: "allow",
        id: "presentation.current-explicit-capability-may-manage-surface-base",
        matches: (input) => input.capabilityCurrent,
      },
    ],
  );
  assertPolicyAllowed(
    decision,
    transaction,
    actionKey,
    `tenant:${transaction.context.tenantId}:surface:${surfaceId}:base`,
  );
}

async function currentStudioSurfaceBaseActions(transaction: TenantTransaction) {
  const result = await transaction.client.query<{
    action_key: (typeof STUDIO_SURFACE_BASE_ACTIONS)[number];
    capability_current: boolean;
  }>(
    `SELECT action_key,
            public.esbla_lock_membership_capability($1, $2, action_key)
              AS capability_current
     FROM unnest($3::text[]) AS action(action_key)
     ORDER BY action_key`,
    [
      transaction.context.tenantId,
      transaction.context.actorPrincipalId,
      STUDIO_SURFACE_BASE_ACTIONS,
    ],
  );
  const current = new Map(
    result.rows.map(({ action_key, capability_current }) => [action_key, capability_current]),
  );
  return {
    canDraft: current.get("platform.studio.surface_base.draft") === true,
    canPublish: current.get("platform.studio.surface_base.publish") === true,
    canRollback: current.get("platform.studio.surface_base.rollback") === true,
    canValidate: current.get("platform.studio.surface_base.validate") === true,
  };
}

function surfaceBaseSubjectId(context: OperationContext, surfaceId: ZenV1SurfaceId): string {
  return deriveStableUuid("platform.studio.surface-base", context.tenantId, surfaceId);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticRequestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function legacyV1SurfaceDraftRequestHash(
  surfaceId: ZenV1SurfaceId,
  input: UpsertPresentationSurfaceDraftBody,
  placements: readonly PresentationWidgetPlacement[],
): string | undefined {
  if (placements.some(({ widgetDefinitionVersion }) => widgetDefinitionVersion !== 1)) {
    return undefined;
  }
  return semanticRequestHash({
    ...input,
    placements: placements.map(({ widgetDefinitionVersion: _version, ...placement }) => placement),
    surfaceId,
  });
}

interface PresentationMutationReplay {
  readonly evidenceEventId: string;
  readonly response: unknown;
}

async function loadPresentationMutationReplay(
  transaction: TenantTransaction,
  input: {
    readonly acceptedLegacyRequestHashes?: readonly string[];
    readonly eventType: string;
    readonly requestHash: string;
    readonly subjectId: string;
    readonly subjectType: string;
  },
): Promise<PresentationMutationReplay | undefined> {
  const result = await transaction.client.query<{
    actor_principal_id: string;
    evidence_event_id: string;
    new_state: string;
  }>(
    `SELECT actor_principal_id, evidence_event_id, new_state
     FROM evidence_events
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND event_type = $4 AND correlation_id = $5`,
    [
      transaction.context.tenantId,
      input.subjectType,
      input.subjectId,
      input.eventType,
      transaction.context.correlationId,
    ],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  try {
    const state = JSON.parse(row.new_state) as unknown;
    if (
      row.actor_principal_id !== transaction.context.actorPrincipalId ||
      typeof state !== "object" ||
      state === null ||
      Array.isArray(state) ||
      JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(["requestHash", "response"]) ||
      ((state as Record<string, unknown>).requestHash !== input.requestHash &&
        !input.acceptedLegacyRequestHashes?.includes(
          String((state as Record<string, unknown>).requestHash),
        ))
    ) {
      throw new Error("invalid");
    }
    return {
      evidenceEventId: row.evidence_event_id,
      response: (state as Record<string, unknown>).response,
    };
  } catch {
    throw new PlatformError(
      "IDEMPOTENCY_CONFLICT",
      "Presentation mutation retry changed its semantics",
    );
  }
}

function replayState(requestHash: string, response: unknown): string {
  return canonicalJson({ requestHash, response });
}

async function loadSurfaceDraft(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  lock: "none" | "share" | "update" = "none",
): Promise<PresentationSurfaceDraft | undefined> {
  const result = await transaction.client.query<{
    based_on_version: number;
    definition_hash: string;
    layout: unknown;
    version: number;
  }>(
    `SELECT based_on_version, definition_hash, layout, version
     FROM presentation_surface_drafts
     WHERE tenant_id = $1 AND surface_id = $2
     ${lock === "update" ? "FOR UPDATE" : lock === "share" ? "FOR SHARE" : ""}`,
    [transaction.context.tenantId, surfaceId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  try {
    return parsePresentationSurfaceDraft({
      basedOnVersion: row.based_on_version,
      candidateBaseVersion: row.based_on_version + 1,
      definitionHash: row.definition_hash,
      draftVersion: row.version,
      placements: row.layout,
      surfaceId,
    });
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface draft has drifted");
  }
}

async function loadSurfaceHistory(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<readonly PresentationSurfaceBaseVersion[]> {
  const result = await transaction.client.query<{
    based_on_version: number | null;
    base_version: number;
    definition_hash: string;
    layout: unknown;
  }>(
    `SELECT base_version, based_on_version, definition_hash, layout
     FROM presentation_surface_versions
     WHERE tenant_id = $1 AND surface_id = $2
     ORDER BY base_version DESC
     LIMIT 1000`,
    [transaction.context.tenantId, surfaceId],
  );
  try {
    return result.rows.map((row) =>
      parsePresentationSurfaceBaseVersion({
        basedOnVersion: row.based_on_version,
        baseVersion: row.base_version,
        definitionHash: row.definition_hash,
        placements: row.layout,
        surfaceId,
      }),
    );
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface history has drifted");
  }
}

function surfaceBaseVersion(
  surfaceId: ZenV1SurfaceId,
  base: StoredSurfaceBase,
): PresentationSurfaceBaseVersion {
  return {
    basedOnVersion: base.basedOnVersion,
    baseVersion: base.baseVersion,
    definitionHash: base.definitionHash,
    placements: base.basePlacements,
    surfaceId,
  };
}

async function loadMutableSurfaceBase(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  expectedHeadRowVersion: number,
): Promise<StoredSurfaceBase> {
  let base = await loadStoredSurfaceBase(transaction, surfaceId, "update");
  if (base) {
    if (base.headRowVersion !== expectedHeadRowVersion) {
      throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base head has changed", {
        currentHeadRowVersion: base.headRowVersion,
      });
    }
    return base;
  }
  if (expectedHeadRowVersion !== 0) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base head has changed", {
      currentHeadRowVersion: 0,
    });
  }
  await materializeSurfaceBase(transaction, surfaceId);
  base = await loadStoredSurfaceBase(transaction, surfaceId, "update");
  if (!base) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface base is unavailable");
  }
  return base;
}

function parseTenantBasePlacements(
  surfaceId: ZenV1SurfaceId,
  value: unknown,
): readonly PresentationWidgetPlacement[] {
  try {
    return parseExactPresentationSurfacePlacementSet(surfaceId, value);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface base layout is invalid");
  }
}

function assertTenantEligibleSurfacePlacements(
  placements: readonly PresentationWidgetPlacement[],
  eligibleWidgetDefinitionIds: ReadonlySet<string>,
  retainedInstanceIds: ReadonlySet<string> = new Set(),
): void {
  if (
    placements.some(
      ({ instanceId, widgetDefinitionId }) =>
        !retainedInstanceIds.has(instanceId) &&
        !eligibleWidgetDefinitionIds.has(widgetDefinitionId),
    )
  ) {
    throw new PlatformError(
      "POLICY_DENIED",
      "Presentation surface contains an inactive service widget",
    );
  }
}

export async function getTenantPresentationSurfaceBaseWorkspace(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
): Promise<PresentationSurfaceBaseWorkspace> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentStudioSurfaceBaseCapability(
        transaction,
        "platform.studio.surface_base.read",
        surfaceId,
      );
      const actions = await currentStudioSurfaceBaseActions(transaction);
      const stored = await loadStoredSurfaceBase(transaction, surfaceId);
      const current = stored ?? codeDefaultSurfaceBase(surfaceId);
      const eligibleWidgetDefinitionIds = await loadTenantEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
      );
      const draft = (await loadSurfaceDraft(transaction, surfaceId)) ?? null;
      const retainedInstanceIds = new Set(
        [...current.basePlacements, ...(draft?.placements ?? [])].map(
          ({ instanceId }) => instanceId,
        ),
      );
      const history = stored
        ? await loadSurfaceHistory(transaction, surfaceId)
        : [surfaceBaseVersion(surfaceId, current)];
      return {
        actions,
        availablePlacements: eligibleRegisteredSurfacePlacements(
          surfaceId,
          new Set([
            ...eligibleWidgetDefinitionIds,
            ...getZenV1RegisteredSurfacePlacements(surfaceId)
              .filter(({ instanceId }) => retainedInstanceIds.has(instanceId))
              .map(({ widgetDefinitionId }) => widgetDefinitionId),
          ]),
        ),
        currentBase: surfaceBaseVersion(surfaceId, current),
        draft,
        headRowVersion: current.headRowVersion,
        history,
      };
    },
    { migrationBarrier: "shared" },
  );
}

export async function upsertTenantPresentationSurfaceDraft(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
  untrustedInput: unknown,
): Promise<UpsertPresentationSurfaceDraftResponse> {
  let input: UpsertPresentationSurfaceDraftBody;
  try {
    input = parseUpsertPresentationSurfaceDraftBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface draft input is invalid");
  }
  const placements = parseTenantBasePlacements(surfaceId, input.placements);
  const requestHash = semanticRequestHash({ ...input, placements, surfaceId });
  const acceptedLegacyRequestHash = legacyV1SurfaceDraftRequestHash(surfaceId, input, placements);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentStudioSurfaceBaseCapability(
        transaction,
        "platform.studio.surface_base.draft",
        surfaceId,
      );
      const eligibleWidgetDefinitionIds = await loadTenantEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
        "share",
      );
      const subjectId = surfaceBaseSubjectId(context, surfaceId);
      const replay = await loadPresentationMutationReplay(transaction, {
        ...(acceptedLegacyRequestHash
          ? { acceptedLegacyRequestHashes: [acceptedLegacyRequestHash] }
          : {}),
        eventType: SURFACE_BASE_DRAFT_EVENT_TYPE,
        requestHash,
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      if (replay) {
        const replayRecord =
          typeof replay.response === "object" &&
          replay.response !== null &&
          !Array.isArray(replay.response)
            ? (replay.response as Readonly<Record<string, unknown>>)
            : undefined;
        const replayDraft = replayRecord?.draft ?? replay.response;
        const replayHeadRowVersion = replayRecord?.headRowVersion;
        const currentBase =
          Number.isSafeInteger(replayHeadRowVersion) && Number(replayHeadRowVersion) >= 1
            ? undefined
            : await loadStoredSurfaceBase(transaction, surfaceId);
        return parseUpsertPresentationSurfaceDraftResponse({
          billingState: PRESENTATION_BILLING_STATE,
          draft: upgradeLegacyV1SurfacePlacementProperties(surfaceId, replayDraft, ["placements"]),
          evidenceEventId: replay.evidenceEventId,
          headRowVersion:
            Number.isSafeInteger(replayHeadRowVersion) && Number(replayHeadRowVersion) >= 1
              ? replayHeadRowVersion
              : currentBase?.headRowVersion,
          replayed: true,
        });
      }

      const base = await loadMutableSurfaceBase(
        transaction,
        surfaceId,
        input.expectedHeadRowVersion,
      );
      assertTenantEligibleSurfacePlacements(
        placements,
        eligibleWidgetDefinitionIds,
        new Set(base.basePlacements.map(({ instanceId }) => instanceId)),
      );
      const current = await loadSurfaceDraft(transaction, surfaceId, "update");
      const currentVersion = current?.draftVersion ?? 0;
      if (
        currentVersion !== input.expectedDraftVersion ||
        (current !== undefined && current.basedOnVersion !== base.baseVersion)
      ) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base draft has changed", {
          currentDraftVersion: currentVersion,
          currentHeadRowVersion: base.headRowVersion,
        });
      }
      const contract = getZenV1SurfaceContract(surfaceId);
      const nextVersion = currentVersion + 1;
      if (current) {
        const updated = await transaction.client.query(
          `UPDATE presentation_surface_drafts
           SET based_on_version = $3, definition_hash = $4, layout = $5::jsonb,
               version = $6, updated_by_principal_id = $7, updated_at = now()
           WHERE tenant_id = $1 AND surface_id = $2 AND version = $8`,
          [
            context.tenantId,
            surfaceId,
            base.baseVersion,
            contract.definitionHash,
            canonicalPlacements(placements),
            nextVersion,
            context.actorPrincipalId,
            currentVersion,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base draft has changed");
        }
      } else {
        await transaction.client.query(
          `INSERT INTO presentation_surface_drafts
             (tenant_id, surface_id, based_on_version, definition_hash, layout,
              version, updated_by_principal_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6)`,
          [
            context.tenantId,
            surfaceId,
            base.baseVersion,
            contract.definitionHash,
            canonicalPlacements(placements),
            context.actorPrincipalId,
          ],
        );
      }
      const draft = parsePresentationSurfaceDraft({
        basedOnVersion: base.baseVersion,
        candidateBaseVersion: base.baseVersion + 1,
        definitionHash: contract.definitionHash,
        draftVersion: nextVersion,
        placements,
        surfaceId,
      });
      const evidence = await appendEvidence(transaction, {
        eventType: SURFACE_BASE_DRAFT_EVENT_TYPE,
        newState: replayState(requestHash, {
          draft,
          headRowVersion: base.headRowVersion,
        }),
        priorState: current ? canonicalJson(current) : null,
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      return {
        billingState: PRESENTATION_BILLING_STATE,
        draft,
        evidenceEventId: evidence.evidenceEventId,
        headRowVersion: base.headRowVersion,
        replayed: evidence.replayed,
      };
    },
    { migrationBarrier: "shared" },
  );
}

async function loadExactDraftAndHead(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  input: ValidatePresentationSurfaceDraftBody,
  lock: "share" | "update",
): Promise<{ readonly base: StoredSurfaceBase; readonly draft: PresentationSurfaceDraft }> {
  const base = await loadStoredSurfaceBase(transaction, surfaceId, lock);
  const draft = await loadSurfaceDraft(transaction, surfaceId, lock);
  if (
    !base ||
    !draft ||
    base.headRowVersion !== input.expectedHeadRowVersion ||
    draft.draftVersion !== input.expectedDraftVersion ||
    draft.basedOnVersion !== base.baseVersion
  ) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base draft has changed", {
      currentDraftVersion: draft?.draftVersion ?? 0,
      currentHeadRowVersion: base?.headRowVersion ?? 0,
    });
  }
  parseTenantBasePlacements(surfaceId, draft.placements);
  return { base, draft };
}

export async function validateTenantPresentationSurfaceDraft(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
  untrustedInput: unknown,
): Promise<ValidatePresentationSurfaceDraftResponse> {
  let input: ValidatePresentationSurfaceDraftBody;
  try {
    input = parseValidatePresentationSurfaceDraftBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface draft input is invalid");
  }
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentStudioSurfaceBaseCapability(
        transaction,
        "platform.studio.surface_base.validate",
        surfaceId,
      );
      const eligibleWidgetDefinitionIds = await loadTenantEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
        "share",
      );
      const { base, draft } = await loadExactDraftAndHead(transaction, surfaceId, input, "share");
      const retainedInstanceIds = new Set(base.basePlacements.map(({ instanceId }) => instanceId));
      const inactiveServiceWidget = draft.placements.some(
        ({ instanceId, widgetDefinitionId }) =>
          !retainedInstanceIds.has(instanceId) &&
          !eligibleWidgetDefinitionIds.has(widgetDefinitionId),
      );
      return {
        billingState: PRESENTATION_BILLING_STATE,
        diagnostics: inactiveServiceWidget ? ["inactive_service_widget"] : [],
        draftVersion: draft.draftVersion,
        headRowVersion: base.headRowVersion,
        preview: draft.placements,
        valid: !inactiveServiceWidget,
      };
    },
    { migrationBarrier: "shared" },
  );
}

function surfaceBaseMutationResponseValue(
  surfaceId: ZenV1SurfaceId,
  base: PresentationSurfaceBaseVersion,
  headRowVersion: number,
): Omit<PresentationSurfaceBaseMutationResponse, "billingState" | "evidenceEventId" | "replayed"> {
  return { ...base, headRowVersion, surfaceId };
}

function parseReplayBaseMutation(
  replay: PresentationMutationReplay,
  surfaceId: ZenV1SurfaceId,
): PresentationSurfaceBaseMutationResponse {
  return parsePresentationSurfaceBaseMutationResponse({
    ...(upgradeLegacyV1SurfacePlacementProperties(surfaceId, replay.response, [
      "placements",
    ]) as Record<string, unknown>),
    billingState: PRESENTATION_BILLING_STATE,
    evidenceEventId: replay.evidenceEventId,
    replayed: true,
  });
}

export async function publishTenantPresentationSurfaceDraft(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
  untrustedInput: unknown,
): Promise<PresentationSurfaceBaseMutationResponse> {
  let input: PublishPresentationSurfaceDraftBody;
  try {
    input = parseValidatePresentationSurfaceDraftBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface publish input is invalid");
  }
  const requestHash = semanticRequestHash({ ...input, surfaceId });
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentStudioSurfaceBaseCapability(
        transaction,
        "platform.studio.surface_base.publish",
        surfaceId,
      );
      const subjectId = surfaceBaseSubjectId(context, surfaceId);
      const replay = await loadPresentationMutationReplay(transaction, {
        eventType: SURFACE_BASE_PUBLISH_EVENT_TYPE,
        requestHash,
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      if (replay) return parseReplayBaseMutation(replay, surfaceId);

      const eligibleWidgetDefinitionIds = await loadTenantEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
        "share",
      );
      const { base, draft } = await loadExactDraftAndHead(transaction, surfaceId, input, "update");
      assertTenantEligibleSurfacePlacements(
        draft.placements,
        eligibleWidgetDefinitionIds,
        new Set(base.basePlacements.map(({ instanceId }) => instanceId)),
      );
      const nextBaseVersion = base.baseVersion + 1;
      const nextHeadRowVersion = base.headRowVersion + 1;
      await transaction.client.query(
        `INSERT INTO presentation_surface_versions
           (tenant_id, surface_id, base_version, based_on_version, definition_hash,
            layout, published_by_principal_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          context.tenantId,
          surfaceId,
          nextBaseVersion,
          base.baseVersion,
          draft.definitionHash,
          canonicalPlacements(draft.placements),
          context.actorPrincipalId,
        ],
      );
      const advanced = await transaction.client.query(
        `UPDATE presentation_surface_heads
         SET current_base_version = $3, row_version = $4,
             updated_by_principal_id = $5, updated_at = now()
         WHERE tenant_id = $1 AND surface_id = $2
           AND current_base_version = $6 AND row_version = $7`,
        [
          context.tenantId,
          surfaceId,
          nextBaseVersion,
          nextHeadRowVersion,
          context.actorPrincipalId,
          base.baseVersion,
          base.headRowVersion,
        ],
      );
      if (advanced.rowCount !== 1) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base head has changed");
      }
      const removed = await transaction.client.query(
        `DELETE FROM presentation_surface_drafts
         WHERE tenant_id = $1 AND surface_id = $2 AND version = $3`,
        [context.tenantId, surfaceId, draft.draftVersion],
      );
      if (removed.rowCount !== 1) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base draft has changed");
      }
      const version = parsePresentationSurfaceBaseVersion({
        basedOnVersion: base.baseVersion,
        baseVersion: nextBaseVersion,
        definitionHash: draft.definitionHash,
        placements: draft.placements,
        surfaceId,
      });
      const response = surfaceBaseMutationResponseValue(surfaceId, version, nextHeadRowVersion);
      const evidence = await appendEvidence(transaction, {
        eventType: SURFACE_BASE_PUBLISH_EVENT_TYPE,
        newState: replayState(requestHash, response),
        priorState: canonicalJson({ base: surfaceBaseVersion(surfaceId, base), draft }),
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      return {
        ...response,
        billingState: PRESENTATION_BILLING_STATE,
        evidenceEventId: evidence.evidenceEventId,
        replayed: evidence.replayed,
      };
    },
    { migrationBarrier: "shared" },
  );
}

export async function rollbackTenantPresentationSurfaceBase(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
  untrustedInput: unknown,
): Promise<PresentationSurfaceBaseMutationResponse> {
  let input: RollbackPresentationSurfaceBaseBody;
  try {
    input = parseRollbackPresentationSurfaceBaseBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface rollback input is invalid");
  }
  const requestHash = semanticRequestHash({ ...input, surfaceId });
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentStudioSurfaceBaseCapability(
        transaction,
        "platform.studio.surface_base.rollback",
        surfaceId,
      );
      const subjectId = surfaceBaseSubjectId(context, surfaceId);
      const replay = await loadPresentationMutationReplay(transaction, {
        eventType: SURFACE_BASE_ROLLBACK_EVENT_TYPE,
        requestHash,
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      if (replay) return parseReplayBaseMutation(replay, surfaceId);

      const eligibleWidgetDefinitionIds = await loadTenantEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
        "share",
      );
      const base = await loadStoredSurfaceBase(transaction, surfaceId, "update");
      if (!base || base.headRowVersion !== input.expectedHeadRowVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base head has changed", {
          currentHeadRowVersion: base?.headRowVersion ?? 0,
        });
      }
      if (input.sourceBaseVersion >= base.baseVersion) {
        throw new PlatformError(
          "IDEMPOTENCY_CONFLICT",
          "Surface rollback source is not historical",
        );
      }
      const draft = await loadSurfaceDraft(transaction, surfaceId, "share");
      if (draft) {
        throw new PlatformError(
          "IDEMPOTENCY_CONFLICT",
          "Surface rollback requires the active draft to be resolved",
        );
      }
      const source = await loadStoredSurfaceVersion(
        transaction,
        surfaceId,
        input.sourceBaseVersion,
      );
      if (!source) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface rollback source is unavailable");
      }
      parseTenantBasePlacements(surfaceId, source.placements);
      assertTenantEligibleSurfacePlacements(
        source.placements,
        eligibleWidgetDefinitionIds,
        new Set(base.basePlacements.map(({ instanceId }) => instanceId)),
      );
      const nextBaseVersion = base.baseVersion + 1;
      const nextHeadRowVersion = base.headRowVersion + 1;
      await transaction.client.query(
        `INSERT INTO presentation_surface_versions
           (tenant_id, surface_id, base_version, based_on_version, definition_hash,
            layout, published_by_principal_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          context.tenantId,
          surfaceId,
          nextBaseVersion,
          source.baseVersion,
          source.definitionHash,
          canonicalPlacements(source.placements),
          context.actorPrincipalId,
        ],
      );
      const advanced = await transaction.client.query(
        `UPDATE presentation_surface_heads
         SET current_base_version = $3, row_version = $4,
             updated_by_principal_id = $5, updated_at = now()
         WHERE tenant_id = $1 AND surface_id = $2
           AND current_base_version = $6 AND row_version = $7`,
        [
          context.tenantId,
          surfaceId,
          nextBaseVersion,
          nextHeadRowVersion,
          context.actorPrincipalId,
          base.baseVersion,
          base.headRowVersion,
        ],
      );
      if (advanced.rowCount !== 1) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface base head has changed");
      }
      const version = parsePresentationSurfaceBaseVersion({
        basedOnVersion: source.baseVersion,
        baseVersion: nextBaseVersion,
        definitionHash: source.definitionHash,
        placements: source.placements,
        surfaceId,
      });
      const response = surfaceBaseMutationResponseValue(surfaceId, version, nextHeadRowVersion);
      const evidence = await appendEvidence(transaction, {
        eventType: SURFACE_BASE_ROLLBACK_EVENT_TYPE,
        newState: replayState(requestHash, response),
        priorState: canonicalJson({ base: surfaceBaseVersion(surfaceId, base) }),
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      return {
        ...response,
        billingState: PRESENTATION_BILLING_STATE,
        evidenceEventId: evidence.evidenceEventId,
        replayed: evidence.replayed,
      };
    },
    { migrationBarrier: "shared" },
  );
}

export async function resetOwnPresentationSurfaceOverlay(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
  untrustedInput: unknown,
): Promise<ResetPresentationSurfaceOverlayResponse> {
  let input: ResetPresentationSurfaceOverlayBody;
  try {
    input = parseResetPresentationSurfaceOverlayBody(untrustedInput);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface reset input is invalid");
  }
  const requestHash = semanticRequestHash({ ...input, surfaceId });
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.layouts.reset_own",
        `principal:${transaction.context.actorPrincipalId}:surface:${surfaceId}`,
      );
      await assertCurrentOwnPresentationLayoutCapability(
        transaction,
        "platform.presentation.layouts.reset_own",
        surfaceId,
      );
      await assertSurfacePersonalizationEnabled(transaction, surfaceId);
      const eligibleWidgetDefinitionIds = await loadEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
        "share",
      );
      if (eligibleWidgetDefinitionIds.size === 0) {
        throw new PlatformError("POLICY_DENIED", "Presentation surface is not currently eligible");
      }
      const base =
        (await loadStoredSurfaceBase(transaction, surfaceId)) ?? codeDefaultSurfaceBase(surfaceId);
      const subjectId = surfaceOverlaySubjectId(context, surfaceId);
      const replay = await loadPresentationMutationReplay(transaction, {
        eventType: SURFACE_OVERLAY_RESET_EVENT_TYPE,
        requestHash,
        subjectId,
        subjectType: SURFACE_OVERLAY_SUBJECT_TYPE,
      });
      if (replay) {
        return parseResetPresentationSurfaceOverlayResponse({
          ...(upgradeLegacyV1SurfacePlacementProperties(surfaceId, replay.response, [
            "basePlacements",
            "effectivePlacements",
          ]) as Record<string, unknown>),
          billingState: PRESENTATION_BILLING_STATE,
          evidenceEventId: replay.evidenceEventId,
          replayed: true,
        });
      }
      const current = await loadOwnSurfaceOverlay(transaction, surfaceId);
      if (!current || current.version !== input.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay version has changed", {
          currentVersion: current?.version ?? 0,
        });
      }
      const removed = await transaction.client.query(
        `DELETE FROM presentation_surface_overlays
         WHERE tenant_id = $1 AND principal_id = $2 AND surface_id = $3 AND version = $4`,
        [context.tenantId, context.actorPrincipalId, surfaceId, input.expectedVersion],
      );
      if (removed.rowCount !== 1) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay version has changed");
      }
      const response = surfaceLayoutResponse(
        surfaceId,
        base,
        undefined,
        eligibleWidgetDefinitionIds,
      );
      const evidence = await appendEvidence(transaction, {
        eventType: SURFACE_OVERLAY_RESET_EVENT_TYPE,
        newState: replayState(requestHash, response),
        priorState: canonicalJson(current),
        subjectId,
        subjectType: SURFACE_OVERLAY_SUBJECT_TYPE,
      });
      return {
        ...response,
        billingState: PRESENTATION_BILLING_STATE,
        evidenceEventId: evidence.evidenceEventId,
        replayed: evidence.replayed,
      };
    },
    { migrationBarrier: "shared" },
  );
}
