import { parseReportRange, requireReportSeller } from "@/lib/server/analytics";
import { sellerExport } from "@/lib/server/analytics-export";
import { route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { PRODUCTS_UNVERIFIED } from "@/lib/server/products";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// ?report=trend|products|promotions as CSV, for the same period and with the
// same figures as the Insights screen. Errors are the usual JSON ApiResult.

export const GET = route("analytics/seller/export", async (request) => {
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireReportSeller(user.role);
  await limitUser("analyticsExportsPerUser", user._id);
  const params = new URL(request.url).searchParams;
  return sellerExport(user._id, params, parseReportRange(params));
});
