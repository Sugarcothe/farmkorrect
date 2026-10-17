import type { CredentialPage } from "@/lib/admin/types";
import { requireAdminRequest } from "@/lib/server/admin";
import { listPendingCredentials } from "@/lib/server/admin-credentials";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { parsePage } from "@/lib/server/wallet";

// Credential submissions waiting for a decision (?page=), oldest first.

export const GET = route("admin/credentials", async (request) => {
  const { user } = await requireAdminRequest(request);
  const page = parsePage(new URL(request.url).searchParams);
  await limitUser("adminReadsPerUser", user._id);
  return ok<CredentialPage>(await listPendingCredentials(page));
});
