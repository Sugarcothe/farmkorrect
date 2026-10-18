import { expireLapsed } from "@/lib/server/appointments";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { heldFor, SLOT_DAYS, slotDays } from "@/lib/server/vet-availability";
import { findBookableVet, VET_NOT_FOUND, VETS_UNVERIFIED } from "@/lib/server/vet-directory";
import { isDateString, lagosDate, lastBookableDate } from "@/lib/vets/schedule";
import type { SlotsResponse } from "@/lib/vets/types";

// Open start times for one of a vet's bookable services, for SLOT_DAYS days
// from `from` (a Lagos date, default today). Computed from the vet's
// current hours and the time already held; booking checks again.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("vets/slots", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, VETS_UNVERIFIED);
  const search = new URL(request.url).searchParams;
  const now = new Date();
  const today = lagosDate(now);
  const from = search.get("from") ?? today;
  if (!isDateString(from) || from < today || from > lastBookableDate(now))
    throw new HttpError(400, "Choose a date within the booking window.", { from: "Choose a date within the booking window." });
  await limitUser("vetSlotReadsPerUser", user._id, "Too many requests. Please wait a moment and try again.");

  const vet = await findBookableVet((await params).id);
  if (!vet) throw new HttpError(404, VET_NOT_FOUND);
  const service = vet.services.find((s) => s._id.toHexString() === search.get("service"));
  if (!service) throw new HttpError(404, "That service isn't open for booking.");
  await expireLapsed({ vetUserId: vet.user._id }, 20, now);
  const held = await heldFor(vet.user._id, from, SLOT_DAYS);
  return ok<SlotsResponse>({ days: slotDays(vet.settings, service, from, held, now) });
});
