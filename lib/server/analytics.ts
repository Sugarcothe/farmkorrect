import "server-only";
import { ObjectId, type Document, type Filter } from "mongodb";
import {
  CSV_ROW_LIMIT,
  MIN_ORDERS_FOR_RANKING,
  TOP_PRODUCTS,
  UNSOLD_SHOWN,
  type AdminReport,
  type LedgerFlows,
  type OrderActivity,
  type PayoutFigures,
  type ProductPerformance,
  type PromotionPerformance,
  type SellerReport,
  type TrendPoint,
} from "@/lib/analytics/types";
import { bucketsOf, REPORT_TIME_ZONE, resolveRange, type RangeInput, type ReportRange, type Span } from "@/lib/analytics/range";
import type { Role } from "@/lib/auth/types";
import type { LedgerEntryType, PayoutStatus } from "@/lib/wallet/types";
import { FAILED_DELIVERY, FLAGGED_ORDER, FLAGGED_PAYOUT, OPEN_ISSUE } from "./admin-queues";
import { getDb } from "./db";
import { HttpError } from "./http";
import { getWalletSummary } from "./ledger";
import {
  COLLECTIONS,
  type LedgerEntryDoc,
  type NotificationDeliveryDoc,
  type OrderDoc,
  type PayoutDoc,
  type ProductDoc,
  type PromotionDoc,
  type PromotionRedemptionDoc,
  type RefundDoc,
  type UserDoc,
} from "./models";
import { SELLER_ROLE } from "./products";
import { promotionState } from "./promotions";

// Read-only reports for sellers and admins. Definitions, sources and
// formulas are in docs/analytics-reporting.md; this file is the only place
// they're computed, and the screens, APIs and CSV exports all call it.
//
// Rules kept throughout:
// - nothing here writes: only find/countDocuments/aggregate;
// - a sale is an order with paidAt set (payment attempts are never summed,
//   so retries can't double count); refunds are the refunds Paystack
//   confirmed, counted when they were processed;
// - earnings, fees and balances come from the ledger (balances only via
//   getWalletSummary); no commission is ever computed here;
// - a seller report's scope is part of every query (sellerUserId / userId),
//   taken from the session by the caller, never from the request;
// - every query is an indexed $match plus $group or a capped list.

async function collections() {
  const db = await getDb();
  return {
    users: db.collection<UserDoc>(COLLECTIONS.users),
    orders: db.collection<OrderDoc>(COLLECTIONS.orders),
    refunds: db.collection<RefundDoc>(COLLECTIONS.refunds),
    ledger: db.collection<LedgerEntryDoc>(COLLECTIONS.ledgerEntries),
    payouts: db.collection<PayoutDoc>(COLLECTIONS.payouts),
    products: db.collection<ProductDoc>(COLLECTIONS.products),
    promotions: db.collection<PromotionDoc>(COLLECTIONS.promotions),
    redemptions: db.collection<PromotionRedemptionDoc>(COLLECTIONS.promotionRedemptions),
    deliveries: db.collection<NotificationDeliveryDoc>(COLLECTIONS.notificationDeliveries),
  };
}

type Window = { start: Date; end: Date };
const windowOf = (s: Pick<Span, "start" | "end">): Window => ({ start: new Date(s.start), end: new Date(s.end) });
/** half-open: start ≤ t < end */
const within = (w: Window) => ({ $gte: w.start, $lt: w.end });
const lagosDay = (field: string) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: REPORT_TIME_ZONE } });
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Scope for order queries: one seller, or the whole marketplace. */
type Scope = { sellerUserId?: ObjectId };
const orderScope = (scope: Scope): Filter<OrderDoc> => (scope.sellerUserId ? { sellerUserId: scope.sellerUserId } : {});

export const INSIGHTS_SELLERS_ONLY = "Sales insights are for poultry farmers selling on the Market.";

/** Only product sellers have sales insights. */
export function requireReportSeller(role: Role) {
  if (role !== SELLER_ROLE) throw new HttpError(403, INSIGHTS_SELLERS_ONLY);
}

