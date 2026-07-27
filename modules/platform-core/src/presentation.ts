import { createHash } from "node:crypto";
import type {
  PresentationPalette,
  PresentationPreferenceSource,
  PresentationPreferences,
  PresentationServiceGroupDiscovery,
  PresentationSurfaceDefinition,
  PresentationSurfaceLayout,
  PresentationWidgetDefinition,
  PresentationWidgetPlacement,
  UpdatePresentationPreferencesBody,
  UpdatePresentationPreferencesResponse,
  UpdatePresentationSurfaceOverlayBody,
  UpdatePresentationSurfaceOverlayResponse,
  ZenV1SurfaceContract,
  ZenV1SurfaceId,
} from "@esbla/contracts";
import {
  canonicalizePresentationSettingDefinition,
  canonicalizePresentationSurfaceContract,
  canonicalizePresentationSurfaceDefinition,
  canonicalizePresentationWidgetDefinition,
  getPresentationWidgetDefinition,
  getZenV1SurfaceContract,
  PRESENTATION_BILLING_STATE,
  PRESENTATION_SERVICE_GROUP_DEFINITIONS,
  PRESENTATION_SETTING_DEFINITIONS,
  PRESENTATION_SURFACE_DEFINITIONS,
  PRESENTATION_WIDGET_DEFINITIONS,
  parsePresentationWidgetDefinition,
  parseUpdatePresentationPreferencesBody,
  parseUpdatePresentationSurfaceOverlayBody,
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
  type PresentationSettingCandidate,
  resolvePresentationSetting,
} from "./presentation-setting.js";
import { appendEvidence, deriveStableUuid } from "./proof.js";

const APPEARANCE_PALETTE_KEY = "appearance.palette.v1";
const APPEARANCE_HIGH_CONTRAST_KEY = "appearance.high_contrast.v1";
const APPEARANCE_SETTING_KEYS = [APPEARANCE_PALETTE_KEY, APPEARANCE_HIGH_CONTRAST_KEY] as const;
const PREFERENCE_EVENT_TYPE = "platform.presentation.preferences.updated";
const PREFERENCE_SUBJECT_TYPE = "platform_presentation_preferences";
const SURFACE_OVERLAY_EVENT_TYPE = "platform.presentation.surface_overlay.updated";
const SURFACE_OVERLAY_SUBJECT_TYPE = "platform_presentation_surface_overlay";

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
  readonly highContrast: boolean;
  readonly palette: PresentationPalette;
}

export interface PresentationPreferenceResolutionInput {
  readonly codeDefault: AppearanceValues;
  readonly tenantDefault?: AppearanceValues;
  readonly userOverride?: AppearanceValues;
}

interface StoredPreferenceLayer {
  readonly highContrast: boolean;
  readonly palette: PresentationPalette;
  readonly version: number;
}

function invalidStoredPreference(): PlatformError {
  return new PlatformError("SETTING_INVALID", "Presentation preference storage is invalid");
}

