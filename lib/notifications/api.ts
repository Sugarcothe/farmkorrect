import { request } from "@/lib/auth/api";
import type { Notification, PreferencesResponse, PreferencesUpdate, UnreadCount } from "./types";

// Browser-side calls for notifications. The session cookie decides whose
// notifications these are; the browser can only read them, mark them read
// and change preferences — never create one.

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getUnreadCount = () => request<UnreadCount>("/api/notifications/unread-count", { method: "GET" });

export const markNotificationRead = (id: string, read: boolean) =>
  request<{ notification: Notification; unreadCount: number }>(
    `/api/notifications/${encodeURIComponent(id)}`,
    json("PATCH", { read }),
  );

export const markAllNotificationsRead = () =>
  request<{ updated: number; unreadCount: number }>("/api/notifications/read-all", json("POST", {}));

export const getNotificationPreferences = () =>
  request<PreferencesResponse>("/api/notification-preferences", { method: "GET" });

export const updateNotificationPreferences = (body: PreferencesUpdate) =>
  request<PreferencesResponse>("/api/notification-preferences", json("PATCH", body));

export const savePushSubscription = (subscription: PushSubscriptionJSON) =>
  request<{ subscribed: true }>("/api/push-subscriptions", json("POST", subscription));

export const removePushSubscription = (endpoint: string) =>
  request<{ subscribed: false }>("/api/push-subscriptions", json("DELETE", { endpoint }));
