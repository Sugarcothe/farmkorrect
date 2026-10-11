import type { SessionResponse } from "@/lib/auth/types";
import { findInitialFarm } from "@/lib/server/farms";
import { HttpError, ok, route } from "@/lib/server/http";
import { getRequestSession, isFullyAuthenticated } from "@/lib/server/sessions";
import { toSessionUser } from "@/lib/server/users";

// Who is signed in, for the UI. Only profile fields go out — never hashes,
// session tokens or internal ids.
export const GET = route("session", async (request) => {
  const active = await getRequestSession(request);
  if (!isFullyAuthenticated(active)) throw new HttpError(401, "You're not signed in.");
  return ok<SessionResponse>({
    user: toSessionUser(active.user),
    farmSetupComplete: (await findInitialFarm(active.user._id)) !== null,
  });
});
