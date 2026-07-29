import type {
  PresentationSettingDefinition,
  PresentationSettingKey,
  PresentationSettingPersistedScope,
  PresentationSettingResolutionScope,
  PresentationSettingValueContract,
} from "@esbla/contracts";
import {
  getPresentationSettingDefinition,
  presentationSettingResolutionPriority,
} from "@esbla/contracts";

export type PresentationSettingCandidateScope =
  | PresentationSettingPersistedScope
  | "session_preview";

export interface PresentationSettingCandidate {
  readonly definitionVersion: number;
  readonly rowVersion: number;
  readonly scope: PresentationSettingCandidateScope;
  readonly value: unknown;
}

export type PresentationOrderedSetOperation =
  | {
      readonly id: string;
      readonly operation: "append";
    }
  | {
      readonly id: string;
      readonly operation: "remove";
    }
  | {
      readonly anchorId: string;
      readonly id: string;
      readonly operation: "insert_after" | "insert_before" | "move_after" | "move_before";
    };

export interface PresentationMandatoryItem {
  readonly anchorId?: string;
  readonly id: string;
  readonly position: "after" | "before" | "end" | "start";
}

export interface PresentationSettingTenantLock {
  readonly reason: string;
  readonly value: unknown;
}

export interface PresentationSettingResolutionEnvironment {
  readonly authorizedIds?: readonly string[];
  readonly contextDefaultIds?: readonly string[];
  readonly forbiddenIds?: readonly string[];
  readonly mandatoryItems?: readonly PresentationMandatoryItem[];
  readonly presenceCapability?: boolean;
  readonly registeredIds?: readonly string[];
  readonly requireHighContrast?: boolean;
  readonly requireReducedMotion?: boolean;
  readonly supportedEnumValues?: readonly string[];
  readonly tenantLock?: PresentationSettingTenantLock;
}

export type PresentationSettingDiagnosticCode =
  | "constraint_floor_applied"
  | "invalid_candidate_fallback"
  | "mandatory_item_reinserted"
  | "ordered_set_capped"
  | "restricted_id_omitted"
  | "unsupported_definition_version";

export interface PresentationSettingDiagnostic {
  readonly code: PresentationSettingDiagnosticCode;
  readonly id?: string;
  readonly scope?: PresentationSettingCandidateScope;
}

export interface PresentationSettingSourceEntry {
  readonly applied: boolean;
  readonly rowVersion: number;
  readonly scope: PresentationSettingResolutionScope;
}

export interface ResolvedPresentationSetting {
  readonly definitionHash: string;
  readonly definitionVersion: 1;
  readonly diagnostics: readonly PresentationSettingDiagnostic[];
  readonly key: PresentationSettingKey;
  readonly lockReason?: string;
  readonly locked: boolean;
  readonly sourceChain: readonly PresentationSettingSourceEntry[];
  readonly sourceScope: PresentationSettingResolutionScope;
  readonly tombstones: readonly string[];
  readonly value: boolean | string | readonly string[];
}

export type PresentationSettingResolutionErrorCode =
  | "conflicting_candidate"
  | "invalid_constraint"
  | "invalid_ordered_set_patch"
  | "missing_context_default"
  | "unsupported_scope";

export class PresentationSettingResolutionError extends Error {
  readonly code: PresentationSettingResolutionErrorCode;

  constructor(code: PresentationSettingResolutionErrorCode) {
    super("Presentation setting resolution failed");
    this.name = "PresentationSettingResolutionError";
    this.code = code;
  }
}

const priority = new Map(
  presentationSettingResolutionPriority.map((scope, index) => [scope, index]),
);
const identifierPattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && identifierPattern.test(value);
}

function validateIdentifierList(value: readonly string[] | undefined): void {
  if (value && (value.some((id) => !isIdentifier(id)) || new Set(value).size !== value.length)) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
}

