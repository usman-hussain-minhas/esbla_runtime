import { createHash } from "node:crypto";
import type {
  PresentationPalette,
  PresentationPreferenceSource,
  PresentationPreferences,
  PresentationServiceGroupDiscovery,
  PresentationSurfaceBaseMutationResponse,
  PresentationSurfaceBaseVersion,
  PresentationSurfaceBaseWorkspace,
  PresentationSurfaceDefinition,
  PresentationSurfaceDraft,
  PresentationSurfaceLayout,
  PresentationWidgetDefinition,
  PresentationWidgetPlacement,
  PublishPresentationSurfaceDraftBody,
  ResetPresentationSurfaceOverlayBody,
  ResetPresentationSurfaceOverlayResponse,
  RollbackPresentationSurfaceBaseBody,
  UpdatePresentationPreferencesBody,
  UpdatePresentationPreferencesResponse,
  UpdatePresentationSurfaceOverlayBody,
  UpdatePresentationSurfaceOverlayResponse,
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
  getPresentationWidgetDefinition,
  getZenV1SurfaceContract,
  PRESENTATION_BILLING_STATE,
  PRESENTATION_SERVICE_GROUP_DEFINITIONS,
  PRESENTATION_SETTING_DEFINITIONS,
  PRESENTATION_SURFACE_DEFINITIONS,
  PRESENTATION_WIDGET_DEFINITIONS,
  parseExactPresentationSurfacePlacementSet,
  parsePresentationSurfaceBaseMutationResponse,
  parsePresentationSurfaceBaseVersion,
  parsePresentationSurfaceDraft,
  parsePresentationWidgetDefinition,
  parseResetPresentationSurfaceOverlayBody,
  parseResetPresentationSurfaceOverlayResponse,
  parseRollbackPresentationSurfaceBaseBody,
  parseUpdatePresentationPreferencesBody,
  parseUpdatePresentationSurfaceOverlayBody,
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
const SURFACE_OVERLAY_RESET_EVENT_TYPE = "platform.presentation.surface_overlay.reset";
const SURFACE_OVERLAY_SUBJECT_TYPE = "platform_presentation_surface_overlay";
const SURFACE_BASE_DRAFT_EVENT_TYPE = "platform.studio.surface_base.draft.updated";
const SURFACE_BASE_PUBLISH_EVENT_TYPE = "platform.studio.surface_base.published";
const SURFACE_BASE_ROLLBACK_EVENT_TYPE = "platform.studio.surface_base.rolled_back";
const SURFACE_BASE_SUBJECT_TYPE = "platform_presentation_surface_base";

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
    | "platform.presentation.layouts.reset_own"
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
    placements: validatePersonalSurfacePlacements(surfaceId, row.layout),
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
  const personalByInstance = new Map(
    overlay.placements.map((placement) => [placement.instanceId, placement]),
  );
  if (
    historicalByInstance.size !== base.basePlacements.length ||
    personalByInstance.size !== base.basePlacements.length
  ) {
    throw new PlatformError("SETTING_INVALID", "Presentation surface overlay rebase conflicted", {
      conflict: "instance_set_changed",
    });
  }
  const rebased = base.basePlacements.map((current) => {
    const historicalPlacement = historicalByInstance.get(current.instanceId);
    const personal = personalByInstance.get(current.instanceId);
    if (
      !historicalPlacement ||
      !personal ||
      historicalPlacement.widgetDefinitionId !== current.widgetDefinitionId ||
      personal.widgetDefinitionId !== current.widgetDefinitionId
    ) {
      throw new PlatformError("SETTING_INVALID", "Presentation surface overlay rebase conflicted", {
        conflict: "instance_binding_changed",
      });
    }
    return rebasePlacement(historicalPlacement, current, personal);
  });
  let placements: readonly PresentationWidgetPlacement[];
  try {
    placements = parseExactPresentationSurfacePlacementSet(surfaceId, rebased);
  } catch {
    throw new PlatformError("SETTING_INVALID", "Presentation surface overlay rebase conflicted", {
      conflict: "geometry_invalid",
    });
  }
  return { baseVersion: base.baseVersion, placements, version: overlay.version };
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
  return {
    baseDefinitionHash: base.definitionHash,
    basePlacements: filterEligible(base.basePlacements),
    baseVersion: base.baseVersion,
    effectivePlacements: filterEligible(overlay?.placements ?? base.basePlacements),
    overlayVersion: overlay?.version ?? 0,
    source: overlay ? "user_overlay" : codeDefault ? "code_default" : "tenant_base",
    surfaceId,
  };
}

