import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  HrEmploymentDetailQuery,
  HrEmploymentListQuery,
  HrEmploymentListResponse,
  HrEmploymentRecord,
  HrEmploymentRecordMutationResponse,
} from "@esbla/contracts";
import {
  parseHrEmploymentDetailQuery,
  parseHrEmploymentListQuery,
  parseHrEmploymentRecordMutationResponse,
} from "@esbla/contracts";
import {
  type HrServiceControl,
  type HrServiceMutationResponse,
  parseHrServiceMutationResponse,
} from "@esbla/contracts/hr-service-control-api";
import { fetchDevelopmentApi } from "./development-session";
import { readDevelopmentSessionConfig } from "./development-session-core";
import {
  decodeEmploymentList,
  decodeEmploymentMutation,
  decodeEmploymentRecord,
  decodeEmploymentServiceControl,
  type EmploymentAction,
  type EmploymentAuthorizedActions,
  type EmploymentFailureState,
  type EmploymentOperation,
  EmploymentUiError,
  employmentStateForError,
  hasEmploymentAction,
  parseEmploymentAuthorizedActions,
} from "./hr-employment-record-core";

type SearchParameters = Readonly<Record<string, string | string[] | undefined>>;

interface EmploymentAuthorityState {
  readonly authorizedActions: EmploymentAuthorizedActions;
}

export type EmploymentListLoadState = EmploymentAuthorityState &
  (
    | { readonly page: HrEmploymentListResponse; readonly status: "success" }
    | EmploymentFailureState
  );
export type EmploymentDetailLoadState = EmploymentAuthorityState &
  ({ readonly record: HrEmploymentRecord; readonly status: "success" } | EmploymentFailureState);
export type EmploymentControlLoadState = EmploymentAuthorityState &
  ({ readonly control: HrServiceControl; readonly status: "success" } | EmploymentFailureState);

const NO_EMPLOYMENT_ACTIONS: EmploymentAuthorizedActions = Object.freeze([]);
const EMPLOYMENT_RECEIPT_DOMAIN = "esbla-employment-mutation-receipt-v1\0";
const EMPLOYMENT_RECEIPT_TTL_MS = 5 * 60 * 1_000;
const EMPLOYMENT_RECEIPT_CLOCK_SKEW_MS = 5_000;
const MAX_EMPLOYMENT_RECEIPT_LENGTH = 1_024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const EMPLOYMENT_MUTATION_RECEIPT_COOKIE = "esbla_employment_mutation_receipt";
export const EMPLOYMENT_MUTATION_RECEIPT_MAX_AGE_SECONDS = EMPLOYMENT_RECEIPT_TTL_MS / 1_000;

type EmploymentRecordOperation = Extract<
  EmploymentOperation,
  "create_record" | "create_version" | "end_record"
>;
type EmploymentServiceOperation = Exclude<EmploymentOperation, EmploymentRecordOperation>;

export type EmploymentMutationReceipt =
  | Readonly<{
      audience: "admin";
      currentVersion: number | null;
      employmentRecordId: string;
      kind: "record";
      operation: EmploymentRecordOperation;
      rootVersion: number;
      status: "active" | "draft" | "ended";
    }>
  | Readonly<{
      activationState: "active" | "inactive";
      activationVersion: number;
      audience: "settings";
      controlVersion: number;
      kind: "service_control";
      operation: EmploymentServiceOperation;
      settingsVersion: number;
    }>;

interface SealedEmploymentMutationReceipt {
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly payloadVersion: 1;
  readonly receipt: EmploymentMutationReceipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}

