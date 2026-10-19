import { APPOINTMENTS_UNVERIFIED } from "@/lib/server/appointments";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { findVetAppointment, toVisitRecord, VISIT_NOT_FOUND } from "@/lib/server/visits";
import type { VisitResponse } from "@/lib/vets/visit";

// The visit record (checklist and private clinical notes) of an appointment
// that has started, for its own vet only. The customer, other vets and
// anyone signed out get a 404, the same as for an unknown id.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("appointments", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  await limitUser("appointmentReadsPerUser", user._id);
  const visit = toVisitRecord(await findVetAppointment(user, (await params).id));
  if (!visit) throw new HttpError(404, VISIT_NOT_FOUND);
  return ok<VisitResponse>({ visit });
});
