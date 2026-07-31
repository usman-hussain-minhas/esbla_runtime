import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_MARK_ALL_BATCH_SIZE,
  NOTIFICATION_MAXIMUM_PAGE_SIZE,
  NOTIFICATION_POLICY_V1,
  parseMarkAllOwnNotificationsReadBody,
  parseMarkAllOwnNotificationsReadResponse,
  parseMarkOwnNotificationReadBody,
  parseMarkOwnNotificationReadResponse,
  parseNotificationListQuery,
  parseNotificationPage,
  parsePlatformNotificationPath,
  platformNotificationListQuerySchema,
  platformNotificationMarkAllReadBodySchema,
  platformNotificationMarkAllReadResponseSchema,
  platformNotificationMarkReadBodySchema,
  platformNotificationMarkReadResponseSchema,
  platformNotificationPageSchema,
  platformNotificationPathSchema,
} from "./platform-notification-api.js";

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

describe("platform notification API contracts", () => {
  it("freezes the ratified projector and bounded API constants", () => {
    expect(NOTIFICATION_POLICY_V1).toEqual({
      backoffCapSeconds: 900,
      batchSize: 100,
      consumerKey: "platform.notifications.projector",
      consumerVersion: 1,
      idlePollMs: 1_000,
      maximumAttempts: 8,
      projectionRetentionDays: 90,
      shutdownJoinMs: 10_000,
    });
    expect(NOTIFICATION_MAXIMUM_PAGE_SIZE).toBe(50);
    expect(NOTIFICATION_MARK_ALL_BATCH_SIZE).toBe(100);
  });

  it("parses exact list cursors and rejects partial or additional input", () => {
    expect(parseNotificationListQuery({})).toEqual({});
    expect(parseNotificationListQuery({ pageSize: 20 })).toEqual({ pageSize: 20 });
    expect(
      parseNotificationListQuery({
        cursorNotificationId: notification.notificationId,
        cursorOccurredAt: notification.occurredAt,
        pageSize: 50,
      }),
    ).toEqual({
      cursorNotificationId: notification.notificationId,
      cursorOccurredAt: notification.occurredAt,
      pageSize: 50,
    });
    for (const invalid of [
      { cursorNotificationId: notification.notificationId },
      { cursorOccurredAt: notification.occurredAt },
      { pageSize: 0 },
      { pageSize: 51 },
      { pageSize: 20, surprise: true },
    ]) {
      expect(() => parseNotificationListQuery(invalid)).toThrow();
    }
  });

  it("parses a least-sensitive own page and exact current target result", () => {
    const page = {
      items: [notification],
      nextCursor: {
        notificationId: notification.notificationId,
        occurredAt: notification.occurredAt,
      },
      unreadCount: 1,
    };
    expect(parseNotificationPage(page)).toEqual(page);
    const unavailableTarget = {
      available: false,
      href: null,
      kind: null,
      resourceId: null,
    } as const;
    expect(
      parseNotificationPage({
        items: [{ ...notification, target: unavailableTarget }],
        nextCursor: null,
        unreadCount: 0,
      }).items[0]?.target,
    ).toEqual(unavailableTarget);
    expect(() =>
      parseNotificationPage({
        ...page,
        items: [{ ...notification, rejectionNote: "restricted" }],
      }),
    ).toThrow();
    expect(() =>
      parseNotificationPage({
        ...page,
        items: [
          {
            ...notification,
            target: { ...notification.target, href: "https://outside.example/leave" },
          },
        ],
      }),
    ).toThrow();
    const directReportsTarget = {
      available: true,
      href: "/workspace/hr/profile/direct-reports",
      kind: "hr.workforce_profile.direct_reports",
      resourceId: null,
    } as const;
    expect(
      parseNotificationPage({
        ...page,
        items: [{ ...notification, target: directReportsTarget }],
      }).items[0]?.target,
    ).toEqual(directReportsTarget);
  });

  it("parses exact mark-read and bounded mark-all commands and responses", () => {
    expect(parsePlatformNotificationPath({ notificationId: notification.notificationId })).toEqual({
      notificationId: notification.notificationId,
    });
    expect(() =>
      parsePlatformNotificationPath({
        notificationId: notification.notificationId,
        surprise: true,
      }),
    ).toThrow();
    expect(parseMarkOwnNotificationReadBody({ expectedVersion: 1 })).toEqual({
      expectedVersion: 1,
    });
    expect(() =>
      parseMarkOwnNotificationReadBody({ expectedVersion: 1, notificationId: "extra" }),
    ).toThrow();
    expect(
      parseMarkAllOwnNotificationsReadBody({
        beforeOccurredAt: "2026-07-31T10:05:00.000Z",
        expectedUnreadCount: 3,
      }),
    ).toEqual({
      beforeOccurredAt: "2026-07-31T10:05:00.000Z",
      expectedUnreadCount: 3,
    });
    expect(() =>
      parseMarkAllOwnNotificationsReadBody({
        beforeOccurredAt: "not-a-time",
        expectedUnreadCount: 3,
      }),
    ).toThrow();

    const one = {
      billingState: "non_billable",
      evidenceEventId: "50000000-0000-4000-8000-000000000001",
      notification: { ...notification, readAt: "2026-07-31T10:06:00.000Z", rowVersion: 2 },
      replayed: false,
    };
    expect(parseMarkOwnNotificationReadResponse(one)).toEqual(one);

    const all = {
      billingState: "non_billable",
      evidenceEventId: "50000000-0000-4000-8000-000000000002",
      remainingUnreadCount: 0,
      replayed: false,
      updatedCount: 3,
    };
    expect(parseMarkAllOwnNotificationsReadResponse(all)).toEqual(all);
  });

  it("publishes strict Fastify schemas for every own notification route", () => {
    expect(platformNotificationListQuerySchema.$id).toBe("PlatformNotificationListQueryV1");
    expect(platformNotificationPageSchema.$id).toBe("PlatformNotificationPageV1");
    expect(platformNotificationPathSchema.$id).toBe("PlatformNotificationPathV1");
    expect(platformNotificationMarkReadBodySchema.$id).toBe("PlatformNotificationMarkReadBodyV1");
    expect(platformNotificationMarkReadResponseSchema.$id).toBe(
      "PlatformNotificationMarkReadResponseV1",
    );
    expect(platformNotificationMarkAllReadBodySchema.$id).toBe(
      "PlatformNotificationMarkAllReadBodyV1",
    );
    expect(platformNotificationMarkAllReadResponseSchema.$id).toBe(
      "PlatformNotificationMarkAllReadResponseV1",
    );
  });
});
