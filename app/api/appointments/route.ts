import {
  APPOINTMENTS_UNVERIFIED,
  createAppointment,
  listAppointments,
  parseBooking,
  toAppointment,
} from "@/lib/server/appointments";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import type { AppointmentListResponse, AppointmentResponse } from "@/lib/vets/types";

// GET: the signed-in user's vet appointments, or (?as=vet) the ones booked
// with them. POST: books a vet. Only the service, time, farm location and an
// idempotency key are read; the vet, price and status are decided here.

export const GET = route("appointments", async (request) => {
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  const params = new URL(request.url).searchParams;
  const as = params.get("as") ?? "customer";
  if (as !== "customer" && as !== "vet") throw new HttpError(400, "Unknown view.", { as: "Use customer or vet." });
  await limitUser("appointmentReadsPerUser", user._id);
  return ok<AppointmentListResponse>(await listAppointments(user, as, params.get("cursor")));
});

export const POST = route("appointments", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  const input = parseBooking(await readJsonBody(request));
  await limitUser("appointmentCreatesPerUser", user._id, "Too many bookings. Please wait a while and try again.");
  const { appointment, created } = await createAppointment(user, input);
  return ok<AppointmentResponse>(
    { appointment: await toAppointment(appointment, "customer") },
    { status: created ? 201 : 200 },
  );
});
