import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  HrShiftAssignmentResponse,
  HrShiftListResponse,
  HrShiftRoster,
} from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import { readDevelopmentSessionConfig } from "./development-session-core";
import {
  decodeShiftMutation,
  decodeShiftRead,
  hasShiftAction,
  parseShiftActions,
  type ShiftAction,
  type ShiftAuthorizedAction,
  type ShiftFailureState,
  type ShiftMutationResult,
  type ShiftOperation,
  ShiftUiError,
  shiftStateForError,
} from "./hr-shift-assignment-core";

type Search = Readonly<Record<string, string | string[] | undefined>>;
type Authority = Readonly<{ authorizedActions: readonly ShiftAuthorizedAction[] }>;
export type ShiftListState = Authority &
  ({ readonly page: HrShiftListResponse; readonly status: "success" } | ShiftFailureState);
export type ShiftDetailState = Authority &
  ({ readonly detail: HrShiftAssignmentResponse; readonly status: "success" } | ShiftFailureState);

const NO_ACTIONS: readonly ShiftAuthorizedAction[] = Object.freeze([]);
const RECEIPT_DOMAIN = "esbla-shift-roster-mutation-receipt-v1\0";
const RECEIPT_TTL_MS = 5 * 60 * 1_000;
const RECEIPT_CLOCK_SKEW_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const SHIFT_MUTATION_RECEIPT_COOKIE = "esbla_shift_roster_mutation_receipt";
export const SHIFT_MUTATION_RECEIPT_MAX_AGE_SECONDS = RECEIPT_TTL_MS / 1_000;
export interface ShiftMutationReceipt {
  readonly operation: ShiftOperation;
  readonly recordId: string;
  readonly rosterVersionId: string;
  readonly status: "active" | "cancelled" | "draft" | "published";
  readonly version: number;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
}
function receiptFor(action: ShiftAction, result: ShiftMutationResult): ShiftMutationReceipt {
  const expectedVersion = action.body.expectedVersion;
  if ("assignment" in result) {
    const assignment = result.assignment;
    const operation = assignment.status === "active" ? "assign" : "cancel";
    if (
      action.operation !== operation ||
      (operation === "assign" && assignment.rosterVersionId !== action.id) ||
      (operation === "cancel" && assignment.shiftAssignmentId !== action.id) ||
      assignment.version !== (operation === "assign" ? 1 : Number(expectedVersion) + 1)
    )
      throw new ShiftUiError("operational_error");
    return {
      operation,
      recordId: assignment.shiftAssignmentId,
      rosterVersionId: assignment.rosterVersionId,
      status: assignment.status,
      version: assignment.version,
    };
  }
  const roster = result as HrShiftRoster;
  if (roster.status !== "draft" && roster.status !== "published")
    throw new ShiftUiError("operational_error");
  const operation = roster.status === "draft" ? "create_roster" : "publish";
  if (
    action.operation !== operation ||
    (operation === "publish" && roster.rosterVersionId !== action.id) ||
    roster.version !== (operation === "create_roster" ? 1 : Number(expectedVersion) + 1)
  )
    throw new ShiftUiError("operational_error");
  return {
    operation,
    recordId: roster.rosterVersionId,
    rosterVersionId: roster.rosterVersionId,
    status: roster.status,
    version: roster.version,
  };
}
function sign(body: string): string {
  const session = readDevelopmentSessionConfig(process.env);
  return createHmac("sha256", session.secret)
    .update(RECEIPT_DOMAIN)
    .update(session.tenantId)
    .update("\0")
    .update(session.principalId)
    .update("\0")
    .update(body)
    .digest("base64url");
}
export function sealShiftMutationReceipt(
  action: ShiftAction,
  result: ShiftMutationResult,
  now = Date.now(),
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - RECEIPT_TTL_MS)
    throw new ShiftUiError("operational_error");
  const receipt = receiptFor(action, result);
  const value = [
    1,
    now,
    now + RECEIPT_TTL_MS,
    receipt.operation,
    receipt.recordId,
    receipt.rosterVersionId,
    receipt.version,
    receipt.status,
  ];
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}
export function readShiftMutationReceipt(
  sealed: string | undefined,
  now = Date.now(),
): ShiftMutationReceipt | null {
  try {
    if (!sealed || sealed.length > 768 || !Number.isSafeInteger(now) || now < 0) return null;
    const parts = sealed.split(".");
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    )
      return null;
    const body = Buffer.from(parts[0], "base64url");
    const actual = Buffer.from(parts[1], "base64url");
    const expected = Buffer.from(sign(parts[0]), "base64url");
    if (
      body.toString("base64url") !== parts[0] ||
      actual.toString("base64url") !== parts[1] ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return null;
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 8 ||
      value[0] !== 1 ||
      !Number.isSafeInteger(value[1]) ||
      !Number.isSafeInteger(value[2]) ||
      (value[1] as number) < 0 ||
      (value[1] as number) > now + RECEIPT_CLOCK_SKEW_MS ||
      value[2] !== (value[1] as number) + RECEIPT_TTL_MS ||
      (value[2] as number) <= now ||
      !["assign", "cancel", "create_roster", "publish"].includes(String(value[3])) ||
      typeof value[4] !== "string" ||
      !UUID.test(value[4]) ||
      typeof value[5] !== "string" ||
      !UUID.test(value[5]) ||
      !positive(value[6]) ||
      !["active", "cancelled", "draft", "published"].includes(String(value[7]))
    )
      return null;
    const operation = value[3] as ShiftOperation;
    const status = value[7] as ShiftMutationReceipt["status"];
    if (
      (operation === "assign" && status !== "active") ||
      (operation === "cancel" && status !== "cancelled") ||
      (operation === "create_roster" && status !== "draft") ||
      (operation === "publish" && status !== "published")
    )
      return null;
    return {
      operation,
      recordId: value[4].toLowerCase(),
      rosterVersionId: value[5].toLowerCase(),
      status,
      version: value[6],
    };
  } catch {
    return null;
  }
}

