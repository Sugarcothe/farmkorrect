import type { Notification } from "@/lib/notifications/types";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { NOTIFICATIONS_UNVERIFIED, setRead, unreadCount } from "@/lib/server/notifications";
import { limitUser } from "@/lib/server/order-access";
import { parseObjectId } from "@/lib/server/products";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// PATCH { read: true | false } marks one of the signed-in user's
// notifications read or unread. Someone else's notification (or a made-up
// id) is a 404, exactly like one that doesn't exist.

type Context = { params: Promise<{ id: string }> };

const NOT_FOUND = "We couldn't find that notification.";

export const PATCH = route<Context>("notifications", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  await limitUser("notificationWritesPerUser", user._id);
  const body = await readJsonBody(request);
  const extra = Object.keys(body).some((key) => key !== "read");
  if (typeof body.read !== "boolean" || extra)
    throw new HttpError(400, "Send { read: true } or { read: false }.", {
      read: typeof body.read !== "boolean" ? "Must be true or false." : "Only read can be changed.",
    });
  const id = parseObjectId((await params).id);
  if (!id) throw new HttpError(404, NOT_FOUND);
  const notification = await setRead(user._id, id, body.read);
  if (!notification) throw new HttpError(404, NOT_FOUND);
  return ok<{ notification: Notification; unreadCount: number }>({
    notification,
    unreadCount: await unreadCount(user._id),
  });
});
