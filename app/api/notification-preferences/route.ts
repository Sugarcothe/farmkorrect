import type { PreferencesResponse } from "@/lib/notifications/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import {
  getPreferencesResponse,
  NOTIFICATIONS_UNVERIFIED,
  parsePreferencesUpdate,
  updatePreferences,
} from "@/lib/server/notifications";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in user's notification settings: which external channels
// (email, SMS, push) to use per category. GET also says which channels can
// reach this account at all, and gives the public key for push
// subscriptions. PATCH takes any subset, e.g. { "reviews": { "push": false } }.
// Turning a channel off never deletes anything from the inbox.

export const GET = route("notification-preferences", async (request) => {
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  await limitUser("notificationReadsPerUser", user._id);
  return ok<PreferencesResponse>(await getPreferencesResponse(user));
});

export const PATCH = route("notification-preferences", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, NOTIFICATIONS_UNVERIFIED);
  await limitUser("notificationWritesPerUser", user._id);
  const update = parsePreferencesUpdate(await readJsonBody(request));
  await updatePreferences(user._id, update);
  return ok<PreferencesResponse>(await getPreferencesResponse(user));
});
