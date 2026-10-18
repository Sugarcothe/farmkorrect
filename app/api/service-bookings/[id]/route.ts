import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import {
  BOOKING_NOT_FOUND,
  getServiceBooking,
  parseServiceTransition,
  SERVICE_BOOKINGS_UNVERIFIED,
  toServiceBooking,
  transitionServiceBooking,
} from "@/lib/server/service-bookings";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import type { ServiceBookingResponse } from "@/lib/services/marketplace";

// One service booking, for its customer or its provider only (anyone else
// gets a 404). PATCH moves it on with { action, expectedStatus, reason?,
// quote? }. The server decides who may do what and when; a status that
// already changed is a 409.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("service-bookings", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, SERVICE_BOOKINGS_UNVERIFIED);
  await limitUser("serviceBookingReadsPerUser", user._id);
  const found = await getServiceBooking(user, (await params).id);
  if (!found) throw new HttpError(404, BOOKING_NOT_FOUND);
  return ok<ServiceBookingResponse>({ booking: found.booking });
});

export const PATCH = route<Context>("service-bookings", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, SERVICE_BOOKINGS_UNVERIFIED);
  const input = parseServiceTransition(await readJsonBody(request));
  await limitUser("serviceBookingActionsPerUser", user._id, "Too many changes. Please wait a while and try again.");
  const { doc, viewer } = await transitionServiceBooking(user, (await params).id, input);
  return ok<ServiceBookingResponse>({ booking: await toServiceBooking(doc, viewer) });
});
