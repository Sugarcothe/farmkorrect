import type { SellerReportResponse } from "@/lib/analytics/types";
import { getSellerReport, parseReportRange, requireReportSeller } from "@/lib/server/analytics";
import { ok, route } from "@/lib/server/http";
import { limitUser } from "@/lib/server/order-access";
import { PRODUCTS_UNVERIFIED } from "@/lib/server/products";
import { requireVerifiedRequest } from "@/lib/server/sessions";

// The signed-in seller's sales insights for ?period= (and from/to for a
// custom range). The seller is always the session's user; read-only.

export const GET = route("analytics/seller", async (request) => {
  const { user } = await requireVerifiedRequest(request, PRODUCTS_UNVERIFIED);
  requireReportSeller(user.role);
  await limitUser("analyticsReadsPerUser", user._id);
  const range = parseReportRange(new URL(request.url).searchParams);
  return ok<SellerReportResponse>({ report: await getSellerReport(user._id, range) });
});
