import { assertSameOrigin, ok, route } from "@/lib/server/http";
import { markAllRead, NOTIFICATIONS_UNVERIFIED, unreadCount } from "@/lib/server/notifications";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// Marks all of the signed-in user's notifications read.

export const POST = route("notifications", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  await limitUser("notificationWritesPerUser", user._id);
  const updated = await markAllRead(user._id);
  return ok<{ updated: number; unreadCount: number }>({ updated, unreadCount: await unreadCount(user._id) });
});
