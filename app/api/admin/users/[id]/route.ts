import type { AccountDetail } from "@/lib/admin/accounts";
import { requireAdminCapability } from "@/lib/server/admin";
import { ACCOUNT_NOT_FOUND, getAccountDetail } from "@/lib/server/admin-accounts";
import { HttpError, ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// One account's admin view: masked contact fields, status, admin role,
// activity counts and the audit history. Never passwords, tokens, OTPs,
// bank details or payment provider data.

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>("admin/users", async (request, { params }) => {
  const access = await requireAdminCapability(request, "admin.users.read");
  await limitUser("adminUserLookupsPerUser", access.user._id);
  const found = await getAccountDetail((await params).id);
  if (!found) throw new HttpError(404, ACCOUNT_NOT_FOUND);
  return ok<AccountDetail>(found);
});
