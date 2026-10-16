import type { NotificationPage } from "@/lib/notifications/types";
import { ok, route } from "@/lib/server/http";
import { listNotifications, NOTIFICATIONS_UNVERIFIED, parseInboxQuery } from "@/lib/server/notifications";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in user's inbox, newest first: ?filter=all|unread,
// ?category=<category>, ?page=<n>. Only the session's own notifications are
// ever read. There's no POST: notifications can't be created through the
// API, only by the server from events it has recorded.

export const GET = route("notifications", async (request) => {
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  await limitUser("notificationReadsPerUser", user._id);
  const query = parseInboxQuery(new URL(request.url).searchParams);
  return ok<NotificationPage>(await listNotifications(user._id, query));
});