function parseStoredPreferenceLayer(
  rows: readonly {
    readonly setting_key: string;
    readonly value: unknown;
    readonly version: unknown;
  }[],
): StoredPreferenceLayer | undefined {
  if (rows.length === 0) return undefined;
  if (rows.length !== APPEARANCE_SETTING_KEYS.length) throw invalidStoredPreference();
  const byKey = new Map(rows.map((row) => [row.setting_key, row]));
  const palette = byKey.get(APPEARANCE_PALETTE_KEY);
  const highContrast = byKey.get(APPEARANCE_HIGH_CONTRAST_KEY);
  if (
    !palette ||
    !highContrast ||
    (palette.value !== "light" && palette.value !== "dark") ||
    typeof highContrast.value !== "boolean" ||
    !Number.isSafeInteger(palette.version) ||
    Number(palette.version) < 1 ||
    palette.version !== highContrast.version
  ) {
    throw invalidStoredPreference();
  }
  return {
    highContrast: highContrast.value,
    palette: palette.value,
    version: Number(palette.version),
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
): AppearanceValues & { readonly source: PresentationPreferenceSource } {
  if (input.codeDefault.palette !== "light" || input.codeDefault.highContrast !== false) {
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
  const palette = resolvePresentationSetting("appearance.palette.v1", candidates("palette"));
  const highContrast = resolvePresentationSetting(
    "appearance.high_contrast.v1",
    candidates("highContrast"),
  );
  if (
    (palette.value !== "light" && palette.value !== "dark") ||
    typeof highContrast.value !== "boolean" ||
    palette.sourceScope !== highContrast.sourceScope
  ) {
    throw invalidStoredPreference();
  }
  const sourceByScope = {
    product_default: "code_default",
    tenant_global: "tenant_default",
    user_global: "user_override",
  } as const;
  const source =
    palette.sourceScope === "product_default" ||
    palette.sourceScope === "tenant_global" ||
    palette.sourceScope === "user_global"
      ? sourceByScope[palette.sourceScope]
      : undefined;
  if (!source) throw invalidStoredPreference();
  return {
    highContrast: highContrast.value,
    palette: palette.value,
    source,
  };
}

function preferenceSubjectId(context: OperationContext): string {
  return deriveStableUuid(
    "platform.presentation.preferences",
    context.tenantId,
    context.actorPrincipalId,
  );
}

function assertOwnPresentationPolicy(
  transaction: TenantTransaction,
  actionKey:
    | "platform.presentation.layouts.read_own"
    | "platform.presentation.layouts.write_own"
    | "platform.presentation.preferences.read_own"
    | "platform.presentation.preferences.write_own",
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
): Promise<StoredPreferenceLayer | undefined> {
  const result = await transaction.client.query<{
    setting_key: string;
    value: unknown;
    version: number;
  }>(
    `SELECT setting_key, value, version
     FROM presentation_setting_values
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND setting_key = ANY($4::text[])
     ORDER BY setting_key`,
    [transaction.context.tenantId, subjectType, subjectId, APPEARANCE_SETTING_KEYS],
  );
  return parseStoredPreferenceLayer(result.rows);
}

async function loadPreferencesInTransaction(
  transaction: TenantTransaction,
): Promise<PresentationPreferences> {
  const [tenantDefault, userOverride] = await Promise.all([
    loadScopedPreference(transaction, "tenant_default", transaction.context.tenantId),
    loadScopedPreference(transaction, "user_override", transaction.context.actorPrincipalId),
  ]);
  const resolved = resolvePresentationPreferences({
    codeDefault: { highContrast: false, palette: "light" },
    ...(tenantDefault ? { tenantDefault } : {}),
    ...(userOverride ? { userOverride } : {}),
  });
  return {
    ...resolved,
    version: userOverride?.version ?? 0,
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
            services.flatMap(({ anyReadCapabilityIds }) => anyReadCapabilityIds),
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
      const active = new Set(activations.rows.map(({ service_key }) => service_key));
      const authorized = new Set(capabilities.rows.map(({ capability_id }) => capability_id));
      return {
        serviceGroupIds: PRESENTATION_SERVICE_GROUP_DEFINITIONS.filter(({ services }) =>
          services.some(
            ({ activationServiceKey, anyReadCapabilityIds }) =>
              active.has(activationServiceKey) &&
              anyReadCapabilityIds.some((capabilityId) => authorized.has(capabilityId)),
          ),
        ).map(({ serviceGroupId }) => serviceGroupId),
      };
    },
    { migrationBarrier: "shared" },
  );
}

function parseEvidenceState(value: string): {
  readonly billingState: typeof PRESENTATION_BILLING_STATE;
  readonly expectedVersion: number;
  readonly highContrast: boolean;
  readonly palette: PresentationPalette;
  readonly version: number;
} {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !==
        JSON.stringify(
          ["billingState", "expectedVersion", "highContrast", "palette", "version"].sort(),
        )
    ) {
      throw new Error("invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.billingState !== PRESENTATION_BILLING_STATE ||
      !Number.isSafeInteger(record.expectedVersion) ||
      Number(record.expectedVersion) < 0 ||
      typeof record.highContrast !== "boolean" ||
      (record.palette !== "light" && record.palette !== "dark") ||
      !Number.isSafeInteger(record.version) ||
      Number(record.version) < 1
    ) {
      throw new Error("invalid");
    }
    return {
      billingState: PRESENTATION_BILLING_STATE,
      expectedVersion: Number(record.expectedVersion),
      highContrast: record.highContrast,
      palette: record.palette,
      version: Number(record.version),
    };
  } catch {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference retry evidence is invalid");
  }
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
          context.tenantId,
          PREFERENCE_SUBJECT_TYPE,
          subjectId,
          PREFERENCE_EVENT_TYPE,
          context.correlationId,
        ],
      );
      const replay = priorEvidence.rows[0];
      if (replay) {
        const state = parseEvidenceState(replay.new_state);
        if (
          replay.actor_principal_id !== context.actorPrincipalId ||
          state.expectedVersion !== input.expectedVersion ||
          state.highContrast !== input.highContrast ||
          state.palette !== input.palette
        ) {
          throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference retry changed its semantics");
        }
        return {
          billingState: PRESENTATION_BILLING_STATE,
          evidenceEventId: replay.evidence_event_id,
          highContrast: state.highContrast,
          palette: state.palette,
          replayed: true,
          source: "user_override",
          version: state.version,
        };
      }

      const current = await loadScopedPreference(
        transaction,
        "user_override",
        context.actorPrincipalId,
      );
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== input.expectedVersion) {
        throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference version has changed", {
          currentVersion,
        });
      }
      const nextVersion = currentVersion + 1;
      const serializedPalette = JSON.stringify(input.palette);
      const serializedHighContrast = JSON.stringify(input.highContrast);
      if (current) {
        const updatedPalette = await transaction.client.query(
          `UPDATE presentation_setting_values
           SET value = $5::jsonb, version = $6, updated_at = now(),
               updated_by_principal_id = $3
           WHERE tenant_id = $1 AND subject_type = 'user_override'
             AND subject_id = $2 AND updated_by_principal_id IS NOT NULL
             AND setting_key = $4 AND version = $7`,
          [
            context.tenantId,
            context.actorPrincipalId,
            context.actorPrincipalId,
            APPEARANCE_PALETTE_KEY,
            serializedPalette,
            nextVersion,
            currentVersion,
          ],
        );
        const updatedHighContrast = await transaction.client.query(
          `UPDATE presentation_setting_values
           SET value = $5::jsonb, version = $6, updated_at = now(),
               updated_by_principal_id = $3
           WHERE tenant_id = $1 AND subject_type = 'user_override'
             AND subject_id = $2 AND updated_by_principal_id IS NOT NULL
             AND setting_key = $4 AND version = $7`,
          [
            context.tenantId,
            context.actorPrincipalId,
            context.actorPrincipalId,
            APPEARANCE_HIGH_CONTRAST_KEY,
            serializedHighContrast,
            nextVersion,
            currentVersion,
          ],
        );
        if (updatedPalette.rowCount !== 1 || updatedHighContrast.rowCount !== 1) {
          throw new PlatformError("IDEMPOTENCY_CONFLICT", "Preference version has changed");
        }
      } else {
        await transaction.client.query(
          `INSERT INTO presentation_setting_values
             (tenant_id, subject_type, subject_id, setting_key, value, version,
              updated_by_principal_id)
           VALUES ($1, 'user_override', $2, $3, $5::jsonb, 1, $2),
                  ($1, 'user_override', $2, $4, $6::jsonb, 1, $2)`,
          [
            context.tenantId,
            context.actorPrincipalId,
            APPEARANCE_PALETTE_KEY,
            APPEARANCE_HIGH_CONTRAST_KEY,
            serializedPalette,
            serializedHighContrast,
          ],
        );
      }

      const newState = JSON.stringify({
        billingState: PRESENTATION_BILLING_STATE,
        expectedVersion: input.expectedVersion,
        highContrast: input.highContrast,
        palette: input.palette,
        version: nextVersion,
      });
      const priorState = current
        ? JSON.stringify({
            highContrast: current.highContrast,
            palette: current.palette,
            version: current.version,
          })
        : null;
      const evidence = await appendEvidence(transaction, {
        eventType: PREFERENCE_EVENT_TYPE,
        newState,
        priorState,
        subjectId,
        subjectType: PREFERENCE_SUBJECT_TYPE,
      });
      return {
        billingState: PRESENTATION_BILLING_STATE,
        evidenceEventId: evidence.evidenceEventId,
        highContrast: input.highContrast,
        palette: input.palette,
        replayed: evidence.replayed,
        source: "user_override",
        version: nextVersion,
      };
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
    })),
  );
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
  const contract = getZenV1SurfaceContract(surfaceId);
  const placements = parseSurfacePlacements(untrustedPlacements);
  if (placements.length !== contract.basePlacements.length) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface instance set is invalid");
  }
  const expected = new Map(
    contract.basePlacements.map((placement) => [
      placement.instanceId,
      placement.widgetDefinitionId,
    ]),
  );
  for (const placement of placements) {
    if (expected.get(placement.instanceId) !== placement.widgetDefinitionId) {
      throw new PlatformError(
        "SETTING_INVALID",
        "Presentation surface registry binding is invalid",
      );
    }
  }
  for (let left = 0; left < placements.length; left += 1) {
    for (let right = left + 1; right < placements.length; right += 1) {
      const leftPlacement = placements[left];
      const rightPlacement = placements[right];
      if (leftPlacement && rightPlacement && rectanglesOverlap(leftPlacement, rightPlacement)) {
        throw new PlatformError("SETTING_INVALID", "Presentation surface widgets overlap");
      }
    }
  }
  return placements;
}

