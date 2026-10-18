import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import {
  BOOKING_NOT_FOUND,
  findOwnServiceBooking,
  SERVICE_BOOKINGS_UNVERIFIED,
  toServiceBooking,
} from "@/lib/server/service-bookings";
import { verifyBookingPayment } from "@/lib/server/service-payments";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import type { ServiceVerifyResponse } from "@/lib/services/marketplace";

// Called when the customer comes back from Paystack. Returning proves
// nothing: the payment is looked up with Paystack and checked against the
// booking before anything changes. `reference` is optional and only used if
// it's one of this booking's own payment attempts.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("service-bookings", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, SERVICE_BOOKINGS_UNVERIFIED);
  const body = await readJsonBody(request);
  await limitUser("serviceBookingActionsPerUser", user._id, "Too many attempts. Please wait a while and try again.");
  const { id } = await params;
  const found = await findOwnServiceBooking(user, id);
  if (!found || found.viewer !== "customer") throw new HttpError(404, BOOKING_NOT_FOUND);
  const result = await verifyBookingPayment(found.doc, typeof body.reference === "string" ? body.reference : null);
  const after = (await findOwnServiceBooking(user, id))?.doc ?? found.doc;
  return ok<ServiceVerifyResponse>({ result, booking: await toServiceBooking(after, "customer") });
});