function validateMandatoryItems(items: readonly PresentationMandatoryItem[] | undefined): void {
  if (!items) return;
  const seen = new Set<string>();
  for (const item of items) {
    if (
      !isIdentifier(item.id) ||
      seen.has(item.id) ||
      !["after", "before", "end", "start"].includes(item.position) ||
      ((item.position === "after" || item.position === "before") &&
        (!isIdentifier(item.anchorId) || item.anchorId === item.id)) ||
      ((item.position === "start" || item.position === "end") && item.anchorId !== undefined)
    ) {
      throw new PresentationSettingResolutionError("invalid_constraint");
    }
    seen.add(item.id);
  }
}

function validateEnvironment(
  definition: PresentationSettingDefinition,
  environment: PresentationSettingResolutionEnvironment,
): void {
  validateIdentifierList(environment.authorizedIds);
  validateIdentifierList(environment.contextDefaultIds);
  validateIdentifierList(environment.forbiddenIds);
  validateIdentifierList(environment.registeredIds);
  validateIdentifierList(environment.supportedEnumValues);
  validateMandatoryItems(environment.mandatoryItems);
  if (
    (environment.requireHighContrast !== undefined &&
      definition.key !== "appearance.high_contrast.v1") ||
    (environment.requireReducedMotion !== undefined &&
      definition.key !== "appearance.reduced_motion.v1") ||
    (environment.presenceCapability !== undefined && definition.key !== "team.rail_open.v1")
  ) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (
    environment.tenantLock &&
    (!definition.lockable ||
      definition.mergeStrategy !== "replace" ||
      !isIdentifier(environment.tenantLock.reason) ||
      (definition.key === "appearance.high_contrast.v1" && environment.tenantLock.value !== true) ||
      (definition.key === "appearance.reduced_motion.v1" &&
        environment.tenantLock.value !== "reduce") ||
      (definition.key === "team.rail_open.v1" && environment.tenantLock.value !== false))
  ) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (
    definition.mergeStrategy !== "ordered_set" &&
    (environment.authorizedIds ||
      environment.contextDefaultIds ||
      environment.forbiddenIds ||
      environment.mandatoryItems ||
      environment.registeredIds)
  ) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (
    definition.mergeStrategy === "ordered_set" &&
    (environment.registeredIds === undefined || environment.authorizedIds === undefined)
  ) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (environment.contextDefaultIds && definition.defaultValue.kind !== "contextual_ids") {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (
    definition.defaultValue.kind === "contextual_ids" &&
    environment.contextDefaultIds === undefined
  ) {
    throw new PresentationSettingResolutionError("missing_context_default");
  }
  if (
    definition.mergeStrategy !== "replace" &&
    (environment.supportedEnumValues || environment.tenantLock)
  ) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (
    environment.supportedEnumValues &&
    definition.key !== "widget.presentation.density.v1" &&
    definition.key !== "widget.presentation.grouping.v1"
  ) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (
    (definition.key === "widget.presentation.density.v1" ||
      definition.key === "widget.presentation.grouping.v1") &&
    environment.supportedEnumValues === undefined
  ) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
}

function scopePriority(scope: PresentationSettingResolutionScope): number {
  const rank = priority.get(scope);
  if (rank === undefined) throw new PresentationSettingResolutionError("unsupported_scope");
  return rank;
}

function isTenantScope(scope: PresentationSettingCandidateScope): boolean {
  return scope.startsWith("tenant_");
}

function isUserScope(scope: PresentationSettingCandidateScope): boolean {
  return scope.startsWith("user_");
}

function parseLiteralDefault(
  definition: PresentationSettingDefinition,
  environment: PresentationSettingResolutionEnvironment,
): boolean | string | readonly string[] {
  if (definition.defaultValue.kind === "literal") return definition.defaultValue.value;
  if (!environment.contextDefaultIds) {
    throw new PresentationSettingResolutionError("missing_context_default");
  }
  return parseOrderedIds(environment.contextDefaultIds, definition.valueContract);
}

function parseOrderedIds(
  value: unknown,
  contract: PresentationSettingValueContract,
): readonly string[] {
  if (
    contract.kind !== "ordered_id_set" ||
    !Array.isArray(value) ||
    (contract.maximumItems !== null && value.length > contract.maximumItems) ||
    value.some((id) => !isIdentifier(id)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("invalid");
  }
  return value as readonly string[];
}

function parseOrderedTenantBase(
  value: unknown,
  contract: PresentationSettingValueContract,
  diagnostics: PresentationSettingDiagnostic[],
): readonly string[] {
  if (
    contract.kind !== "ordered_id_set" ||
    !Array.isArray(value) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("invalid");
  }
  const valid: string[] = [];
  for (const id of value) {
    if (isIdentifier(id)) valid.push(id);
    else diagnostics.push({ code: "restricted_id_omitted" });
  }
  return valid;
}

function parseReplaceValue(
  definition: PresentationSettingDefinition,
  value: unknown,
  environment: PresentationSettingResolutionEnvironment,
): boolean | string {
  const contract = definition.valueContract;
  if (contract.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error("invalid");
    return value;
  }
  if (contract.kind !== "enum" || typeof value !== "string") throw new Error("invalid");
  const contextualEnumValues =
    definition.key === "widget.presentation.grouping.v1"
      ? ["definition_default", ...(environment.supportedEnumValues ?? [])]
      : contract.values;
  if (!contextualEnumValues.includes(value)) throw new Error("invalid");
  if (
    definition.key === "widget.presentation.density.v1" &&
    value !== "definition_default" &&
    environment.supportedEnumValues &&
    !environment.supportedEnumValues.includes(value)
  ) {
    throw new Error("invalid");
  }
  return value;
}

export function parsePresentationOrderedSetPatch(
  value: unknown,
  options: { readonly allowAppend: boolean },
): readonly PresentationOrderedSetOperation[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["operations"]) ||
    !("operations" in value) ||
    !Array.isArray(value.operations)
  ) {
    throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
  }
  const operations: PresentationOrderedSetOperation[] = [];
  for (const operation of value.operations) {
    if (
      typeof operation !== "object" ||
      operation === null ||
      Array.isArray(operation) ||
      !("operation" in operation) ||
      !("id" in operation) ||
      !isIdentifier(operation.id)
    ) {
      throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
    }
    if (operation.operation === "append" || operation.operation === "remove") {
      if (operation.operation === "append" && !options.allowAppend) {
        throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
      }
      if (JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(["id", "operation"])) {
        throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
      }
      operations.push({ id: operation.id, operation: operation.operation });
      continue;
    }
    if (
      !["insert_after", "insert_before", "move_after", "move_before"].includes(
        String(operation.operation),
      ) ||
      !("anchorId" in operation) ||
      !isIdentifier(operation.anchorId) ||
      JSON.stringify(Object.keys(operation).sort()) !==
        JSON.stringify(["anchorId", "id", "operation"])
    ) {
      throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
    }
    operations.push({
      anchorId: operation.anchorId,
      id: operation.id,
      operation: operation.operation as
        | "insert_after"
        | "insert_before"
        | "move_after"
        | "move_before",
    });
  }
  return operations;
}

