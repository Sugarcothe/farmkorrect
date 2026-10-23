import type { AccountDetail } from "@/lib/admin/accounts";
import { requireAdminCapability } from "@/lib/server/admin";
import { changeAccountStatus, parseStatusChange } from "@/lib/server/admin-accounts";
import { ok, readJsonBody, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// Suspends or reactivates an account ({action, reason, expectedVersion,
// confirmed: true}). Suspending signs the account out everywhere in the
// same transaction as the status change and its audit record.

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>("admin/users/status", async (request, { params }) => {
  const access = await requireAdminCapability(request, "admin.users.suspend", { mutation: true });
  await limitUser("adminActionsPerUser", access.user._id);
  const input = parseStatusChange(await readJsonBody(request));
  return ok<AccountDetail>(await changeAccountStatus(access, (await params).id, input));
});
