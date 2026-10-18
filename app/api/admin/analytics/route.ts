import type { AdminReportResponse } from "@/lib/analytics/types";
import { requireAdminRequest } from "@/lib/server/admin";
import { getAdminReport, parseReportRange } from "@/lib/server/analytics";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";

// Marketplace, financial and operational reports for ?period=. Admins only
// (ADMIN_USER_IDS, checked here); read-only.

export const GET = route("admin/analytics", async (request) => {
  const { user } = await requireAdminRequest(request);
  await limitUser("adminReadsPerUser", user._id);
  const range = parseReportRange(new URL(request.url).searchParams);
  return ok<AdminReportResponse>({ report: await getAdminReport(range) });
});