function mutationReceiptFromResult(
  action: EmploymentAction,
  result: HrEmploymentRecordMutationResponse | HrServiceMutationResponse,
): EmploymentMutationReceipt {
  if ("employmentRecordId" in result) {
    try {
      result = parseHrEmploymentRecordMutationResponse(result);
    } catch {
      throw new EmploymentUiError("operational_error");
    }
    if (
      action.operation !== result.operation ||
      (action.operation !== "create_record" &&
        action.operation !== "create_version" &&
        action.operation !== "end_record") ||
      (action.operation !== "create_record" &&
        result.employmentRecordId !== action.employmentRecordId) ||
      result.rootVersion !==
        (action.operation === "create_record" ? 1 : action.body.expectedVersion + 1) ||
      result.currentVersion !==
        (action.operation === "create_record"
          ? null
          : (action.body.expectedCurrentVersion ?? 0) + 1)
    ) {
      throw new EmploymentUiError("operational_error");
    }
    return Object.freeze({
      audience: "admin" as const,
      currentVersion: result.currentVersion,
      employmentRecordId: result.employmentRecordId,
      kind: "record" as const,
      operation: action.operation,
      rootVersion: result.rootVersion,
      status: result.status,
    });
  }
  try {
    result = parseHrServiceMutationResponse(result);
  } catch {
    throw new EmploymentUiError("operational_error");
  }
  if (action.operation !== result.operation) {
    throw new EmploymentUiError("operational_error");
  }
  if (result.serviceKey !== "employment_record") {
    throw new EmploymentUiError("operational_error");
  }
  const expectedActivationVersion =
    action.operation === "configure_service" ? null : (action.body.expectedVersion ?? 0) + 1;
  const validTransition =
    action.operation === "activate_service"
      ? result.activationState === "active" &&
        result.activationVersion === expectedActivationVersion &&
        (action.body.expectedVersion !== null ||
          (result.controlVersion === 1 && result.settingsVersion === 1))
      : action.operation === "deactivate_service"
        ? result.activationState === "inactive" &&
          result.activationVersion === expectedActivationVersion
        : result.activationState === "active" &&
          result.settingsVersion === action.body.expectedSettingsVersion + 1;
  const exactControlVersion = result.activationVersion + result.settingsVersion - 1;
  if (
    !validTransition ||
    !positiveVersion(exactControlVersion) ||
    result.controlVersion !== exactControlVersion
  ) {
    throw new EmploymentUiError("operational_error");
  }
  return Object.freeze({
    activationState: result.activationState,
    activationVersion: result.activationVersion,
    audience: "settings" as const,
    controlVersion: result.controlVersion,
    kind: "service_control" as const,
    operation: action.operation,
    settingsVersion: result.settingsVersion,
  });
}

function receiptSignature(
  secret: string,
  tenantId: string,
  principalId: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(EMPLOYMENT_RECEIPT_DOMAIN)
    .update(tenantId)
    .update("\0")
    .update(principalId)
    .update("\0")
    .update(body)
    .digest("base64url");
}

