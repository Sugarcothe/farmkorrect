import type { AdminSummary } from "@/lib/admin/types";
import { requireAnyAdminRequest } from "@/lib/server/admin";
import { getAdminSummary } from "@/lib/server/admin-queues";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// Counts for the admin dashboard and the latest admin actions, limited to
// the queues the admin's role covers. A count that couldn't be read is null.

export const GET = route("admin/summary", async (request) => {
  const access = await requireAnyAdminRequest(request);
  await limitUser("adminReadsPerUser", access.user._id);
  return ok<AdminSummary>(await getAdminSummary(access));
});