/** The range a request asks for, or a 400 naming the field. */
export function parseReportRange(params: URLSearchParams, now = new Date()): ReportRange {
  const input: RangeInput = { period: params.get("period"), from: params.get("from"), to: params.get("to") };
  const result = resolveRange(input, now);
  if (!result.ok) throw new HttpError(400, result.message, { [result.field]: result.message });
  return result.range;
}

// --- orders, sales and refunds -------------------------------------------------------

/** Processed order refunds in the window, for one seller or everyone: total and distinct orders. */
async function refundsIn(scope: Scope, w: Window): Promise<{ amountKobo: number; orders: number }> {
  const { refunds } = await collections();
  const pipeline: Document[] = [{ $match: { status: "processed", kind: "order", processedAt: within(w) } }];
  if (scope.sellerUserId)
    pipeline.push(
      {
        $lookup: {
          from: COLLECTIONS.orders,
          localField: "orderId",
          foreignField: "_id",
          pipeline: [{ $project: { sellerUserId: 1 } }],
          as: "order",
        },
      },
      { $match: { "order.sellerUserId": scope.sellerUserId } },
    );
  pipeline.push(
    { $group: { _id: "$orderId", amount: { $sum: "$amountKobo" } } },
    { $group: { _id: null, amount: { $sum: "$amount" }, orders: { $sum: 1 } } },
  );
  const [row] = await refunds.aggregate<{ amount: number; orders: number }>(pipeline).toArray();
  return { amountKobo: num(row?.amount), orders: num(row?.orders) };
}

async function orderActivity(scope: Scope, w: Window): Promise<OrderActivity> {
  const { orders } = await collections();
  const base = orderScope(scope);
  const [placed, paidRows, completed, cancelledRows, refunds] = await Promise.all([
    orders.countDocuments({ ...base, createdAt: within(w) }),
    orders
      .aggregate<{ count: number; sales: number; discount: number; promo: number }>([
        { $match: { ...base, paidAt: within(w) } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            sales: { $sum: "$paidKobo" },
            discount: { $sum: { $ifNull: ["$promotion.discountKobo", 0] } },
            promo: { $sum: { $cond: [{ $eq: [{ $type: "$promotion.promotionId" }, "objectId"] }, 1, 0] } },
          },
        },
      ])
      .toArray(),
    orders.countDocuments({ ...base, deliveredAt: within(w) }),
    orders
      .aggregate<{ _id: boolean; count: number }>([
        { $match: { ...base, cancelledAt: within(w) } },
        { $group: { _id: { $eq: [{ $type: "$paidAt" }, "date"] }, count: { $sum: 1 } } },
      ])
      .toArray(),
    refundsIn(scope, w),
  ]);
  const paid = paidRows[0];
  return {
    placed,
    paid: num(paid?.count),
    completed,
    cancelledUnpaid: num(cancelledRows.find((r) => r._id === false)?.count),
    cancelledPaid: num(cancelledRows.find((r) => r._id === true)?.count),
    refundedOrders: refunds.orders,
    salesKobo: num(paid?.sales),
    discountKobo: num(paid?.discount),
    promotionOrders: num(paid?.promo),
    refundsKobo: refunds.amountKobo,
  };
}

/** This period's activity and, when there's earlier history, the comparison period's. */
async function activityWithComparison(scope: Scope, range: ReportRange) {
  const { orders } = await collections();
  const current = windowOf(range);
  const [activity, earlier] = await Promise.all([
    orderActivity(scope, current),
    orders.findOne({ ...orderScope(scope), createdAt: { $lt: current.start } }, { projection: { _id: 1 } }),
  ]);
  return { current: activity, previous: earlier ? await orderActivity(scope, windowOf(range.previous)) : null };
}

type DayRow = { _id: string; count: number; amount: number };

