import type { AdminSummary } from "@/lib/admin/types";
import { requireAdminRequest } from "@/lib/server/admin";
import { getAdminSummary } from "@/lib/server/admin-queues";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// Counts for the admin dashboard and the latest admin actions.

export const GET = route("admin/summary", async (request) => {
  const { user } = await requireAdminRequest(request);
  await limitUser("adminReadsPerUser", user._id);
  return ok<AdminSummary>(await getAdminSummary());
});