async function loadEligibleWidgetDefinitionIds(
  transaction: TenantTransaction,
  surfaceId: ZenV1SurfaceId,
  authorityLock: "none" | "share" = "none",
): Promise<ReadonlySet<string>> {
  const definitions = [
    ...new Set(
      getZenV1SurfaceContract(surfaceId).basePlacements.map(
        ({ widgetDefinitionId }) => widgetDefinitionId,
      ),
    ),
  ]
    .map((definitionId) => getPresentationWidgetDefinition(definitionId))
    .sort((left, right) => left.id.localeCompare(right.id));
  const serviceKeys = [
    ...new Set(definitions.map(({ activationServiceKey }) => activationServiceKey)),
  ].sort();
  const capabilityIds = [
    ...new Set(definitions.flatMap(({ requiredCapabilityIds }) => requiredCapabilityIds)),
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
    if (
      activeServiceKeys.has(definition.activationServiceKey) &&
      definition.requiredCapabilityIds.every((capabilityId) =>
        currentCapabilityIds.has(capabilityId),
      )
    ) {
      eligible.add(definition.id);
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
      const overlay = await rebaseSurfaceOverlay(
        transaction,
        surfaceId,
        base,
        await loadOwnSurfaceOverlay(transaction, surfaceId),
      );
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

async function loadSurfaceOverlayUpdateReplay(
  transaction: TenantTransaction,
  input: {
    readonly base: StoredSurfaceBase;
    readonly context: OperationContext;
    readonly expectedVersion: number;
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
    ...surfaceLayoutResponse(input.surfaceId, input.base, replayOverlay),
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
        "share",
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
      const replay = await loadSurfaceOverlayUpdateReplay(transaction, {
        base,
        context,
        expectedVersion: parsedInput.expectedVersion,
        placements,
        subjectId,
        surfaceId,
      });
      if (replay) {
        return replay;
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

type StudioSurfaceBaseAction =
  | "platform.studio.surface_base.draft"
  | "platform.studio.surface_base.publish"
  | "platform.studio.surface_base.read"
  | "platform.studio.surface_base.rollback"
  | "platform.studio.surface_base.validate";

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

interface PresentationMutationReplay {
  readonly evidenceEventId: string;
  readonly response: unknown;
}

async function loadPresentationMutationReplay(
  transaction: TenantTransaction,
  input: {
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
      (state as Record<string, unknown>).requestHash !== input.requestHash
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
      const stored = await loadStoredSurfaceBase(transaction, surfaceId);
      const current = stored ?? codeDefaultSurfaceBase(surfaceId);
      const history = stored
        ? await loadSurfaceHistory(transaction, surfaceId)
        : [surfaceBaseVersion(surfaceId, current)];
      return {
        currentBase: surfaceBaseVersion(surfaceId, current),
        draft: (await loadSurfaceDraft(transaction, surfaceId)) ?? null,
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
  return await withTenantTransaction(
    pool,
    context,
    async (transaction) => {
      await assertCurrentStudioSurfaceBaseCapability(
        transaction,
        "platform.studio.surface_base.draft",
        surfaceId,
      );
      const subjectId = surfaceBaseSubjectId(context, surfaceId);
      const replay = await loadPresentationMutationReplay(transaction, {
        eventType: SURFACE_BASE_DRAFT_EVENT_TYPE,
        requestHash,
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      if (replay) {
        return parseUpsertPresentationSurfaceDraftResponse({
          billingState: PRESENTATION_BILLING_STATE,
          draft: replay.response,
          evidenceEventId: replay.evidenceEventId,
          replayed: true,
        });
      }

      const base = await loadMutableSurfaceBase(
        transaction,
        surfaceId,
        input.expectedHeadRowVersion,
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
        newState: replayState(requestHash, draft),
        priorState: current ? canonicalJson(current) : null,
        subjectId,
        subjectType: SURFACE_BASE_SUBJECT_TYPE,
      });
      return {
        billingState: PRESENTATION_BILLING_STATE,
        draft,
        evidenceEventId: evidence.evidenceEventId,
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
      const { base, draft } = await loadExactDraftAndHead(transaction, surfaceId, input, "share");
      return {
        billingState: PRESENTATION_BILLING_STATE,
        diagnostics: [],
        draftVersion: draft.draftVersion,
        headRowVersion: base.headRowVersion,
        preview: draft.placements,
        valid: true,
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
): PresentationSurfaceBaseMutationResponse {
  return parsePresentationSurfaceBaseMutationResponse({
    ...(replay.response as Record<string, unknown>),
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
      if (replay) return parseReplayBaseMutation(replay);

      const { base, draft } = await loadExactDraftAndHead(transaction, surfaceId, input, "update");
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
      if (replay) return parseReplayBaseMutation(replay);

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
          ...(replay.response as Record<string, unknown>),
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