/** Per-day rows summed into the range's buckets. Rows outside the range are ignored. */
function bucketed<T extends object>(range: ReportRange, fill: (dates: string[]) => T): Array<{ from: string; to: string } & T> {
  return bucketsOf(range).map((b) => {
    const dates: string[] = [];
    for (let d = new Date(`${b.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= b.to; d = new Date(d.getTime() + 86_400_000))
      dates.push(d.toISOString().slice(0, 10));
    return { ...b, ...fill(dates) };
  });
}

const sumDays = (rows: Map<string, DayRow>, dates: string[], key: "count" | "amount") =>
  dates.reduce((total, d) => total + num(rows.get(d)?.[key]), 0);

async function trendRows(scope: Scope, w: Window) {
  const { orders, refunds } = await collections();
  const base = orderScope(scope);
  const refundPipeline: Document[] = [{ $match: { status: "processed", kind: "order", processedAt: within(w) } }];
  if (scope.sellerUserId)
    refundPipeline.push(
      {
        $lookup: {
          from: COLLECTIONS.orders,
          localField: "orderId",
          foreignField: "_id",
          pipeline: [{ $project: { sellerUserId: 1 } }],
          as: "order",
        },
      },
      { $match: { "order.sellerUserId": scope.sellerUserId } },
    );
  refundPipeline.push({ $group: { _id: lagosDay("$processedAt"), count: { $sum: 1 }, amount: { $sum: "$amountKobo" } } });
  const [placed, paid, refunded] = await Promise.all([
    orders
      .aggregate<DayRow>([
        { $match: { ...base, createdAt: within(w) } },
        { $group: { _id: lagosDay("$createdAt"), count: { $sum: 1 }, amount: { $sum: 0 } } },
      ])
      .toArray(),
    orders
      .aggregate<DayRow>([
        { $match: { ...base, paidAt: within(w) } },
        { $group: { _id: lagosDay("$paidAt"), count: { $sum: 1 }, amount: { $sum: "$paidKobo" } } },
      ])
      .toArray(),
    refunds.aggregate<DayRow>(refundPipeline).toArray(),
  ]);
  const map = (rows: DayRow[]) => new Map(rows.map((r) => [r._id, r]));
  return { placed: map(placed), paid: map(paid), refunded: map(refunded) };
}

async function trendOf(scope: Scope, range: ReportRange): Promise<TrendPoint[]> {
  const rows = await trendRows(scope, windowOf(range));
  return bucketed(range, (dates) => ({
    placed: sumDays(rows.placed, dates, "count"),
    paidOrders: sumDays(rows.paid, dates, "count"),
    salesKobo: sumDays(rows.paid, dates, "amount"),
    refundsKobo: sumDays(rows.refunded, dates, "amount"),
  }));
}

// --- seller: products ------------------------------------------------------------------

/**
 * The seller's products sold in the window (paid orders only), by sales,
 * at most `limit`. `truncated` when there were more.
 */
export async function sellerProductSales(
  sellerUserId: ObjectId,
  range: ReportRange,
  limit = CSV_ROW_LIMIT,
): Promise<{ rows: ProductPerformance[]; truncated: boolean }> {
  const { orders, products } = await collections();
  const rows = await orders
    .aggregate<{ _id: ObjectId; name: string; units: number; orders: ObjectId[]; sales: number }>([
      { $match: { sellerUserId, paidAt: within(windowOf(range)) } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          name: { $last: "$items.name" },
          units: { $sum: "$items.quantity" },
          orders: { $addToSet: "$_id" },
          sales: { $sum: { $subtract: ["$items.lineTotalKobo", { $ifNull: ["$items.discountKobo", 0] }] } },
        },
      },
      { $project: { name: 1, units: 1, sales: 1, orders: { $size: "$orders" } } },
      { $sort: { sales: -1, units: -1, _id: 1 } },
      { $limit: limit + 1 },
    ])
    .toArray();
  const shown = rows.slice(0, limit);
  // current names where the product still exists (one query for all of them)
  const current = await products
    .find({ _id: { $in: shown.map((r) => r._id) }, sellerUserId }, { projection: { name: 1 } })
    .toArray();
  const names = new Map(current.map((p) => [p._id.toHexString(), p.name]));
  return {
    truncated: rows.length > limit,
    rows: shown.map((r) => ({
      productId: r._id.toHexString(),
      name: names.get(r._id.toHexString()) ?? r.name,
      units: num(r.units),
      orders: num(r.orders),
      salesKobo: num(r.sales),
    })),
  };
}

async function sellerProducts(sellerUserId: ObjectId, range: ReportRange, paidOrders: number): Promise<SellerReport["products"]> {
  const { products } = await collections();
  const { rows } = await sellerProductSales(sellerUserId, range);
  // listings (not archived, already listed by the end of the period) with no paid order in it
  const filter: Filter<ProductDoc> = {
    sellerUserId,
    archivedAt: null,
    createdAt: { $lt: new Date(range.end) },
    _id: { $nin: rows.map((r) => new ObjectId(r.productId)) },
  };
  const [unsold, unsoldCount] = await Promise.all([
    products
      .find(filter, { projection: { name: 1, active: 1 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(UNSOLD_SHOWN)
      .toArray(),
    products.countDocuments(filter),
  ]);
  const byUnits = [...rows].sort((a, b) => b.units - a.units || b.salesKobo - a.salesKobo || a.productId.localeCompare(b.productId));
  return {
    byUnits: byUnits.slice(0, TOP_PRODUCTS),
    bySales: rows.slice(0, TOP_PRODUCTS),
    soldCount: rows.length,
    unsold: unsold.map((p) => ({ productId: p._id.toHexString(), name: p.name, live: p.active })),
    unsoldCount,
    insufficientHistory: paidOrders < MIN_ORDERS_FOR_RANKING,
  };
}

// --- ledger and payouts ----------------------------------------------------------------

async function ledgerFlows(match: Filter<LedgerEntryDoc>): Promise<LedgerFlows> {
  const { ledger } = await collections();
  const rows = await ledger
    .aggregate<{ _id: LedgerEntryType; total: number }>([
      { $match: match },
      { $group: { _id: "$type", total: { $sum: "$amountKobo" } } },
    ])
    .toArray();
  const total = (type: LedgerEntryType) => num(rows.find((r) => r._id === type)?.total);
  const earningsKobo = total("earning");
  const feesKobo = total("platform_fee");
  const refundsKobo = total("refund");
  return {
    earningsKobo,
    feesKobo,
    refundsKobo,
    netKobo: earningsKobo - feesKobo - refundsKobo,
    payoutsPaidKobo: total("payout_paid"),
    payoutReleasesKobo: total("payout_release"),
  };
}

const PAYOUT_STATUSES: PayoutStatus[] = ["requested", "processing", "paid", "failed"];
type CountAmount = { count: number; amountKobo: number };

async function payoutTotal(match: Filter<PayoutDoc>): Promise<CountAmount> {
  const { payouts } = await collections();
  const [row] = await payouts
    .aggregate<{ count: number; amount: number }>([
      { $match: match },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amountKobo" } } },
    ])
    .toArray();
  return { count: num(row?.count), amountKobo: num(row?.amount) };
}

async function sellerPayouts(userId: ObjectId, w: Window): Promise<PayoutFigures> {
  const { payouts } = await collections();
  const [byStatus, paidInPeriod, failedInPeriod] = await Promise.all([
    payouts
      .aggregate<{ _id: PayoutStatus; count: number; amount: number }>([
        { $match: { userId, requestedAt: within(w) } },
        { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amountKobo" } } },
      ])
      .toArray(),
    payoutTotal({ userId, paidAt: within(w) }),
    payoutTotal({ userId, failedAt: within(w) }),
  ]);
  const requested = Object.fromEntries(
    PAYOUT_STATUSES.map((s) => {
      const row = byStatus.find((r) => r._id === s);
      return [s, { count: num(row?.count), amountKobo: num(row?.amount) }];
    }),
  ) as PayoutFigures["requested"];
  return { requested, paidInPeriod, failedInPeriod };
}

/** Paid, not cancelled, and no earning recorded yet (no commission policy, or not synced). */
const PAID_NOT_IN_LEDGER: Filter<OrderDoc> = { settlement: null, paidAt: { $type: "date" }, fulfillmentStatus: { $ne: "cancelled" } };

// --- seller: promotions ------------------------------------------------------------------

/** The seller's promotions with activity in the window, uses held now, or running now. */
export async function sellerPromotionStats(
  sellerUserId: ObjectId,
  range: ReportRange,
  limit = CSV_ROW_LIMIT,
  now = new Date(),
): Promise<{ rows: PromotionPerformance[]; truncated: boolean }> {
  const { orders, redemptions, promotions } = await collections();
  const w = windowOf(range);
  const [fromOrders, redeemed, reserved, running] = await Promise.all([
    orders
      .aggregate<{ _id: ObjectId; name: string; code: string | null; paid: number; discount: number; sales: number }>([
        { $match: { sellerUserId, paidAt: within(w), "promotion.promotionId": { $type: "objectId" } } },
        {
          $group: {
            _id: "$promotion.promotionId",
            name: { $last: "$promotion.name" },
            code: { $last: "$promotion.code" },
            paid: { $sum: 1 },
            discount: { $sum: "$promotion.discountKobo" },
            sales: { $sum: "$paidKobo" },
          },
        },
      ])
      .toArray(),
    redemptions
      .aggregate<{ _id: ObjectId; count: number }>([
        { $match: { sellerUserId, status: "redeemed", redeemedAt: within(w) } },
        { $group: { _id: "$promotionId", count: { $sum: 1 } } },
      ])
      .toArray(),
    redemptions
      .aggregate<{ _id: ObjectId; count: number }>([
        { $match: { sellerUserId, status: "reserved" } },
        { $group: { _id: "$promotionId", count: { $sum: 1 } } },
      ])
      .toArray(),
    promotions
      .find({ sellerUserId, status: "active" }, { projection: { _id: 1 } })
      .limit(CSV_ROW_LIMIT)
      .toArray(),
  ]);

  const ids = new Map<string, ObjectId>();
  for (const r of [...fromOrders, ...redeemed, ...reserved, ...running]) ids.set(r._id.toHexString(), r._id);
  const docs = await promotions.find({ _id: { $in: [...ids.values()] }, sellerUserId }).toArray();
  const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
  const ordersById = new Map(fromOrders.map((r) => [r._id.toHexString(), r]));
  const count = (rows: Array<{ _id: ObjectId; count: number }>, id: string) =>
    num(rows.find((r) => r._id.toHexString() === id)?.count);

  const all = [...ids.keys()].map((id): PromotionPerformance => {
    const doc = byId.get(id);
    const o = ordersById.get(id);
    return {
      promotionId: id,
      name: doc?.name ?? o?.name ?? "Deleted promotion",
      state: doc ? promotionState(doc, now) : null,
      code: doc?.code ?? o?.code ?? null,
      paidOrders: num(o?.paid),
      redeemedUses: count(redeemed, id),
      reservedUsesNow: count(reserved, id),
      discountKobo: num(o?.discount),
      salesKobo: num(o?.sales),
    };
  });
  all.sort((a, b) => b.salesKobo - a.salesKobo || b.paidOrders - a.paidOrders || a.name.localeCompare(b.name) || a.promotionId.localeCompare(b.promotionId));
  return { rows: all.slice(0, limit), truncated: all.length > limit };
}

// --- the reports -------------------------------------------------------------------------

/** Everything on the seller's Insights screen. `sellerUserId` comes from the session. */
export async function getSellerReport(sellerUserId: ObjectId, range: ReportRange, now = new Date()): Promise<SellerReport> {
  const { orders } = await collections();
  const w = windowOf(range);
  const [overview, awaitingPaymentNow, trend, ledger, balances, paidNotInLedgerNow, payouts, promotions] = await Promise.all([
    activityWithComparison({ sellerUserId }, range),
    orders.countDocuments({ sellerUserId, paymentStatus: { $in: ["pending", "failed"] }, fulfillmentStatus: "pending" }),
    trendOf({ sellerUserId }, range),
    ledgerFlows({ userId: sellerUserId, createdAt: within(w) }),
    getWalletSummary(sellerUserId, { now }),
    orders.countDocuments({ sellerUserId, ...PAID_NOT_IN_LEDGER }),
    sellerPayouts(sellerUserId, w),
    sellerPromotionStats(sellerUserId, range, CSV_ROW_LIMIT, now),
  ]);
  return {
    range,
    generatedAt: now.toISOString(),
    overview: { ...overview, awaitingPaymentNow },
    trend,
    products: await sellerProducts(sellerUserId, range, overview.current.paid),
    earnings: { ledger, balances, paidNotInLedgerNow, payouts },
    promotions: promotions.rows,
  };
}

/** The seller's trend for the CSV: the same buckets and figures as the chart. */
export const sellerTrend = (sellerUserId: ObjectId, range: ReportRange) => trendOf({ sellerUserId }, range);

async function countBy<T extends Document>(
  collection: { aggregate: <R extends Document>(p: Document[]) => { toArray: () => Promise<R[]> } },
  match: Filter<T>,
  field: string,
) {
  const rows = await collection
    .aggregate<{ _id: unknown; count: number }>([{ $match: match }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }])
    .toArray();
  return rows
    .map((r) => ({ status: String(r._id ?? "unknown"), count: num(r.count) }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

async function adminTrend(range: ReportRange): Promise<AdminReport["trend"]> {
  const { users } = await collections();
  const w = windowOf(range);
  const [rows, accounts] = await Promise.all([
    trendRows({}, w),
    users
      .aggregate<DayRow>([
        { $match: { createdAt: within(w) } },
        { $group: { _id: lagosDay("$createdAt"), count: { $sum: 1 }, amount: { $sum: 0 } } },
      ])
      .toArray(),
  ]);
  const accountRows = new Map(accounts.map((r) => [r._id, r]));
  return bucketed(range, (dates) => ({
    placed: sumDays(rows.placed, dates, "count"),
    paidOrders: sumDays(rows.paid, dates, "count"),
    salesKobo: sumDays(rows.paid, dates, "amount"),
    refundsKobo: sumDays(rows.refunded, dates, "amount"),
    newAccounts: sumDays(accountRows, dates, "count"),
  }));
}

/** The marketplace trend for the admin CSV. */
export const marketplaceTrend = adminTrend;

async function refundTotal(match: Filter<RefundDoc>): Promise<CountAmount> {
  const { refunds } = await collections();
  const [row] = await refunds
    .aggregate<{ count: number; amount: number }>([
      { $match: match },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$amountKobo" } } },
    ])
    .toArray();
  return { count: num(row?.count), amountKobo: num(row?.amount) };
}

/** For refund entries recorded in the window: what buyers got back minus what came out of sellers' earnings. */
async function feesReturned(w: Window): Promise<number> {
  const { ledger } = await collections();
  const [row] = await ledger
    .aggregate<{ total: number }>([
      { $match: { createdAt: within(w), type: "refund" } },
      {
        $lookup: {
          from: COLLECTIONS.refunds,
          localField: "refundId",
          foreignField: "reference",
          pipeline: [{ $project: { amountKobo: 1 } }],
          as: "refund",
        },
      },
      { $unwind: "$refund" },
      { $group: { _id: null, total: { $sum: { $subtract: ["$refund.amountKobo", "$amountKobo"] } } } },
    ])
    .toArray();
  return num(row?.total);
}

async function distinctCount<T extends Document>(
  collection: { aggregate: <R extends Document>(p: Document[]) => { toArray: () => Promise<R[]> } },
  match: Filter<T>,
  field: string,
) {
  const [row] = await collection
    .aggregate<{ n: number }>([{ $match: match }, { $group: { _id: `$${field}` } }, { $count: "n" }])
    .toArray();
  return num(row?.n);
}

/** Everything on the admin Analytics screen. The caller has checked the admin session. */
export async function getAdminReport(range: ReportRange, now = new Date()): Promise<AdminReport> {
  const c = await collections();
  const w = windowOf(range);
  const prev = windowOf(range.previous);
  const [
    activity,
    paymentStatusNow,
    fulfillmentStatusNow,
    trend,
    accountRows,
    newAccounts,
    earlierAccount,
    listingRows,
    newListings,
    sellersPaid,
    sellersLive,
    sellersPromo,
    promotionsByStatus,
    latePayments,
    refundsInProgress,
    refundsFailed,
    ledger,
    feesReturnedKobo,
    payoutsRequested,
    payoutsPaid,
    payoutsFailed,
    payoutsInProgress,
    openIssues,
    flaggedOrders,
    flaggedPayouts,
    failedDeliveries,
    ledgerSyncPending,
    paidNotInLedger,
  ] = await Promise.all([
    activityWithComparison({}, range),
    countBy<OrderDoc>(c.orders, {}, "paymentStatus"),
    countBy<OrderDoc>(c.orders, {}, "fulfillmentStatus"),
    adminTrend(range),
    c.users
      .aggregate<{ _id: { role: string; status: string }; count: number }>([
        { $group: { _id: { role: "$role", status: "$status" }, count: { $sum: 1 } } },
      ])
      .toArray(),
    countBy<UserDoc>(c.users, { createdAt: within(w) }, "role"),
    c.users.findOne({ createdAt: { $lt: w.start } }, { projection: { _id: 1 } }),
    c.products
      .aggregate<{ _id: { archived: boolean; active: boolean }; count: number }>([
        { $group: { _id: { archived: { $eq: [{ $type: "$archivedAt" }, "date"] }, active: "$active" }, count: { $sum: 1 } } },
      ])
      .toArray(),
    c.products.countDocuments({ createdAt: within(w) }),
    distinctCount<OrderDoc>(c.orders, { paidAt: within(w) }, "sellerUserId"),
    distinctCount<ProductDoc>(c.products, { active: true, archivedAt: null }, "sellerUserId"),
    distinctCount<PromotionDoc>(c.promotions, { status: "active" }, "sellerUserId"),
    countBy<PromotionDoc>(c.promotions, {}, "status"),
    refundTotal({ status: "processed", kind: "late_payment", processedAt: within(w) }),
    refundTotal({ status: { $in: ["creating", "pending"] } }),
    refundTotal({ status: "failed", failedAt: within(w) }),
    ledgerFlows({ createdAt: within(w) }),
    feesReturned(w),
    payoutTotal({ requestedAt: within(w) }),
    payoutTotal({ paidAt: within(w) }),
    payoutTotal({ failedAt: within(w) }),
    payoutTotal({ status: { $in: ["requested", "processing"] } }),
    c.orders.countDocuments(OPEN_ISSUE),
    c.orders.countDocuments(FLAGGED_ORDER),
    c.payouts.countDocuments(FLAGGED_PAYOUT),
    c.deliveries.countDocuments(FAILED_DELIVERY),
    c.orders.countDocuments({ ledgerSyncAt: { $type: "date" } }),
    c.orders.countDocuments(PAID_NOT_IN_LEDGER),
  ]);

  const roles = new Map<string, { role: string; total: number; verified: number }>();
  for (const r of accountRows) {
    const entry = roles.get(r._id.role) ?? { role: r._id.role, total: 0, verified: 0 };
    entry.total += num(r.count);
    if (r._id.status === "active") entry.verified += num(r.count);
    roles.set(r._id.role, entry);
  }
  const listing = (archived: boolean, active?: boolean) =>
    listingRows
      .filter((r) => r._id.archived === archived && (active === undefined || r._id.active === active))
      .reduce((t, r) => t + num(r.count), 0);

  return {
    range,
    generatedAt: now.toISOString(),
    accounts: {
      byRole: [...roles.values()].sort((a, b) => a.role.localeCompare(b.role)),
      newInPeriod: newAccounts.map((r) => ({ role: r.status, count: r.count })),
      newInPreviousPeriod: earlierAccount ? await c.users.countDocuments({ createdAt: within(prev) }) : null,
    },
    orders: { ...activity, paymentStatusNow, fulfillmentStatusNow },
    trend,
    listings: { liveNow: listing(false, true), hiddenNow: listing(false, false), archivedNow: listing(true), newInPeriod: newListings },
    sellers: { withPaidOrders: sellersPaid, withLiveListingsNow: sellersLive, withActivePromotionNow: sellersPromo },
    promotions: { byStatusNow: promotionsByStatus },
    financial: {
      paidKobo: activity.current.salesKobo,
      refundsKobo: activity.current.refundsKobo,
      netCapturedKobo: activity.current.salesKobo - activity.current.refundsKobo,
      latePaymentsReturned: latePayments,
      refundsInProgressNow: refundsInProgress,
      refundsFailed,
      ledger,
      feesReturnedKobo,
      payouts: { requested: payoutsRequested, paid: payoutsPaid, failed: payoutsFailed, inProgressNow: payoutsInProgress },
    },
    operational: { openIssues, flaggedOrders, flaggedPayouts, failedDeliveries, ledgerSyncPending, paidNotInLedger },
  };
}
