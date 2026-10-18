import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import {
  createServiceBooking,
  listServiceBookings,
  parseServiceBooking,
  SERVICE_BOOKINGS_UNVERIFIED,
  toServiceBooking,
} from "@/lib/server/service-bookings";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import type { ServiceBookingListResponse, ServiceBookingResponse } from "@/lib/services/marketplace";

// GET: the signed-in user's service bookings, or (?as=provider) the jobs
// booked with them. POST: books a marketplace service. Only the service,
// date, location, contact preference, notes, the category's own fields and
// an idempotency key are read; the provider, price and status are decided here.

export const GET = route("service-bookings", async (request) => {
  const { user } = await requireVerifiedRequest(request, SERVICE_BOOKINGS_UNVERIFIED);
  const params = new URL(request.url).searchParams;
  const as = params.get("as") ?? "customer";
  if (as !== "customer" && as !== "provider")
    throw new HttpError(400, "Unknown view.", { as: "Use customer or provider." });
  await limitUser("serviceBookingReadsPerUser", user._id);
  return ok<ServiceBookingListResponse>(await listServiceBookings(user, as, params.get("cursor")));
});

export const POST = route("service-bookings", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, SERVICE_BOOKINGS_UNVERIFIED);
  const input = parseServiceBooking(await readJsonBody(request));
  await limitUser("serviceBookingCreatesPerUser", user._id, "Too many bookings. Please wait a while and try again.");
  const { booking, created } = await createServiceBooking(user, input);
  return ok<ServiceBookingResponse>(
    { booking: await toServiceBooking(booking, "customer") },
    { status: created ? 201 : 200 },
  );
});
