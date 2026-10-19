import { APPOINTMENTS_UNVERIFIED } from "@/lib/server/appointments";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parseChecklistUpdate, toVisitRecord, updateChecklist } from "@/lib/server/visits";
import type { VisitRecord, VisitResponse } from "@/lib/vets/visit";

// POST { itemId, done }: ticks or clears one item on the visit checklist.
// Only the appointment's vet, only while the visit is in progress; the
// item must be on this visit's own snapshot. Repeating it changes nothing.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("appointments", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  const input = parseChecklistUpdate(await readJsonBody(request));
  await limitUser("appointmentVisitWritesPerUser", user._id, "Too many changes. Please wait a while and try again.");
  const doc = await updateChecklist(user, (await params).id, input);
  return ok<VisitResponse>({ visit: toVisitRecord(doc) as VisitRecord });
});