function applyPatch(
  initial: readonly string[],
  operations: readonly PresentationOrderedSetOperation[],
): readonly string[] {
  const values = [...initial];
  for (const operation of operations) {
    if (operation.operation === "append") {
      if (values.includes(operation.id)) {
        throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
      }
      values.push(operation.id);
      continue;
    }
    if (operation.operation === "remove") {
      const index = values.indexOf(operation.id);
      if (index >= 0) values.splice(index, 1);
      continue;
    }
    const anchorIndex = values.indexOf(operation.anchorId);
    if (anchorIndex < 0 || operation.id === operation.anchorId) {
      throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
    }
    const existingIndex = values.indexOf(operation.id);
    if (operation.operation.startsWith("insert_") && existingIndex >= 0) {
      throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
    }
    if (operation.operation.startsWith("move_") && existingIndex < 0) {
      throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
    }
    if (existingIndex >= 0) values.splice(existingIndex, 1);
    const currentAnchor = values.indexOf(operation.anchorId);
    values.splice(
      currentAnchor + (operation.operation.endsWith("_after") ? 1 : 0),
      0,
      operation.id,
    );
  }
  if (new Set(values).size !== values.length) {
    throw new PresentationSettingResolutionError("invalid_ordered_set_patch");
  }
  return values;
}

