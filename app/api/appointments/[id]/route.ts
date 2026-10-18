import {
  APPOINTMENT_NOT_FOUND,
  APPOINTMENTS_UNVERIFIED,
  getAppointment,
  parseTransition,
  toAppointment,
  transitionAppointment,
} from "@/lib/server/appointments";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import type { AppointmentResponse } from "@/lib/vets/types";

// One appointment, for its customer or its vet only (anyone else gets a 404).
// PATCH moves it on with { action, expectedStatus, reason? }. The server
// decides who may do what and when; a status that already changed is a 409.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("appointments", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  await limitUser("appointmentReadsPerUser", user._id);
  const appointment = await getAppointment(user, (await params).id);
  if (!appointment) throw new HttpError(404, APPOINTMENT_NOT_FOUND);
  return ok<AppointmentResponse>({ appointment });
});

export const PATCH = route<Context>("appointments", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  const input = parseTransition(await readJsonBody(request));
  await limitUser("appointmentActionsPerUser", user._id, "Too many changes. Please wait a while and try again.");
  const { doc, viewer } = await transitionAppointment(user, (await params).id, input);
  return ok<AppointmentResponse>({ appointment: await toAppointment(doc, viewer) });
});
