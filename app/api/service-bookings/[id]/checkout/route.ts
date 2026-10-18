import { assertSameOrigin, HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { BOOKING_NOT_FOUND, findOwnServiceBooking, SERVICE_BOOKINGS_UNVERIFIED } from "@/lib/server/service-bookings";
import { checkoutBooking } from "@/lib/server/service-payments";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import type { ServiceCheckoutResponse } from "@/lib/services/marketplace";

// Starts (or resumes) paying for the customer's own booking. Takes no body:
// the amount is the booking's own agreed price, set by the server.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("service-bookings", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, SERVICE_BOOKINGS_UNVERIFIED);
  await limitUser("serviceBookingActionsPerUser", user._id, "Too many attempts. Please wait a while and try again.");
  const found = await findOwnServiceBooking(user, (await params).id);
  if (!found || found.viewer !== "customer") throw new HttpError(404, BOOKING_NOT_FOUND);
  return ok<ServiceCheckoutResponse>(await checkoutBooking(found.doc, user));
});
