import { getWebPushConfig } from "@/lib/server/config";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import {
  NOTIFICATIONS_UNVERIFIED,
  parsePushSubscription,
  removePushSubscription,
  savePushSubscription,
} from "@/lib/server/notifications";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// This browser's push subscription for the signed-in user. POST saves a
// PushSubscription (subscription.toJSON()); DELETE { endpoint } removes it,
// only if it belongs to this account. Endpoints are never returned or logged.

const LIMITED = "Too many push setting changes. Please wait a while and try again.";

export const POST = route("push-subscriptions", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  if (!getWebPushConfig()) throw new HttpError(503, "Push notifications aren't available yet.");
  await limitUser("pushSubscriptionChangesPerUser", user._id, LIMITED);
  const input = parsePushSubscription(await readJsonBody(request));
  await savePushSubscription(user._id, input);
  return ok<{ subscribed: true }>({ subscribed: true }, { status: 201 });
});

export const DELETE = route("push-subscriptions", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  await limitUser("pushSubscriptionChangesPerUser", user._id, LIMITED);
  const body = await readJsonBody(request);
  const endpoint = body.endpoint;
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 1000 || Object.keys(body).length !== 1)
    throw new HttpError(400, "Send the endpoint to remove.", { endpoint: "Invalid push endpoint." });
  await removePushSubscription(user._id, endpoint);
  // the same answer whether or not it existed, so endpoints can't be probed
  return ok<{ subscribed: false }>({ subscribed: false });
});