export function sealEmploymentMutationReceipt(
  action: EmploymentAction,
  result: HrEmploymentRecordMutationResponse | HrServiceMutationResponse,
  now = Date.now(),
): string {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - EMPLOYMENT_RECEIPT_TTL_MS
  ) {
    throw new EmploymentUiError("operational_error");
  }
  const session = readDevelopmentSessionConfig(process.env);
  const payload: SealedEmploymentMutationReceipt = {
    expiresAt: now + EMPLOYMENT_RECEIPT_TTL_MS,
    issuedAt: now,
    payloadVersion: 1,
    receipt: mutationReceiptFromResult(action, result),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${receiptSignature(session.secret, session.tenantId, session.principalId, body)}`;
}

function parseReceipt(value: unknown): EmploymentMutationReceipt | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "record") {
    if (
      !exactKeys(value, [
        "audience",
        "currentVersion",
        "employmentRecordId",
        "kind",
        "operation",
        "rootVersion",
        "status",
      ]) ||
      value.audience !== "admin" ||
      typeof value.employmentRecordId !== "string" ||
      !UUID.test(value.employmentRecordId) ||
      !["create_record", "create_version", "end_record"].includes(String(value.operation)) ||
      !positiveVersion(value.rootVersion) ||
      (value.currentVersion !== null && !positiveVersion(value.currentVersion)) ||
      !["active", "draft", "ended"].includes(String(value.status)) ||
      (value.operation === "create_record" &&
        (value.status !== "draft" || value.rootVersion !== 1 || value.currentVersion !== null)) ||
      (value.operation === "create_version" &&
        (value.status !== "active" || value.currentVersion === null)) ||
      (value.operation === "end_record" &&
        (value.status !== "ended" || value.currentVersion === null))
    ) {
      return null;
    }
    return Object.freeze({
      audience: "admin",
      currentVersion: value.currentVersion,
      employmentRecordId: value.employmentRecordId.toLowerCase(),
      kind: "record",
      operation: value.operation as EmploymentRecordOperation,
      rootVersion: value.rootVersion,
      status: value.status as "active" | "draft" | "ended",
    });
  }
  if (
    value.kind !== "service_control" ||
    !exactKeys(value, [
      "activationState",
      "activationVersion",
      "audience",
      "controlVersion",
      "kind",
      "operation",
      "settingsVersion",
    ]) ||
    value.audience !== "settings" ||
    !["active", "inactive"].includes(String(value.activationState)) ||
    !["activate_service", "configure_service", "deactivate_service"].includes(
      String(value.operation),
    ) ||
    !positiveVersion(value.activationVersion) ||
    !positiveVersion(value.controlVersion) ||
    !positiveVersion(value.settingsVersion) ||
    value.controlVersion !== value.activationVersion + value.settingsVersion - 1 ||
    (value.operation === "activate_service" && value.activationState !== "active") ||
    (value.operation === "configure_service" && value.activationState !== "active") ||
    (value.operation === "deactivate_service" && value.activationState !== "inactive")
  ) {
    return null;
  }
  return Object.freeze({
    activationState: value.activationState as "active" | "inactive",
    activationVersion: value.activationVersion,
    audience: "settings",
    controlVersion: value.controlVersion,
    kind: "service_control",
    operation: value.operation as EmploymentServiceOperation,
    settingsVersion: value.settingsVersion,
  });
}

export function readEmploymentMutationReceipt(
  sealed: string | undefined,
  expectedAudience: EmploymentMutationReceipt["audience"],
  now = Date.now(),
): EmploymentMutationReceipt | null {
  try {
    if (
      !sealed ||
      sealed.length > MAX_EMPLOYMENT_RECEIPT_LENGTH ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      return null;
    }
    const parts = sealed.split(".");
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    ) {
      return null;
    }
    const session = readDevelopmentSessionConfig(process.env);
    const expected = Buffer.from(
      receiptSignature(session.secret, session.tenantId, session.principalId, parts[0]),
      "base64url",
    );
    const actual = Buffer.from(parts[1], "base64url");
    const encodedPayload = Buffer.from(parts[0], "base64url");
    if (
      actual.toString("base64url") !== parts[1] ||
      encodedPayload.toString("base64url") !== parts[0] ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return null;
    }
    const parsed: unknown = JSON.parse(encodedPayload.toString("utf8"));
    if (
      !isRecord(parsed) ||
      !exactKeys(parsed, ["expiresAt", "issuedAt", "payloadVersion", "receipt"]) ||
      parsed.payloadVersion !== 1 ||
      !Number.isSafeInteger(parsed.issuedAt) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      (parsed.issuedAt as number) < 0 ||
      (parsed.issuedAt as number) > now + EMPLOYMENT_RECEIPT_CLOCK_SKEW_MS ||
      parsed.expiresAt !== (parsed.issuedAt as number) + EMPLOYMENT_RECEIPT_TTL_MS ||
      (parsed.expiresAt as number) <= now ||
      (parsed.expiresAt as number) > Number.MAX_SAFE_INTEGER
    ) {
      return null;
    }
    const receipt = parseReceipt(parsed.receipt);
    return receipt?.audience === expectedAudience ? receipt : null;
  } catch {
    return null;
  }
}

function one(parameters: SearchParameters, key: string): string | undefined {
  const value = parameters[key];
  if (Array.isArray(value)) throw new EmploymentUiError("validation", 400);
  return value;
}

function pageSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new EmploymentUiError("validation", 400);
  return Number(value);
}

function listQuery(parameters: SearchParameters): HrEmploymentListQuery {
  return parseHrEmploymentListQuery({
    ...(one(parameters, "cursorCreatedAt") === undefined
      ? {}
      : { cursorCreatedAt: one(parameters, "cursorCreatedAt") }),
    ...(one(parameters, "cursorEmploymentRecordId") === undefined
      ? {}
      : { cursorEmploymentRecordId: one(parameters, "cursorEmploymentRecordId") }),
    ...(one(parameters, "pageSize") === undefined
      ? {}
      : { pageSize: pageSize(one(parameters, "pageSize")) }),
  });
}

function detailQuery(parameters: SearchParameters): HrEmploymentDetailQuery {
  const version = one(parameters, "cursorVersion");
  if (version !== undefined && !/^[1-9]\d*$/.test(version)) {
    throw new EmploymentUiError("validation", 400);
  }
  return parseHrEmploymentDetailQuery({
    ...(version === undefined ? {} : { cursorVersion: Number(version) }),
    ...(one(parameters, "cursorEmploymentRecordVersionId") === undefined
      ? {}
      : {
          cursorEmploymentRecordVersionId: one(parameters, "cursorEmploymentRecordVersionId"),
        }),
    ...(one(parameters, "pageSize") === undefined
      ? {}
      : { pageSize: pageSize(one(parameters, "pageSize")) }),
  });
}

function queryString(query: object): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  const serialized = parameters.toString();
  return serialized ? `?${serialized}` : "";
}

export async function loadEmploymentList(
  parameters: SearchParameters = {},
): Promise<EmploymentListLoadState> {
  let authorizedActions = NO_EMPLOYMENT_ACTIONS;
  try {
    const query = listQuery(parameters);
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: `/v1/hr/employment-records${queryString(query)}`,
    });
    authorizedActions = parseEmploymentAuthorizedActions(response);
    if (response.status === 200 && !hasEmploymentAction(authorizedActions, "list_authorized")) {
      throw new EmploymentUiError("operational_error");
    }
    return {
      authorizedActions,
      page: await decodeEmploymentList(Promise.resolve(response)),
      status: "success",
    };
  } catch (error) {
    return { ...employmentStateForError(error), authorizedActions };
  }
}

export async function loadEmploymentDetail(
  employmentRecordId: string,
  parameters: SearchParameters = {},
): Promise<EmploymentDetailLoadState> {
  let authorizedActions = NO_EMPLOYMENT_ACTIONS;
  try {
    const query = detailQuery(parameters);
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: `/v1/hr/employment-records/by-id/${encodeURIComponent(
        employmentRecordId,
      )}${queryString(query)}`,
    });
    authorizedActions = parseEmploymentAuthorizedActions(response);
    if (response.status === 200 && !hasEmploymentAction(authorizedActions, "view_detail")) {
      throw new EmploymentUiError("operational_error");
    }
    return {
      authorizedActions,
      record: await decodeEmploymentRecord(Promise.resolve(response)),
      status: "success",
    };
  } catch (error) {
    return { ...employmentStateForError(error), authorizedActions };
  }
}

export async function loadEmploymentServiceControl(): Promise<EmploymentControlLoadState> {
  let authorizedActions = NO_EMPLOYMENT_ACTIONS;
  try {
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: "/v1/hr/employment-records/service-control",
    });
    authorizedActions = parseEmploymentAuthorizedActions(response);
    if (
      response.status === 200 &&
      !hasEmploymentAction(authorizedActions, "view_service_control")
    ) {
      throw new EmploymentUiError("operational_error");
    }
    return {
      authorizedActions,
      control: await decodeEmploymentServiceControl(Promise.resolve(response)),
      status: "success",
    };
  } catch (error) {
    return { ...employmentStateForError(error), authorizedActions };
  }
}

export async function executeEmploymentAction(
  action: EmploymentAction,
): Promise<HrEmploymentRecordMutationResponse | HrServiceMutationResponse> {
  if (action.operation === "create_record") {
    return await decodeEmploymentMutation(
      fetchDevelopmentApi({
        body: action.body,
        idempotencyKey: action.idempotencyKey,
        method: "POST",
        path: "/v1/hr/employment-records",
      }),
      "create_record",
    );
  }
  if (action.operation === "create_version" || action.operation === "end_record") {
    return await decodeEmploymentMutation(
      fetchDevelopmentApi({
        body: action.body,
        idempotencyKey: action.idempotencyKey,
        method: "POST",
        path: `/v1/hr/employment-records/${encodeURIComponent(action.employmentRecordId)}/${
          action.operation === "create_version" ? "versions" : "end"
        }`,
      }),
      action.operation,
    );
  }
  const operation = action.operation.replace("_service", "");
  return await decodeEmploymentMutation(
    fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: action.operation === "configure_service" ? "PATCH" : "POST",
      path: `/v1/hr/employment-records/service-control/${
        operation === "configure" ? "settings" : operation
      }`,
    }),
    action.operation,
  );
}
