import "server-only";

import type {
  MarkAllOwnNotificationsReadBody,
  MarkOwnNotificationReadBody,
  PlatformNotificationListQuery,
} from "@esbla/contracts";
import { fetchDevelopmentApi } from "./development-session";
import {
  buildPlatformNotificationListPath,
  decodeMarkAllOwnNotificationsRead,
  decodeMarkOwnNotificationRead,
  decodePlatformNotificationPage,
  parseNotificationId,
} from "./platform-notifications-core";

export function loadOwnNotifications(query: PlatformNotificationListQuery = {}) {
  return decodePlatformNotificationPage(
    fetchDevelopmentApi({
      method: "GET",
      path: buildPlatformNotificationListPath(query),
    }),
  );
}

export function persistOwnNotificationRead(
  notificationId: string,
  body: MarkOwnNotificationReadBody,
  idempotencyKey: string,
) {
  const exactId = parseNotificationId(notificationId);
  return decodeMarkOwnNotificationRead(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: `/v1/platform/notifications/${exactId}/read`,
    }),
  );
}

export function persistAllOwnNotificationsRead(
  body: MarkAllOwnNotificationsReadBody,
  idempotencyKey: string,
) {
  return decodeMarkAllOwnNotificationsRead(
    fetchDevelopmentApi({
      body,
      idempotencyKey,
      method: "POST",
      path: "/v1/platform/notifications/mark-all-read",
    }),
  );
}