function one(search: Search, key: string): string | undefined {
  const value = search[key];
  if (Array.isArray(value)) throw new ShiftUiError("validation", 400);
  return value;
}
function dateInstant(value: string | undefined, fallback: string, end = false): string {
  const selected = value ?? fallback;
  if (!DATE.test(selected)) throw new ShiftUiError("validation", 400);
  const date = new Date(`${selected}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== selected)
    throw new ShiftUiError("validation", 400);
  if (end) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}
function defaults(): readonly [string, string] {
  const start = new Date();
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 30);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}
function pageSize(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 50) throw new ShiftUiError("validation", 400);
  return value;
}
function cursor(search: Search, target: URLSearchParams): void {
  const id = one(search, "cursorShiftAssignmentId");
  const startsAt = one(search, "cursorStartsAt");
  if ((id === undefined) !== (startsAt === undefined) || (id && !UUID.test(id)))
    throw new ShiftUiError("validation", 400);
  if (id && startsAt) {
    target.set("cursorShiftAssignmentId", id);
    target.set("cursorStartsAt", startsAt);
  }
  const size = pageSize(one(search, "pageSize"));
  if (size) target.set("pageSize", size);
}
async function loadList(query: URLSearchParams): Promise<ShiftListState> {
  let authorizedActions = NO_ACTIONS;
  try {
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: `/v1/hr/shift-assignments?${query}`,
    });
    authorizedActions = parseShiftActions(response);
    if (response.status === 200 && !hasShiftAction(authorizedActions, "list_roster"))
      throw new ShiftUiError("operational_error");
    return {
      authorizedActions,
      page: (await decodeShiftRead(response, "list")) as HrShiftListResponse,
      status: "success",
    };
  } catch (error) {
    return { ...shiftStateForError(error), authorizedActions };
  }
}

export async function loadOwnShifts(search: Search = {}): Promise<ShiftListState> {
  try {
    const [from, to] = defaults();
    const query = new URLSearchParams({
      mode: "own",
      rangeEnd: dateInstant(one(search, "to"), to, true),
      rangeStart: dateInstant(one(search, "from"), from),
    });
    cursor(search, query);
    return await loadList(query);
  } catch (error) {
    return { ...shiftStateForError(error), authorizedActions: NO_ACTIONS };
  }
}

export async function loadRosterShifts(search: Search): Promise<ShiftListState> {
  try {
    const rosterVersionId = one(search, "rosterVersionId");
    const status = one(search, "status") ?? "active";
    if (
      !rosterVersionId ||
      !UUID.test(rosterVersionId) ||
      !["active", "cancelled"].includes(status)
    )
      throw new ShiftUiError("validation", 400);
    const query = new URLSearchParams({ mode: "roster", rosterVersionId, status });
    cursor(search, query);
    return await loadList(query);
  } catch (error) {
    return { ...shiftStateForError(error), authorizedActions: NO_ACTIONS };
  }
}

export async function loadShiftDetail(id: string): Promise<ShiftDetailState> {
  let authorizedActions = NO_ACTIONS;
  try {
    if (!UUID.test(id)) throw new ShiftUiError("validation", 400);
    const response = await fetchDevelopmentApi({
      method: "GET",
      path: `/v1/hr/shift-assignments/by-id/${encodeURIComponent(id)}`,
    });
    authorizedActions = parseShiftActions(response);
    if (response.status === 200 && !hasShiftAction(authorizedActions, "view_detail"))
      throw new ShiftUiError("operational_error");
    return {
      authorizedActions,
      detail: (await decodeShiftRead(response, "detail")) as HrShiftAssignmentResponse,
      status: "success",
    };
  } catch (error) {
    return { ...shiftStateForError(error), authorizedActions };
  }
}

export async function executeShiftAction(action: ShiftAction): Promise<ShiftMutationResult> {
  let path: string;
  if (action.operation === "create_roster") path = "/v1/hr/shift-rosters";
  else if (action.operation === "assign")
    path = `/v1/hr/shift-rosters/${encodeURIComponent(action.id ?? "")}/assignments`;
  else if (action.operation === "publish")
    path = `/v1/hr/shift-rosters/${encodeURIComponent(action.id ?? "")}/publish`;
  else if (action.operation === "cancel")
    path = `/v1/hr/shift-assignments/${encodeURIComponent(action.id ?? "")}/cancel`;
  else throw new ShiftUiError("validation", 400);
  return await decodeShiftMutation(
    await fetchDevelopmentApi({
      body: action.body,
      idempotencyKey: action.idempotencyKey,
      method: "POST",
      path,
    }),
    action.operation,
  );
}
