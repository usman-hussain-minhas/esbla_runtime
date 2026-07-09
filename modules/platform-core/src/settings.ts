import type { TenantTransaction } from "./context.js";
import { PlatformError } from "./errors.js";

export type SettingValue = boolean | number | string;
export type SettingValueType = "boolean" | "decimal" | "duration" | "enum" | "integer" | "text";

export type SettingPolicyFloor<T extends SettingValue> =
  | { readonly kind: "locked"; readonly value: T }
  | { readonly kind: "maximum"; readonly value: number }
  | { readonly kind: "minimum"; readonly value: number };

export interface SettingDefinition<T extends SettingValue> {
  readonly allowTenantOverride: boolean;
  readonly defaultValue: T;
  readonly key: string;
  readonly policyFloor?: SettingPolicyFloor<T>;
  readonly validate?: (value: T) => boolean;
  readonly valueType: SettingValueType;
}

export interface ResolvedSetting<T extends SettingValue> {
  readonly key: string;
  readonly source: "registered_default" | "tenant_override";
  readonly value: T;
  readonly version: number | null;
}

function hasExpectedType(value: SettingValue, valueType: SettingValueType): boolean {
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (valueType === "decimal") return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
  if (valueType === "duration") {
    return (
      typeof value === "string" &&
      /^P(?:\d+W|(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?)$/.test(
        value,
      )
    );
  }
  return typeof value === "string";
}

function enforcePolicyFloor<T extends SettingValue>(
  definition: SettingDefinition<T>,
  value: T,
): void {
  const floor = definition.policyFloor;
  if (!floor) return;

  const violates =
    (floor.kind === "locked" && value !== floor.value) ||
    (floor.kind === "minimum" && (typeof value !== "number" || value < floor.value)) ||
    (floor.kind === "maximum" && (typeof value !== "number" || value > floor.value));

  if (violates) {
    throw new PlatformError("SETTING_INVALID", "Setting violates its policy floor", {
      key: definition.key,
      policyFloorKind: floor.kind,
    });
  }
}

function validateValue<T extends SettingValue>(definition: SettingDefinition<T>, value: T): void {
  let customValidationPassed = true;
  try {
    customValidationPassed = definition.validate?.(value) ?? true;
  } catch {
    customValidationPassed = false;
  }
  if (!hasExpectedType(value, definition.valueType) || !customValidationPassed) {
    throw new PlatformError("SETTING_INVALID", "Setting value is invalid", {
      key: definition.key,
      valueType: definition.valueType,
    });
  }
  enforcePolicyFloor(definition, value);
}

export async function resolveSetting<T extends SettingValue>(
  transaction: TenantTransaction,
  definition: SettingDefinition<T>,
): Promise<ResolvedSetting<T>> {
  validateValue(definition, definition.defaultValue);
  const result = await transaction.client.query<{
    value: SettingValue;
    value_type: SettingValueType;
    version: number;
  }>(
    `SELECT value, value_type, version
     FROM tenant_settings
     WHERE tenant_id = $1 AND setting_key = $2`,
    [transaction.context.tenantId, definition.key],
  );
  const override = result.rows[0];
  if (!override) {
    return {
      key: definition.key,
      source: "registered_default",
      value: definition.defaultValue,
      version: null,
    };
  }
  if (!definition.allowTenantOverride) {
    throw new PlatformError(
      "SETTING_OVERRIDE_NOT_ALLOWED",
      "A tenant override exists for a non-overridable setting",
      { key: definition.key },
    );
  }
  if (override.value_type !== definition.valueType) {
    throw new PlatformError("SETTING_INVALID", "Stored setting type does not match registry", {
      actual: override.value_type,
      expected: definition.valueType,
      key: definition.key,
    });
  }

  const value = override.value as T;
  validateValue(definition, value);
  return {
    key: definition.key,
    source: "tenant_override",
    value,
    version: override.version,
  };
}
