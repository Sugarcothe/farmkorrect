import { APPOINTMENTS_UNVERIFIED } from "@/lib/server/appointments";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { NOTES_MAX_BYTES, parseNotesUpdate, saveVisitNotes, toVisitRecord } from "@/lib/server/visits";
import type { VisitRecord, VisitResponse } from "@/lib/vets/visit";

// PUT { notes, expectedVersion }: saves the vet's private clinical notes
// while the visit is in progress. A save based on an older version than the
// stored one is a 409, so newer notes are never silently overwritten. The
// note text is never logged.

type Context = { params: Promise<{ id: string }> };

export const PUT = route<Context>("appointments", async (request, { params }) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, APPOINTMENTS_UNVERIFIED);
  const input = parseNotesUpdate(await readJsonBody(request, NOTES_MAX_BYTES));
  await limitUser("appointmentVisitWritesPerUser", user._id, "Too many saves. Please wait a while and try again.");
  const doc = await saveVisitNotes(user, (await params).id, input);
  return ok<VisitResponse>({ visit: toVisitRecord(doc) as VisitRecord });
});
