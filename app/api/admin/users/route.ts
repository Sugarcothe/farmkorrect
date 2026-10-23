import type { AccountPage } from "@/lib/admin/accounts";
import { requireAdminCapability } from "@/lib/server/admin";
import { listSuspendedAccounts } from "@/lib/server/admin-accounts";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// Suspended accounts, most recently suspended first. Finding any other
// account is one exact lookup at /api/admin/users/lookup; there is no
// browsing or partial matching of users.

export const GET = route("admin/users", async (request) => {
  const access = await requireAdminCapability(request, "admin.users.read");
  const page = parsePage(new URL(request.url).searchParams);
  await limitUser("adminReadsPerUser", access.user._id);
  return ok<AccountPage>(await listSuspendedAccounts(page));
});