function applyMandatoryItems(
  initial: readonly string[],
  mandatoryItems: readonly PresentationMandatoryItem[],
  diagnostics: PresentationSettingDiagnostic[],
  revealIds: boolean,
): readonly string[] {
  const values = [...initial];
  const seen = new Set<string>();
  for (const item of mandatoryItems) {
    if (
      !isIdentifier(item.id) ||
      seen.has(item.id) ||
      ((item.position === "after" || item.position === "before") && !isIdentifier(item.anchorId)) ||
      ((item.position === "start" || item.position === "end") && item.anchorId !== undefined)
    ) {
      throw new PresentationSettingResolutionError("invalid_constraint");
    }
    seen.add(item.id);
    const existingIndex = values.indexOf(item.id);
    if (existingIndex >= 0) values.splice(existingIndex, 1);
    if (item.position === "start") values.unshift(item.id);
    else if (item.position === "end") values.push(item.id);
    else {
      const anchorIndex = values.indexOf(item.anchorId ?? "");
      if (anchorIndex < 0 || item.anchorId === item.id) {
        throw new PresentationSettingResolutionError("invalid_constraint");
      }
      values.splice(anchorIndex + (item.position === "after" ? 1 : 0), 0, item.id);
    }
    diagnostics.push({
      code: "mandatory_item_reinserted",
      ...(revealIds ? { id: item.id } : {}),
    });
  }
  return values;
}

function validateCandidates(
  definition: PresentationSettingDefinition,
  candidates: readonly PresentationSettingCandidate[],
): void {
  for (const candidate of candidates) {
    if (
      (candidate.scope !== "session_preview" &&
        !definition.permittedScopes.includes(candidate.scope)) ||
      (candidate.scope === "session_preview" && !definition.allowsSessionPreview)
    ) {
      throw new PresentationSettingResolutionError("unsupported_scope");
    }
  }
  const seen = new Set<PresentationSettingCandidateScope>();
  for (const candidate of candidates) {
    if (seen.has(candidate.scope)) {
      throw new PresentationSettingResolutionError("conflicting_candidate");
    }
    seen.add(candidate.scope);
  }
}

function sourceChain(
  candidates: readonly PresentationSettingCandidate[],
  appliedScopes: ReadonlySet<PresentationSettingCandidateScope>,
  productDefaultApplied = appliedScopes.size === 0,
): readonly PresentationSettingSourceEntry[] {
  return [
    ...candidates
      .map((candidate) => ({
        applied: appliedScopes.has(candidate.scope),
        rowVersion: candidate.rowVersion,
        scope: candidate.scope,
      }))
      .sort((left, right) => scopePriority(left.scope) - scopePriority(right.scope)),
    {
      applied: productDefaultApplied,
      rowVersion: 0,
      scope: "product_default" as const,
    },
  ];
}