interface StoredSurfaceBase {
  readonly basePlacements: readonly PresentationWidgetPlacement[];
  readonly baseVersion: number;
  readonly definitionHash: string;
}

interface StoredSurfaceOverlay {
  readonly baseVersion: number;
  readonly placements: readonly PresentationWidgetPlacement[];
  readonly version: number;
}

function codeDefaultSurfaceBase(surfaceId: ZenV1SurfaceId): StoredSurfaceBase {
  const contract = getZenV1SurfaceContract(surfaceId);
  return {
    basePlacements: contract.basePlacements,
    baseVersion: contract.baseVersion,
    definitionHash: contract.definitionHash,
  };
}

async function loadStoredSurfaceBase(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<StoredSurfaceBase | undefined> {
  const contract = getZenV1SurfaceContract(surfaceId);
  const serializedBase = canonicalPlacements(contract.basePlacements);
  const result = await transaction.client.query<{
    base_version: number;
    definition_hash: string;
    layout: unknown;
  }>(
    `SELECT v.base_version, v.definition_hash, v.layout
     FROM presentation_surface_heads AS h
     JOIN presentation_surface_versions AS v
       ON v.tenant_id = h.tenant_id
      AND v.surface_id = h.surface_id
      AND v.base_version = h.current_base_version
     WHERE h.tenant_id = $1 AND h.surface_id = $2`,
    [transaction.context.tenantId, surfaceId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const basePlacements = validatePersonalSurfacePlacements(surfaceId, row.layout);
  if (
    row.base_version !== contract.baseVersion ||
    row.definition_hash !== contract.definitionHash ||
    canonicalPlacements(basePlacements) !== serializedBase
  ) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface base has drifted");
  }
  return {
    basePlacements,
    baseVersion: row.base_version,
    definitionHash: row.definition_hash,
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
       (tenant_id, surface_id, base_version, definition_hash, layout,
        published_by_principal_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
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
    placements: validatePersonalSurfacePlacements(surfaceId, row.layout),
    version: row.version,
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
  const filterEligible = (placements: readonly PresentationWidgetPlacement[]) =>
    eligibleWidgetDefinitionIds
      ? placements.filter(({ widgetDefinitionId }) =>
          eligibleWidgetDefinitionIds.has(widgetDefinitionId),
        )
      : placements;
  return {
    baseDefinitionHash: base.definitionHash,
    basePlacements: filterEligible(base.basePlacements),
    baseVersion: base.baseVersion,
    effectivePlacements: filterEligible(overlay?.placements ?? base.basePlacements),
    overlayVersion: overlay?.version ?? 0,
    source: overlay ? "user_overlay" : "code_default",
    surfaceId,
  };
}

async function loadEligibleWidgetDefinitionIds(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
): Promise<ReadonlySet<string>> {
  const definitionIds = [
    ...new Set(
      getZenV1SurfaceContract(surfaceId).basePlacements.map(
        ({ widgetDefinitionId }) => widgetDefinitionId,
      ),
    ),
  ];
  const eligible = new Set<string>();
  for (const definitionId of definitionIds) {
    const definition = getPresentationWidgetDefinition(definitionId);
    const authority = await transaction.client.query<{
      activation_active: boolean;
      capability_count: number;
    }>(
      `SELECT
         EXISTS (
           SELECT 1
           FROM service_activations
           WHERE tenant_id = $1 AND service_key = $2 AND state = 'active'
         ) AS activation_active,
         (
           SELECT count(*)::integer
           FROM membership_capabilities
           WHERE tenant_id = $1 AND principal_id = $3
             AND capability_id = ANY($4::text[])
         ) AS capability_count`,
      [
        transaction.context.tenantId,
        definition.activationServiceKey,
        transaction.context.actorPrincipalId,
        definition.requiredCapabilityIds,
      ],
    );
    const row = authority.rows[0];
    if (
      row?.activation_active === true &&
      row.capability_count === definition.requiredCapabilityIds.length
    ) {
      eligible.add(definitionId);
    }
  }
  return eligible;
}

export async function getOwnPresentationSurfaceLayout(
  pool: Pool,
  context: OperationContext,
  surfaceId: ZenV1SurfaceId,
): Promise<PresentationSurfaceLayout> {
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.layouts.read_own",
        `principal:${transaction.context.actorPrincipalId}:surface:${surfaceId}`,
      );
      const base =
        (await loadStoredSurfaceBase(transaction, surfaceId)) ?? codeDefaultSurfaceBase(surfaceId);
      const overlay = await loadOwnSurfaceOverlay(transaction, surfaceId);
      const eligibleWidgetDefinitionIds = await loadEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
      );
      if (surfaceId === "surface.hr.mission-control" && eligibleWidgetDefinitionIds.size === 0) {
        throw new PlatformError("POLICY_DENIED", "Presentation surface is not currently eligible");
      }
      return surfaceLayoutResponse(surfaceId, base, overlay, eligibleWidgetDefinitionIds);
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
      placements: validatePersonalSurfacePlacements(expectedSurfaceId, record.placements),
      surfaceId: expectedSurfaceId,
      version: Number(record.version),
    };
  } catch {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Surface overlay retry evidence is invalid");
  }
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
  const placements = validatePersonalSurfacePlacements(surfaceId, parsedInput.placements);
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      assertOwnPresentationPolicy(
        transaction,
        "platform.presentation.layouts.write_own",
        `principal:${transaction.context.actorPrincipalId}:surface:${surfaceId}`,
      );
      const eligibleWidgetDefinitionIds = await loadEligibleWidgetDefinitionIds(
        transaction,
        surfaceId,
      );
      if (
        eligibleWidgetDefinitionIds.size === 0 ||
        placements.some(
          ({ widgetDefinitionId }) => !eligibleWidgetDefinitionIds.has(widgetDefinitionId),
        )
      ) {
        throw new PlatformError("POLICY_DENIED", "Presentation surface is not currently eligible");
      }
      const bases = await materializeCodeOwnedSurfaceBases(transaction);
      const base = bases.get(surfaceId);
      if (!base) {
        throw new PlatformError("SETTING_INVALID", "Presentation surface base is unavailable");
      }
      const subjectId = surfaceOverlaySubjectId(context, surfaceId);
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
          context.tenantId,
          SURFACE_OVERLAY_SUBJECT_TYPE,
          subjectId,
          SURFACE_OVERLAY_EVENT_TYPE,
          context.correlationId,
        ],
      );
      const replay = priorEvidence.rows[0];
      if (replay) {
        const state = parseSurfaceOverlayEvidenceState(replay.new_state, surfaceId);
        if (
          replay.actor_principal_id !== context.actorPrincipalId ||
          state.expectedVersion !== parsedInput.expectedVersion ||
          canonicalPlacements(state.placements) !== canonicalPlacements(placements)
        ) {
          throw new PlatformError(
            "IDEMPOTENCY_CONFLICT",
            "Surface overlay retry changed its semantics",
          );
        }
        return {
          ...surfaceLayoutResponse(surfaceId, base, {
            baseVersion: state.baseVersion,
            placements: state.placements,
            version: state.version,
          }),
          billingState: PRESENTATION_BILLING_STATE,
          evidenceEventId: replay.evidence_event_id,
          replayed: true,
        };
      }

      const current = await loadOwnSurfaceOverlay(transaction, surfaceId);
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
        await transaction.client.query(
          `INSERT INTO presentation_surface_overlays
             (tenant_id, principal_id, surface_id, base_version, layout, version,
              updated_by_principal_id)
           VALUES ($1, $2, $3, $4, $5::jsonb, 1, $2)`,
          [
            context.tenantId,
            context.actorPrincipalId,
            surfaceId,
            base.baseVersion,
            serializedLayout,
          ],
        );
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
        ...surfaceLayoutResponse(surfaceId, base, {
          baseVersion: base.baseVersion,
          placements,
          version: nextVersion,
        }),
        billingState: PRESENTATION_BILLING_STATE,
        evidenceEventId: evidence.evidenceEventId,
        replayed: evidence.replayed,
      };
    },
    { migrationBarrier: "shared" },
  );
}
