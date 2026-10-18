import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { getVetProfile, VET_NOT_FOUND, VETS_UNVERIFIED } from "@/lib/server/vet-directory";
import type { VetProfile } from "@/lib/vets/types";

// A listed vet's public profile and bookable services. Unlisted,
// unverified and unknown vets all get the same 404.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("vets", async (request, { params }) => {
  const { user } = await requireVerifiedRequest(request, VETS_UNVERIFIED);
  await limitUser("vetSearchesPerUser", user._id, "Too many requests. Please wait a moment and try again.");
  const vet = await getVetProfile((await params).id);
  if (!vet) throw new HttpError(404, VET_NOT_FOUND);
  return ok<{ vet: VetProfile }>({ vet });
});
