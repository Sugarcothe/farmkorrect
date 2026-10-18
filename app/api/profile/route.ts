import type { ProfileResponse } from "@/lib/profile/types";
import { assertSameOrigin, ok, readJsonBody, route } from "@/lib/server/http";
import { getProfile, updateProfile } from "@/lib/server/profile";
import { requireVerifiedRequest } from "@/lib/server/sessions";
import { parseProfileUpdate } from "@/lib/server/validation";
import { queueDirectoryRefresh } from "@/lib/server/vet-directory";

// The signed-in user's own profile. There is no user id in the URL or body:
// whose profile is read or changed always comes from the session, and the
// role that decides which fields may change comes from the stored account.

const UNVERIFIED = "Verify your phone number before managing your profile.";

export const GET = route("profile", async (request) => {
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  return ok<ProfileResponse>({ profile: await getProfile(user) });
});

export const PATCH = route("profile", async (request) => {
  assertSameOrigin(request);
  const { user } = await requireVerifiedRequest(request, UNVERIFIED);
  const update = parseProfileUpdate(user.role, await readJsonBody(request));
  const profile = await updateProfile(user._id, update);
  await queueDirectoryRefresh(user);
  return ok<ProfileResponse>({ profile });
});