function resolveReplace(
  definition: PresentationSettingDefinition,
  candidates: readonly PresentationSettingCandidate[],
  environment: PresentationSettingResolutionEnvironment,
): ResolvedPresentationSetting {
  const diagnostics: PresentationSettingDiagnostic[] = [];
  const sorted = [...candidates].sort(
    (left, right) => scopePriority(left.scope) - scopePriority(right.scope),
  );
  let value = parseLiteralDefault(definition, environment) as boolean | string;
  let sourceScope: PresentationSettingResolutionScope = "product_default";
  const appliedScopes = new Set<PresentationSettingCandidateScope>();
  let invalidPersonalization = false;
  let personalizationDisabled = false;
  let selected = false;
  for (const [candidateIndex, candidate] of sorted.entries()) {
    if (
      candidate.definitionVersion !== definition.version ||
      !Number.isSafeInteger(candidate.rowVersion) ||
      candidate.rowVersion < (candidate.scope === "session_preview" ? 0 : 1)
    ) {
      diagnostics.push({
        code: "unsupported_definition_version",
        scope: candidate.scope,
      });
      if (definition.key === "surface.personalization_enabled.v1") {
        invalidPersonalization = true;
      }
      continue;
    }
    try {
      const candidateValue = parseReplaceValue(definition, candidate.value, environment);
      if (
        definition.key === "surface.personalization_enabled.v1" &&
        candidate.scope === "tenant_surface" &&
        candidateValue === false
      ) {
        personalizationDisabled = true;
        appliedScopes.add(candidate.scope);
      }
      if (candidateIndex === 0 && !selected) {
        value = candidateValue;
        sourceScope = candidate.scope;
        appliedScopes.add(candidate.scope);
        selected = true;
      }
    } catch {
      diagnostics.push({ code: "invalid_candidate_fallback", scope: candidate.scope });
      if (definition.key === "surface.personalization_enabled.v1") {
        invalidPersonalization = true;
      }
    }
  }

  let locked = false;
  let lockReason: string | undefined;
  if (environment.tenantLock) {
    if (!definition.lockable || !isIdentifier(environment.tenantLock.reason)) {
      throw new PresentationSettingResolutionError("invalid_constraint");
    }
    try {
      value = parseReplaceValue(definition, environment.tenantLock.value, environment);
    } catch {
      throw new PresentationSettingResolutionError("invalid_constraint");
    }
    locked = true;
    lockReason = environment.tenantLock.reason;
    diagnostics.push({ code: "constraint_floor_applied" });
  }
  if (definition.key === "appearance.high_contrast.v1" && environment.requireHighContrast) {
    value = true;
    locked = true;
    lockReason = "accessibility_high_contrast_floor";
    diagnostics.push({ code: "constraint_floor_applied" });
  }
  if (definition.key === "appearance.reduced_motion.v1" && environment.requireReducedMotion) {
    value = "reduce";
    locked = true;
    lockReason = "motion_reduction_floor";
    diagnostics.push({ code: "constraint_floor_applied" });
  }
  if (definition.key === "team.rail_open.v1" && environment.presenceCapability !== true) {
    value = false;
    locked = true;
    lockReason = "presence_capability_absent";
    diagnostics.push({ code: "constraint_floor_applied" });
  }
  if (definition.key === "surface.personalization_enabled.v1") {
    if (invalidPersonalization) {
      value = false;
      locked = true;
      lockReason = "invalid_personalization_candidate";
    } else if (personalizationDisabled || value === false) {
      if (personalizationDisabled && value !== false) {
        diagnostics.push({ code: "constraint_floor_applied" });
      }
      value = false;
      locked = true;
      lockReason = "tenant_personalization_disabled";
    }
  }

  return {
    definitionHash: definition.canonicalHash,
    definitionVersion: definition.version,
    diagnostics,
    key: definition.key,
    ...(lockReason ? { lockReason } : {}),
    locked,
    sourceChain: sourceChain(candidates, appliedScopes),
    sourceScope,
    tombstones: [],
    value,
  };
}

