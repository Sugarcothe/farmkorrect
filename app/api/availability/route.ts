import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { availabilityResponse, parseAvailability, requireVet, saveAvailability } from "@/lib/server/vet-availability";
import type { AvailabilityResponse } from "@/lib/vets/types";

// The signed-in veterinarian's booking settings: whether they're listed in
// Find a Vet, where and when they work, and days off. PUT replaces them all.

const UNVERIFIED = "Verify your phone number before managing your availability.";

export const GET = route("availability", async (request) => {
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  requireVet(user);
  return ok<AvailabilityResponse>(await availabilityResponse(user));
});

export const PUT = route("availability", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  requireVet(user);
  const settings = parseAvailability(await readJsonBody(request));
  await limitUser("availabilityChangesPerUser", user._id, "Too many changes. Please wait a while and try again.");
  await saveAvailability(user, settings);
  return ok<AvailabilityResponse>(await availabilityResponse(user));
});
