import "server-only";
import type { ObjectId } from "mongodb";
import { ADMIN_EXPORTS, SELLER_EXPORTS, type AdminExport, type SellerExport } from "@/lib/analytics/types";
import type { ReportRange } from "@/lib/analytics/range";
import { marketplaceTrend, sellerProductSales, sellerPromotionStats, sellerTrend } from "./analytics";
import { csvResponse, type CsvValue } from "./csv";
import { HttpError } from "./http";

// The CSV exports: the same service functions (so the same filters and
// definitions) as the screens. Columns are documented in
// docs/analytics-reporting.md and never change order. No names of buyers or
// sellers, contact details, bank details or provider references.

export const SELLER_COLUMNS: Record<SellerExport, readonly string[]> = {
  trend: ["date_from", "date_to", "orders_placed", "paid_orders", "sales_collected_kobo", "refunds_kobo"],
  products: ["product_id", "product_name", "units", "orders", "sales_before_refunds_kobo"],
  promotions: [
    "promotion_id",
    "promotion_name",
    "status",
    "code",
    "paid_orders",
    "redeemed_uses",
    "reserved_uses_now",
    "discount_kobo",
    "sales_collected_kobo",
  ],
};

export const ADMIN_COLUMNS: Record<AdminExport, readonly string[]> = {
  trend: ["date_from", "date_to", "orders_placed", "paid_orders", "paid_kobo", "refunds_kobo", "new_accounts"],
};

function reportParam<T extends string>(params: URLSearchParams, allowed: readonly T[]): T {
  const report = params.get("report") ?? "";
  if (!(allowed as readonly string[]).includes(report)) {
    const message = "Choose a report to download.";
    throw new HttpError(400, message, { report: message });
  }
  return report as T;
}

const fileName = (prefix: string, report: string, range: ReportRange) => `${prefix}-${report}-${range.from}-to-${range.to}.csv`;

export async function sellerExport(sellerUserId: ObjectId, params: URLSearchParams, range: ReportRange): Promise<Response> {
  const report = reportParam(params, SELLER_EXPORTS);
  let rows: CsvValue[][];
  let truncated = false;
  if (report === "trend") {
    rows = (await sellerTrend(sellerUserId, range)).map((p) => [p.from, p.to, p.placed, p.paidOrders, p.salesKobo, p.refundsKobo]);
  } else if (report === "products") {
    const result = await sellerProductSales(sellerUserId, range);
    truncated = result.truncated;
    rows = result.rows.map((p) => [p.productId, p.name, p.units, p.orders, p.salesKobo]);
  } else {
    const result = await sellerPromotionStats(sellerUserId, range);
    truncated = result.truncated;
    rows = result.rows.map((p) => [
      p.promotionId,
      p.name,
      p.state ?? "deleted",
      p.code,
      p.paidOrders,
      p.redeemedUses,
      p.reservedUsesNow,
      p.discountKobo,
      p.salesKobo,
    ]);
  }
  return csvResponse(fileName("sales", report, range), SELLER_COLUMNS[report], rows, truncated);
}

export async function adminExport(params: URLSearchParams, range: ReportRange): Promise<Response> {
  const report = reportParam(params, ADMIN_EXPORTS);
  const rows: CsvValue[][] = (await marketplaceTrend(range)).map((p) => [
    p.from,
    p.to,
    p.placed,
    p.paidOrders,
    p.salesKobo,
    p.refundsKobo,
    p.newAccounts,
  ]);
  return csvResponse(fileName("marketplace", report, range), ADMIN_COLUMNS[report], rows);
}
