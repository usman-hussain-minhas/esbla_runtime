import {
  type MarkAllOwnNotificationsReadBody,
  type MarkAllOwnNotificationsReadResponse,
  type MarkOwnNotificationReadBody,
  type MarkOwnNotificationReadResponse,
  type PlatformNotificationListQuery,
  type PlatformNotificationPage,
  parseApiProblemDetails,
  parseMarkAllOwnNotificationsReadBody,
  parseMarkAllOwnNotificationsReadResponse,
  parseMarkOwnNotificationReadBody,
  parseMarkOwnNotificationReadResponse,
  parseNotificationListQuery,
  parseNotificationPage,
  parsePlatformNotificationPath,
} from "@esbla/contracts";
import { isSameOriginPresentationRequest } from "./presentation-preferences-core";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PlatformNotificationsErrorKind =
  | "conflict"
  | "forbidden"
  | "invalid_input"
  | "not_found"
  | "unavailable";

export class PlatformNotificationsError extends Error {
  readonly kind: PlatformNotificationsErrorKind;

  constructor(kind: PlatformNotificationsErrorKind = "unavailable") {
    super("Notifications are unavailable");
    this.name = "PlatformNotificationsError";
    this.kind = kind;
  }
}

export function notificationMarkAllBeforeOccurredAt(
  page: PlatformNotificationPage,
): string | undefined {
  if (page.unreadCount === 0) return undefined;
  const newest = page.items[0];
  if (!newest) throw new PlatformNotificationsError();
  return newest.occurredAt;
}

function mediaTypeEssence(response: Response): string | null {
  const value = response.headers.get("content-type");
  if (value === null || value.includes(",")) return null;
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

function errorForProblem(status: number, code: string): PlatformNotificationsError {
  if (status === 403 || code === "POLICY_DENIED" || code === "ACTOR_NOT_ACTIVE_MEMBER") {
    return new PlatformNotificationsError("forbidden");
  }
  if (status === 404 || code === "NOTIFICATION_NOT_FOUND") {
    return new PlatformNotificationsError("not_found");
  }
  if (
    status === 409 ||
    code === "NOTIFICATION_VERSION_CONFLICT" ||
    code === "IDEMPOTENCY_CONFLICT"
  ) {
    return new PlatformNotificationsError("conflict");
  }
  if (status === 400) return new PlatformNotificationsError("invalid_input");
  return new PlatformNotificationsError();
}

async function decodeSuccess<T>(
  responsePromise: Promise<Response>,
  parse: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    throw new PlatformNotificationsError();
  }
  const mediaType = mediaTypeEssence(response);
  if (response.status === 200) {
    if (mediaType !== "application/json") throw new PlatformNotificationsError();
    try {
      return parse(await response.json());
    } catch {
      throw new PlatformNotificationsError();
    }
  }
  if (mediaType !== "application/problem+json") throw new PlatformNotificationsError();
  try {
    const problem = parseApiProblemDetails(await response.json());
    if (problem.status !== response.status) throw new Error("status mismatch");
    throw errorForProblem(response.status, problem.code);
  } catch (error) {
    if (error instanceof PlatformNotificationsError) throw error;
    throw new PlatformNotificationsError();
  }
}

export function buildPlatformNotificationListPath(
  query: PlatformNotificationListQuery = {},
): string {
  let parsed: PlatformNotificationListQuery;
  try {
    parsed = parseNotificationListQuery(query);
  } catch {
    throw new PlatformNotificationsError("invalid_input");
  }
  const parameters = new URLSearchParams({
    pageSize: String(parsed.pageSize ?? 20),
  });
  if (parsed.cursorNotificationId && parsed.cursorOccurredAt) {
    parameters.set("cursorNotificationId", parsed.cursorNotificationId);
    parameters.set("cursorOccurredAt", parsed.cursorOccurredAt);
  }
  return `/v1/platform/notifications?${parameters.toString()}`;
}

export function decodePlatformNotificationPage(
  responsePromise: Promise<Response>,
): Promise<PlatformNotificationPage> {
  return decodeSuccess(responsePromise, parseNotificationPage);
}

export function decodeMarkOwnNotificationRead(
  responsePromise: Promise<Response>,
): Promise<MarkOwnNotificationReadResponse> {
  return decodeSuccess(responsePromise, parseMarkOwnNotificationReadResponse);
}

export function decodeMarkAllOwnNotificationsRead(
  responsePromise: Promise<Response>,
): Promise<MarkAllOwnNotificationsReadResponse> {
  return decodeSuccess(responsePromise, parseMarkAllOwnNotificationsReadResponse);
}

export function parseNotificationReadRequest(
  value: unknown,
): MarkOwnNotificationReadBody & { readonly idempotencyKey: string } {
  if (
    !hasExactKeys(value, ["expectedVersion", "idempotencyKey"]) ||
    typeof value.idempotencyKey !== "string" ||
    !UUID_PATTERN.test(value.idempotencyKey)
  ) {
    throw new PlatformNotificationsError("invalid_input");
  }
  try {
    return {
      ...parseMarkOwnNotificationReadBody({ expectedVersion: value.expectedVersion }),
      idempotencyKey: value.idempotencyKey,
    };
  } catch {
    throw new PlatformNotificationsError("invalid_input");
  }
}

export function parseNotificationMarkAllRequest(
  value: unknown,
): MarkAllOwnNotificationsReadBody & { readonly idempotencyKey: string } {
  if (
    !hasExactKeys(value, ["beforeOccurredAt", "expectedUnreadCount", "idempotencyKey"]) ||
    typeof value.idempotencyKey !== "string" ||
    !UUID_PATTERN.test(value.idempotencyKey)
  ) {
    throw new PlatformNotificationsError("invalid_input");
  }
  try {
    return {
      ...parseMarkAllOwnNotificationsReadBody({
        beforeOccurredAt: value.beforeOccurredAt,
        expectedUnreadCount: value.expectedUnreadCount,
      }),
      idempotencyKey: value.idempotencyKey,
    };
  } catch {
    throw new PlatformNotificationsError("invalid_input");
  }
}

export function parseNotificationId(value: unknown): string {
  try {
    return parsePlatformNotificationPath({ notificationId: value }).notificationId;
  } catch {
    throw new PlatformNotificationsError("invalid_input");
  }
}

export function isSameOriginNotificationRequest(request: Request): boolean {
  return isSameOriginPresentationRequest(request);
}