function resolveOrderedSet(
  definition: PresentationSettingDefinition,
  candidates: readonly PresentationSettingCandidate[],
  environment: PresentationSettingResolutionEnvironment,
): ResolvedPresentationSetting {
  const diagnostics: PresentationSettingDiagnostic[] = [];
  const validCandidates: PresentationSettingCandidate[] = [];
  for (const candidate of [...candidates].sort(
    (left, right) => scopePriority(left.scope) - scopePriority(right.scope),
  )) {
    if (
      candidate.definitionVersion !== definition.version ||
      !Number.isSafeInteger(candidate.rowVersion) ||
      candidate.rowVersion < (candidate.scope === "session_preview" ? 0 : 1)
    ) {
      diagnostics.push({
        code: "unsupported_definition_version",
        scope: candidate.scope,
      });
      continue;
    }
    validCandidates.push(candidate);
  }
  const tenantCandidates = validCandidates
    .filter(({ scope }) => isTenantScope(scope))
    .sort((left, right) => scopePriority(left.scope) - scopePriority(right.scope));
  const userCandidates = validCandidates
    .filter(({ scope }) => isUserScope(scope))
    .sort((left, right) => scopePriority(left.scope) - scopePriority(right.scope));
  const preview = validCandidates.find(({ scope }) => scope === "session_preview");
  const appliedScopes = new Set<PresentationSettingCandidateScope>();
  let value = parseLiteralDefault(definition, environment) as readonly string[];
  let sourceScope: PresentationSettingResolutionScope = "product_default";
  let productDefaultApplied = true;
  const tenant = tenantCandidates[0];
  if (tenant) {
    try {
      value = parseOrderedTenantBase(tenant.value, definition.valueContract, diagnostics);
      appliedScopes.add(tenant.scope);
      sourceScope = tenant.scope;
      productDefaultApplied = false;
    } catch {
      diagnostics.push({ code: "invalid_candidate_fallback", scope: tenant.scope });
    }
  }
  const user = userCandidates[0];
  if (user) {
    value = applyPatch(
      value,
      parsePresentationOrderedSetPatch(user.value, {
        allowAppend:
          definition.key === "navigation.universal_shortcuts.v1" ||
          definition.key === "navigation.contextual_shortcuts.v1",
      }),
    );
    appliedScopes.add(user.scope);
    sourceScope = user.scope;
  }
  if (preview) {
    value = applyPatch(
      value,
      parsePresentationOrderedSetPatch(preview.value, { allowAppend: false }),
    );
    appliedScopes.add(preview.scope);
    sourceScope = preview.scope;
  }

  value = applyMandatoryItems(
    value,
    environment.mandatoryItems ?? [],
    diagnostics,
    definition.key !== "widget.presentation.visible_fields.v1",
  );
  const registered = environment.registeredIds ? new Set(environment.registeredIds) : undefined;
  const authorized = environment.authorizedIds ? new Set(environment.authorizedIds) : undefined;
  const forbidden = new Set(environment.forbiddenIds ?? []);
  const tombstones: string[] = [];
  value = value.filter((id) => {
    const eligible = (!registered || registered.has(id)) && (!authorized || authorized.has(id));
    if (!eligible || forbidden.has(id)) {
      if (definition.key === "widget.presentation.visible_fields.v1") {
        diagnostics.push({ code: "restricted_id_omitted" });
      } else {
        if (!tombstones.includes(id)) tombstones.push(id);
        diagnostics.push({ code: "restricted_id_omitted", id });
      }
      return false;
    }
    return true;
  });

  const maximumItems =
    definition.valueContract.kind === "ordered_id_set"
      ? definition.valueContract.maximumItems
      : null;
  const mandatoryIds = new Set((environment.mandatoryItems ?? []).map(({ id }) => id));
  if (maximumItems !== null && mandatoryIds.size > maximumItems) {
    throw new PresentationSettingResolutionError("invalid_constraint");
  }
  if (maximumItems !== null && value.length > maximumItems) {
    const kept: string[] = [];
    for (const id of value) {
      if (kept.length < maximumItems || mandatoryIds.has(id)) kept.push(id);
    }
    while (kept.length > maximumItems) {
      let removable = -1;
      for (let index = kept.length - 1; index >= 0; index -= 1) {
        if (!mandatoryIds.has(kept[index] ?? "")) {
          removable = index;
          break;
        }
      }
      if (removable < 0) throw new PresentationSettingResolutionError("invalid_constraint");
      const [removed] = kept.splice(removable, 1);
      if (removed && !tombstones.includes(removed)) tombstones.push(removed);
    }
    value = kept;
    diagnostics.push({ code: "ordered_set_capped" });
  }

  const hasTenantConstraints =
    (environment.mandatoryItems?.length ?? 0) > 0 || (environment.forbiddenIds?.length ?? 0) > 0;
  return {
    definitionHash: definition.canonicalHash,
    definitionVersion: definition.version,
    diagnostics,
    key: definition.key,
    ...(hasTenantConstraints ? { lockReason: "tenant_ordered_set_constraints" } : {}),
    locked: hasTenantConstraints,
    sourceChain: sourceChain(candidates, appliedScopes, productDefaultApplied),
    sourceScope,
    tombstones,
    value,
  };
}

export function resolvePresentationSetting(
  key: PresentationSettingKey,
  candidates: readonly PresentationSettingCandidate[],
  environment: PresentationSettingResolutionEnvironment = {},
): ResolvedPresentationSetting {
  const definition = getPresentationSettingDefinition(key);
  validateCandidates(definition, candidates);
  validateEnvironment(definition, environment);
  return definition.mergeStrategy === "ordered_set"
    ? resolveOrderedSet(definition, candidates, environment)
    : resolveReplace(definition, candidates, environment);
}
