import { describe, expect, it } from "vitest";
import {
  buildPlatformNotificationListPath,
  decodeMarkOwnNotificationRead,
  decodePlatformNotificationPage,
  isSameOriginNotificationRequest,
  notificationMarkAllBeforeOccurredAt,
  PlatformNotificationsError,
  parseNotificationMarkAllRequest,
  parseNotificationReadRequest,
} from "./platform-notifications-core";

const notification = {
  category: "hr.leave_request",
  createdAt: "2026-07-31T10:01:00.000Z",
  notificationId: "40000000-0000-4000-8000-000000000001",
  occurredAt: "2026-07-31T10:00:00.000Z",
  readAt: null,
  retentionStatus: "active",
  rowVersion: 1,
  sourceService: "hr.leave_request",
  summary: "Open the leave request for details.",
  target: {
    available: true,
    href: "/workspace/hr/leave/30000000-0000-4000-8000-000000000001",
    kind: "hr.leave_request.detail",
    resourceId: "30000000-0000-4000-8000-000000000001",
  },
  title: "A leave request needs your review",
} as const;

function response(body: unknown, status = 200, contentType = "application/json") {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": contentType },
      status,
    }),
  );
}

describe("platform notifications web boundary", () => {
  it("builds exact bounded first and cursor pages", () => {
    expect(buildPlatformNotificationListPath()).toBe("/v1/platform/notifications?pageSize=20");
    expect(
      buildPlatformNotificationListPath({
        cursorNotificationId: notification.notificationId,
        cursorOccurredAt: notification.occurredAt,
        pageSize: 50,
      }),
    ).toBe(
      `/v1/platform/notifications?pageSize=50&cursorNotificationId=${notification.notificationId}&cursorOccurredAt=2026-07-31T10%3A00%3A00.000Z`,
    );
    expect(() =>
      buildPlatformNotificationListPath({
        cursorNotificationId: notification.notificationId,
      }),
    ).toThrow(PlatformNotificationsError);
  });

  it("accepts only exact successful JSON and strict Problem Details", async () => {
    const page = { items: [notification], nextCursor: null, unreadCount: 1 };
    await expect(decodePlatformNotificationPage(response(page))).resolves.toEqual(page);
    await expect(
      decodePlatformNotificationPage(response(page, 200, "text/html")),
    ).rejects.toMatchObject({ kind: "unavailable" });
    await expect(
      decodePlatformNotificationPage(
        response(
          {
            code: "POLICY_DENIED",
            detail: "Denied",
            instance: "/v1/platform/notifications",
            requestId: "50000000-0000-4000-8000-000000000001",
            status: 403,
            title: "Forbidden",
            type: "about:blank",
          },
          403,
          "application/problem+json",
        ),
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("parses strict same-origin mutation envelopes and responses", async () => {
    const idempotencyKey = "50000000-0000-4000-8000-000000000001";
    expect(parseNotificationReadRequest({ expectedVersion: 1, idempotencyKey })).toEqual({
      expectedVersion: 1,
      idempotencyKey,
    });
    expect(
      parseNotificationMarkAllRequest({
        beforeOccurredAt: "2026-07-31T10:03:00.000Z",
        expectedUnreadCount: 2,
        idempotencyKey,
      }),
    ).toEqual({
      beforeOccurredAt: "2026-07-31T10:03:00.000Z",
      expectedUnreadCount: 2,
      idempotencyKey,
    });
    expect(() =>
      parseNotificationReadRequest({ expectedVersion: 1, idempotencyKey, extra: true }),
    ).toThrow();

    const read = {
      billingState: "non_billable",
      evidenceEventId: "60000000-0000-4000-8000-000000000001",
      notification: {
        ...notification,
        readAt: "2026-07-31T10:03:00.000Z",
        rowVersion: 2,
      },
      replayed: false,
    };
    await expect(decodeMarkOwnNotificationRead(response(read))).resolves.toEqual(read);
  });

  it("uses the server-issued newest event as the mark-all horizon", () => {
    expect(
      notificationMarkAllBeforeOccurredAt({
        items: [notification],
        nextCursor: null,
        unreadCount: 1,
      }),
    ).toBe(notification.occurredAt);
    expect(
      notificationMarkAllBeforeOccurredAt({
        items: [],
        nextCursor: null,
        unreadCount: 0,
      }),
    ).toBeUndefined();
    expect(() =>
      notificationMarkAllBeforeOccurredAt({
        items: [],
        nextCursor: null,
        unreadCount: 1,
      }),
    ).toThrow(PlatformNotificationsError);
  });

  it("fails closed on cross-origin or browser-cross-site mutations", () => {
    expect(
      isSameOriginNotificationRequest(
        new Request("https://app.example/platform/notifications", {
          headers: {
            origin: "https://app.example",
            "sec-fetch-site": "same-origin",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginNotificationRequest(
        new Request("https://app.example/platform/notifications", {
          headers: {
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isSameOriginNotificationRequest(
        new Request("http://localhost:3000/platform/notifications", {
          headers: {
            host: "127.0.0.1:41902",
            origin: "http://127.0.0.1:41902",
            "sec-fetch-site": "same-origin",
          },
        }),
      ),
    ).toBe(true);
  });
});
