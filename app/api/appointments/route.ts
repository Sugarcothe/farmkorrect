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
import { isJobTab, type AppointmentListResponse, type AppointmentResponse } from "@/lib/vets/types";

// GET: the signed-in user's vet appointments, or (?as=vet) the ones booked
// with them, optionally one job tab (?as=vet&tab=pending|active|completed|closed). POST: books a vet. Only the service, time, farm location and an
// idempotency key are read; the vet, price and status are decided here.

export const GET = route("appointments", async (request) => {
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  const params = new URL(request.url).searchParams;
  const as = params.get("as") ?? "customer";
  if (as !== "customer" && as !== "vet") throw new HttpError(400, "Unknown view.", { as: "Use customer or vet." });
  const tab = params.get("tab");
  if (tab !== null && (as !== "vet" || !isJobTab(tab)))
    throw new HttpError(400, "Unknown view.", { tab: "Use pending, active, completed or closed with as=vet." });
  await limitUser("appointmentReadsPerUser", user._id);
  return ok<AppointmentListResponse>(
    await listAppointments(user, as, params.get("cursor"), new Date(), tab as Parameters<typeof listAppointments>[4]),
  );
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
