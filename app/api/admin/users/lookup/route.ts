import type { AccountLookupResponse } from "@/lib/admin/accounts";
import { requireAdminCapability } from "@/lib/server/admin";
import { findAccount, parseAccountQuery } from "@/lib/server/admin-accounts";
import { HttpError, ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// One exact account lookup ({q}: a user id, phone number or email address),
// rate limited, returning masked fields only. It's a POST so the phone
// number or email never appears in a URL, browser history or access log.

export const POST = route("admin/users/lookup", async (request) => {
  const access = await requireAdminCapability(request, "admin.users.read", { mutation: true });
  await limitUser("adminUserLookupsPerUser", access.user._id);
  const body = await readJsonBody(request);
  if (Object.keys(body).some((k) => k !== "q"))
    throw new HttpError(400, "Please correct the search.", { q: "Only q can be sent." });
  return ok<AccountLookupResponse>({
    account: await findAccount(parseAccountQuery(typeof body.q === "string" ? body.q : null)),
  });
});
