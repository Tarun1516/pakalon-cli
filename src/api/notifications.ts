/**
 * notifications.ts — In-app notification API client.
 * Wraps GET /notifications, PATCH /notifications/{id}/read, POST /notifications/read-all.
 * Used by ChatScreen to poll for billing reminders and system alerts on startup.
 */
import { getApiClient } from "@/api/client.js";

export interface AppNotification {
  id: string;
  notification_type: string; // "billing_reminder" | "grace_period" | "system" | "announcement"
  title: string;
  body: string;
  action_url: string | null;
  action_label: string | null;
  read: boolean;
  created_at: string;
}

export interface NotificationListResponse {
  notifications: AppNotification[];
  total: number;
  unread_count: number;
}

/**
 * Fetch the user's unread (or all) notifications from the backend.
 * Returns an empty list on auth errors or network failure (non-throwing).
 */
export async function fetchNotifications(
  unreadOnly = true,
  limit = 10,
): Promise<AppNotification[]> {
  try {
    const client = getApiClient();
    const { data } = await client.get<NotificationListResponse>("/notifications", {
      params: { unread_only: unreadOnly, limit },
    });
    return data.notifications ?? [];
  } catch {
    // Silently suppress — notifications are non-critical
    return [];
  }
}

/**
 * Mark a single notification as read. Non-throwing.
 */
export async function markNotificationRead(id: string): Promise<void> {
  try {
    const client = getApiClient();
    await client.patch(`/notifications/${id}/read`);
  } catch {
    // Ignore — read state will be re-synced on next poll
  }
}

/**
 * Mark all notifications as read. Non-throwing.
 */
export async function markAllNotificationsRead(): Promise<void> {
  try {
    const client = getApiClient();
    await client.post("/notifications/read-all");
  } catch {
    // Ignore
  }
}

/**
 * Format a notification for TUI display as an info message.
 * Billing reminders use a ⏰ prefix; grace-period warnings use a ⚠️ prefix.
 */
export function formatNotificationForTUI(n: AppNotification): string {
  const icon =
    n.notification_type === "grace_period"
      ? "⚠️ "
      : n.notification_type === "billing_reminder"
        ? "⏰ "
        : n.notification_type === "system"
          ? "🔔 "
          : "📢 ";

  const lines: string[] = [`${icon}**${n.title}**`, n.body];
  if (n.action_label && n.action_url) {
    lines.push(`\n→ ${n.action_label}: https://pakalon.io${n.action_url}`);
  }
  return lines.join("\n");
}
