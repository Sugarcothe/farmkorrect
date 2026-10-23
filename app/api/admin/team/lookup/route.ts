import type { TeamLookupResponse } from "@/lib/admin/accounts";
import { requireAdminCapability } from "@/lib/server/admin";
import { findCandidate } from "@/lib/server/admin-team";
import { HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// Finds one existing account to grant a role to ({q}: a user id, phone
// number or email address), with whether it can be granted one and its
// current role. A POST so contact details stay out of URLs and logs.

export const POST = route("admin/team/lookup", async (request) => {
  const access = await requireAdminCapability(request, "admin.team.manage", { mutation: true });
  await limitUser("adminUserLookupsPerUser", access.user._id);
  const body = await readJsonBody(request);
  if (Object.keys(body).some((k) => k !== "q"))
    throw new HttpError(400, "Please correct the search.", { q: "Only q can be sent." });
  return ok<TeamLookupResponse>({ candidate: await findCandidate(access, typeof body.q === "string" ? body.q : null) });
});
