import { requireAdminRequest } from "@/lib/server/admin";
import { parseReportRange } from "@/lib/server/analytics";
import { adminExport } from "@/lib/server/analytics-export";
import { route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// ?report=trend as CSV, for the same period as the admin Analytics screen.

export const GET = route("admin/analytics/export", async (request) => {
  const { user } = await requireAdminRequest(request);
  await limitUser("analyticsExportsPerUser", user._id);
  const params = new URL(request.url).searchParams;
  return adminExport(params, parseReportRange(params));
});
