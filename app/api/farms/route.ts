import type { FarmResponse } from "@/lib/auth/types";
import { saveInitialFarm, toFarm } from "@/lib/server/farms";
import { assertSameOrigin, HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { getRequestSession, isFullyAuthenticated } from "@/lib/server/sessions";
import { parseFarm } from "@/lib/server/validation";

// Saves the signed-in user's farm profile. The owner is always the session's
// account: ownership, roles and verification flags in the body are ignored.
// Resubmitting updates the same profile instead of creating another.
export const POST = route("farms", async (request) => {
  assertSameOrigin(request);
  const active = await getRequestSession(request);
  if (!active) throw new HttpError(401, "Your session has ended. Please log in again.");
  if (!isFullyAuthenticated(active))
    throw new HttpError(403, "Verify your phone number before setting up your farm.");

  const input = parseFarm(await readJsonBody(request));
  const { farm, created } = await saveInitialFarm(active.user._id, input);
  return ok<FarmResponse>({ farm: toFarm(farm) }, { status: created ? 201 : 200 });
});
