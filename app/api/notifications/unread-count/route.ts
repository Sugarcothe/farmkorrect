import type { UnreadCount } from "@/lib/notifications/types";
import { ok, route } from "@/lib/server/http";
import { NOTIFICATIONS_UNVERIFIED, unreadCount } from "@/lib/server/notifications";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The number behind the bell: one indexed count, never cached.

export const GET = route("notifications", async (request) => {
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  await limitUser("notificationReadsPerUser", user._id);
  return ok<UnreadCount>({ unreadCount: await unreadCount(user._id) });
});
