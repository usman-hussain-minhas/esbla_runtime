"use client";

import {
  type PlatformNotification,
  type PlatformNotificationPage,
  parseMarkAllOwnNotificationsReadResponse,
  parseMarkOwnNotificationReadResponse,
  parseNotificationPage,
} from "@esbla/contracts";
import Link from "next/link";
import { useState } from "react";
import { notificationMarkAllBeforeOccurredAt } from "../../../../lib/platform-notifications-core";
import { SemanticIcon } from "../semantic-icons";

function stableTime(value: string): string {
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}

function replaceNotification(
  page: PlatformNotificationPage,
  notificationId: string,
  replace: (notification: PlatformNotification) => PlatformNotification,
): PlatformNotificationPage {
  return {
    ...page,
    items: page.items.map((item) =>
      item.notificationId === notificationId ? replace(item) : item,
    ),
  };
}

export function ZenNotificationPanel({
  onPageChange,
  page,
}: Readonly<{
  onPageChange: (update: (current: PlatformNotificationPage) => PlatformNotificationPage) => void;
  page: PlatformNotificationPage;
}>) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<"all" | string>();
  const [loadingMore, setLoadingMore] = useState(false);

  async function markRead(notification: PlatformNotification) {
    if (pending || notification.readAt) return;
    const prior = page;
    const optimisticReadAt = new Date().toISOString();
    setPending(notification.notificationId);
    setError(undefined);
    onPageChange((current) => ({
      ...replaceNotification(current, notification.notificationId, (item) => ({
        ...item,
        readAt: optimisticReadAt,
        rowVersion: item.rowVersion + 1,
      })),
      unreadCount: Math.max(0, current.unreadCount - 1),
    }));
    try {
      const response = await fetch(`/platform/notifications/${notification.notificationId}/read`, {
        body: JSON.stringify({
          expectedVersion: notification.rowVersion,
          idempotencyKey: crypto.randomUUID(),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.status !== 200) throw new Error("mark read failed");
      const result = parseMarkOwnNotificationReadResponse(await response.json());
      onPageChange((current) =>
        replaceNotification(current, notification.notificationId, () => result.notification),
      );
    } catch {
      onPageChange(() => prior);
      setError("That notification could not be marked as read. Your previous state was restored.");
    } finally {
      setPending(undefined);
    }
  }

  async function markAllRead() {
    if (pending || page.unreadCount === 0) return;
    const prior = page;
    const beforeOccurredAt = notificationMarkAllBeforeOccurredAt(page);
    if (!beforeOccurredAt) return;
    setPending("all");
    setError(undefined);
    onPageChange((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.readAt
          ? item
          : {
              ...item,
              readAt: beforeOccurredAt,
              rowVersion: item.rowVersion + 1,
            },
      ),
      unreadCount: 0,
    }));
    try {
      let remaining = prior.unreadCount;
      while (remaining > 0) {
        const response = await fetch("/platform/notifications/mark-all-read", {
          body: JSON.stringify({
            beforeOccurredAt,
            expectedUnreadCount: remaining,
            idempotencyKey: crypto.randomUUID(),
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (response.status !== 200) throw new Error("mark all failed");
        const result = parseMarkAllOwnNotificationsReadResponse(await response.json());
        if (result.remainingUnreadCount >= remaining) {
          throw new Error("mark all did not advance");
        }
        remaining = result.remainingUnreadCount;
      }
    } catch {
      onPageChange(() => prior);
      setError("Notifications could not be marked as read. Your previous state was restored.");
    } finally {
      setPending(undefined);
    }
  }

  async function loadMore() {
    if (!page.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const parameters = new URLSearchParams({
        cursorNotificationId: page.nextCursor.notificationId,
        cursorOccurredAt: page.nextCursor.occurredAt,
        pageSize: "20",
      });
      const response = await fetch(`/platform/notifications?${parameters.toString()}`);
      if (response.status !== 200) throw new Error("load more failed");
      const next = parseNotificationPage(await response.json());
      onPageChange((current) => {
        const known = new Set(current.items.map(({ notificationId }) => notificationId));
        return {
          items: [
            ...current.items,
            ...next.items.filter(({ notificationId }) => !known.has(notificationId)),
          ],
          nextCursor: next.nextCursor,
          unreadCount: next.unreadCount,
        };
      });
    } catch {
      setError("More notifications could not be loaded. No private error detail is shown.");
    } finally {
      setLoadingMore(false);
    }
  }

  if (page.items.length === 0) {
    return (
      <div className="zen-notification-empty">
        <SemanticIcon aria-hidden="true" semanticKey="bell" size={22} />
        <strong>You’re all caught up</strong>
        <p>New HR activity will appear here when it needs your attention.</p>
      </div>
    );
  }

  return (
    <div className="zen-notification-panel">
      <div className="zen-notification-toolbar">
        <p aria-live="polite">
          {page.unreadCount === 0
            ? "No unread notifications"
            : `${page.unreadCount} unread notification${page.unreadCount === 1 ? "" : "s"}`}
        </p>
        <button
          className="panel-text-command"
          disabled={Boolean(pending) || page.unreadCount === 0}
          onClick={markAllRead}
          type="button"
        >
          {pending === "all" ? "Marking…" : "Mark all read"}
        </button>
      </div>
      <ol className="zen-notification-list">
        {page.items.map((notification) => (
          <li
            className={notification.readAt ? "is-read" : "is-unread"}
            key={notification.notificationId}
          >
            <div className="zen-notification-copy">
              {notification.target.available ? (
                <Link href={notification.target.href} prefetch={false}>
                  <strong>{notification.title}</strong>
                </Link>
              ) : (
                <strong>{notification.title}</strong>
              )}
              <p>{notification.summary}</p>
              <time dateTime={notification.occurredAt}>{stableTime(notification.occurredAt)}</time>
              {!notification.target.available ? (
                <span className="zen-notification-target-unavailable">
                  The related item is no longer available.
                </span>
              ) : null}
            </div>
            {notification.readAt ? (
              <span className="zen-notification-read-state">Read</span>
            ) : (
              <button
                aria-label={`Mark “${notification.title}” as read`}
                className="zen-notification-read-command"
                disabled={Boolean(pending)}
                onClick={() => markRead(notification)}
                type="button"
              >
                {pending === notification.notificationId ? "Saving…" : "Mark read"}
              </button>
            )}
          </li>
        ))}
      </ol>
      {page.nextCursor ? (
        <button
          className="panel-text-command zen-notification-more"
          disabled={loadingMore}
          onClick={loadMore}
          type="button"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
      {error ? (
        <p className="panel-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
