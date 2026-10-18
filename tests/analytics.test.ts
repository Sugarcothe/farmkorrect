import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { GET as adminExportRoute } from "@/app/api/admin/analytics/export/route";
import { GET as adminReportRoute } from "@/app/api/admin/analytics/route";
import { GET as summaryRoute } from "@/app/api/admin/summary/route";
import { GET as sellerExportRoute } from "@/app/api/analytics/seller/export/route";
import { GET as sellerReportRoute } from "@/app/api/analytics/seller/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { POST as placeRoute } from "@/app/api/orders/route";
import { POST as addProductRoute } from "@/app/api/products/route";
import { POST as statusRoute } from "@/app/api/promotions/[id]/status/route";
import { POST as createRoute } from "@/app/api/promotions/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import { POST as refundRoute } from "@/app/api/sales/[id]/refund/route";
import type { AdminSummary } from "@/lib/admin/types";
import {
  bucketsOf,
  changeOf,
  DAILY_MAX_DAYS,
  lagosDayStart,
  dayIndex,
  resolveRange,
  type RangeInput,
} from "@/lib/analytics/range";
import type { AdminReportResponse, SellerReportResponse } from "@/lib/analytics/types";
import type { CheckoutResponse, OrderResponse, ProductResponse, VerifyPaymentResponse } from "@/lib/orders/types";
import type { PromotionResponse } from "@/lib/promotions/types";
import { getAdminReport, getSellerReport, sellerProductSales } from "@/lib/server/analytics";
import { SELLER_COLUMNS } from "@/lib/server/analytics-export";
import { csvCell, toCsv } from "@/lib/server/csv";
import { getWalletSummary } from "@/lib/server/ledger";
import type { PayoutDoc } from "@/lib/server/models";
import { collections } from "./support/db";
import { call, dataOf, ORIGIN, type CallOptions, type CallResult } from "./support/http";
import { completeCheckout } from "./support/paystack";
import { merchant } from "./support/wallet";

// Analytics: the date ranges, every metric against orders made through the
// real APIs (Paystack is faked), the CSV exports, who can see what, and that
// reports never change anything.

const HOUR = 60 * 60_000;
const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 100, description: "" };
const NOTE = "Deliver to 12 Ring Road, Ibadan. Call on arrival.";

type Account = Awaited<ReturnType<typeof merchant>>;
type Ctx = { params: Promise<{ id: string }> };
type RouteWithId = (request: Request, context: Ctx) => Promise<Response>;

function callId<T>(handler: RouteWithId, path: string, id: string, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve({ id }) }), path, options);
}
const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

const setCommission = (bps: number) => {
  vi.stubEnv("COMMISSION_POLICY_ID", "test-policy");
  vi.stubEnv("COMMISSION_RATE_BPS", String(bps));
};
const farmer = () => merchant("poultry-farmer");
const buyer = () => merchant("veterinarian");
const allow = (...accounts: Account[]) =>
  vi.stubEnv("ADMIN_USER_IDS", accounts.map((a) => a.userId.toHexString()).join(","));

async function listProduct(cookie: string, overrides: Partial<typeof EGGS> = {}) {
  return dataOf(await call<ProductResponse>(addProductRoute, "/api/products", { body: { ...EGGS, ...overrides }, cookie })).product;
}

async function place(cookie: string, productId: string, quantity: number, extra: Record<string, unknown> = {}) {
  const res = await call<OrderResponse>(placeRoute, "/api/orders", {
    body: { items: [{ productId, quantity }], fulfillmentMethod: "pickup", deliveryNote: NOTE, idempotencyKey: randomUUID(), ...extra },
    cookie,
  });
  expect(res.status).toBe(201);
  return dataOf(res).order;
}

async function attempt(cookie: string, id: string, status = "success") {
  const { reference } = dataOf(await callId<CheckoutResponse>(checkoutRoute, `/api/orders/${id}/checkout`, id, { cookie, body: {} }));
  completeCheckout(reference, status);
  const res = await callId<VerifyPaymentResponse>(verifyRoute, `/api/orders/${id}/verify-payment`, id, { cookie, body: { reference } });
  return dataOf(res).result;
}
const pay = async (cookie: string, id: string) => expect(await attempt(cookie, id)).toBe("paid");

const cancel = (cookie: string, id: string) =>
  callId<OrderResponse>(cancelRoute, `/api/orders/${id}/cancel`, id, { cookie, body: { reason: "Ordered by mistake" } });
const fulfil = (cookie: string, id: string, action: string) =>
  callId<OrderResponse>(fulfilRoute, `/api/sales/${id}/fulfillment`, id, { cookie, body: { action } });
const refund = (cookie: string, id: string, amountKobo: number) =>
  callId<OrderResponse>(refundRoute, `/api/sales/${id}/refund`, id, {
    cookie,
    body: { amountKobo, reason: "Two crates cracked", idempotencyKey: randomUUID() },
  });

async function livePromotion(cookie: string, overrides: Record<string, unknown> = {}) {
  const body = {
    name: "Harvest sale",
    description: "",
    type: "percentage",
    value: 10,
    scope: "all",
    productIds: [],
    code: null,
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + 24 * HOUR).toISOString(),
    minOrderKobo: null,
    maxDiscountKobo: null,
    totalLimit: null,
    perBuyerLimit: null,
    ...overrides,
  };
  const { promotion } = dataOf(await call<PromotionResponse>(createRoute, "/api/promotions", { body, cookie }));
  const res = await callId<PromotionResponse>(statusRoute, `/api/promotions/${promotion.id}/status`, promotion.id, {
    cookie,
    body: { action: "activate", expectedVersion: promotion.version },
  });
  expect(res.status).toBe(200);
  return dataOf(res).promotion;
}

const range = (input: RangeInput = { period: "last7" }, now = new Date()) => {
  const result = resolveRange(input, now);
  if (!result.ok) throw new Error(result.message);
  return result.range;
};

const sellerReport = (cookie: string, query = "period=last7") =>
  call<SellerReportResponse>(sellerReportRoute, `/api/analytics/seller?${query}`, { cookie });
const adminReport = (cookie: string, query = "period=last7") =>
  call<AdminReportResponse>(adminReportRoute, `/api/admin/analytics?${query}`, { cookie });

/** Calls a CSV route directly (the JSON helper can't read CSV). */
async function download(handler: (request: Request) => Promise<Response>, path: string, cookie: string | null) {
  const headers = new Headers({ origin: ORIGIN, "x-real-ip": "203.0.113.10" });
  if (cookie) headers.set("cookie", `fk_session=${cookie}`);
  const response = await handler(new Request(`${ORIGIN}${path}`, { headers }));
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

/** A simple CSV reader for our own output (quoted cells, CRLF, BOM). */
function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  return body
    .split("\r\n")
    .filter((line) => line.length)
    .map((line) => {
      const cells: string[] = [];
      let cell = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') {
            cell += '"';
            i++;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") {
          cells.push(cell);
          cell = "";
        } else cell += ch;
      }
      cells.push(cell);
      return cells;
    });
}

/** Every number anywhere in a value (to check there's never a NaN or Infinity). */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

/** A snapshot of every collection, to show reports write nothing. */
async function snapshot() {
  const c = await collections();
  const db = c.orders.db;
  const out: Record<string, unknown[]> = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name === "rate_limits") continue; // the only thing a report request writes
    out[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
  }
  return JSON.stringify(out);
}

// --- dates ---------------------------------------------------------------------------

describe("report periods", () => {
  // 00:30 on 18 Oct 2026 in Lagos (UTC+1) is still 17 Oct in UTC
  const NOW = new Date("2026-10-17T23:30:00Z");

  it("uses Lagos days with half-open boundaries, not the server's timezone", () => {
    const r = range({ period: "last7" }, NOW);
    expect(r).toMatchObject({ from: "2026-10-12", to: "2026-10-18", days: 7, granularity: "day" });
    expect(r.start).toBe("2026-10-11T23:00:00.000Z");
    expect(r.end).toBe("2026-10-18T23:00:00.000Z");
    expect(r.previous).toMatchObject({ from: "2026-10-05", to: "2026-10-11", days: 7, end: r.start });
    expect(lagosDayStart(dayIndex("2026-01-01")!).toISOString()).toBe("2025-12-31T23:00:00.000Z");
  });

  it("works out the presets and compares like with like", () => {
    expect(range({ period: "last30" }, NOW)).toMatchObject({ from: "2026-09-19", to: "2026-10-18", days: 30 });
    expect(range({}, NOW).period).toBe("last30");
    const month = range({ period: "this_month" }, NOW);
    expect(month).toMatchObject({ from: "2026-10-01", to: "2026-10-18" });
    expect(month.previous).toMatchObject({ from: "2026-09-01", to: "2026-09-18" });
    expect(range({ period: "last_month" }, NOW)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
      previous: { from: "2026-08-01", to: "2026-08-31" },
    });
    // 31 March compares with all of February, never days of March
    const march = range({ period: "this_month" }, new Date("2026-03-31T10:00:00Z"));
    expect(march.previous).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    const custom = range({ period: "custom", from: "2026-09-01", to: "2026-09-10" }, NOW);
    expect(custom).toMatchObject({ days: 10, previous: { from: "2026-08-22", to: "2026-08-31" } });
  });

  it("rejects bad, reversed, future and excessive ranges", () => {
    const err = (input: RangeInput) => {
      const r = resolveRange(input, NOW);
      return r.ok ? null : { field: r.field, message: r.message };
    };
    expect(err({ period: "forever" })).toMatchObject({ field: "period" });
    expect(err({ period: "custom", from: "2026-02-30", to: "2026-03-01" })).toMatchObject({ field: "from" });
    expect(err({ period: "custom", from: "2026-1-01", to: "2026-03-01" })).toMatchObject({ field: "from" });
    expect(err({ period: "custom", from: "2026-01-01", to: "NaN" })).toMatchObject({ field: "to" });
    expect(err({ period: "custom", from: "2026-01-01" })).toMatchObject({ field: "to" });
    expect(err({ period: "custom", from: "2026-10-10", to: "2026-10-01" })).toMatchObject({ field: "from" });
    expect(err({ period: "custom", from: "2026-10-01", to: "2026-10-19" })).toMatchObject({ field: "to", message: /future/ });
    expect(err({ period: "custom", from: "2023-12-31", to: "2024-01-05" })).toMatchObject({ field: "from" });
    expect(err({ period: "custom", from: "2025-10-17", to: "2026-10-18" })).toMatchObject({ field: "to", message: /366/ });
    // the same day, and a full 366-day range, are fine
    expect(err({ period: "custom", from: "2026-10-18", to: "2026-10-18" })).toBeNull();
    expect(err({ period: "custom", from: "2025-10-18", to: "2026-10-18" })).toBeNull();
  });

  it("groups long ranges by week, with every day in exactly one bucket", () => {
    const short = range({ period: "custom", from: "2026-01-01", to: "2026-03-03" }, NOW);
    expect(short.days).toBe(DAILY_MAX_DAYS);
    expect(short.granularity).toBe("day");
    const long = range({ period: "custom", from: "2026-01-01", to: "2026-03-04" }, NOW);
    expect(long.granularity).toBe("week");
    const buckets = bucketsOf(long);
    expect(buckets[0]).toEqual({ from: "2026-01-01", to: "2026-01-07" });
    expect(buckets.at(-1)).toEqual({ from: "2026-02-26", to: "2026-03-04" });
    expect(buckets).toHaveLength(9);
  });

  it("never divides by zero when comparing", () => {
    expect(changeOf(5, null)).toEqual({ difference: null, percent: null });
    expect(changeOf(5, 0)).toEqual({ difference: 5, percent: null });
    expect(changeOf(0, 0)).toEqual({ difference: 0, percent: null });
    expect(changeOf(150, 100)).toEqual({ difference: 50, percent: 50 });
    expect(changeOf(1, 3)).toEqual({ difference: -2, percent: -66.7 });
  });
});

// --- CSV -----------------------------------------------------------------------------

describe("CSV cells", () => {
  it("defuses anything a spreadsheet could run as a formula", () => {
    for (const bad of ["=1+1", "+2348012345678", "-10", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(bad)).toBe(`"'${bad}"`);
    expect(csvCell('Eggs "large"')).toBe('"Eggs ""large"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(-500)).toBe("-500"); // numbers stay numbers
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe('"a","b"\r\n1,"x"\r\n');
  });
});

// --- seller metrics --------------------------------------------------------------------

describe("seller sales overview", () => {
  /**
   * One seller, two listings, and five orders: paid; paid after a failed
   * attempt; paid then cancelled (refunded); unpaid and cancelled; unpaid.
   */
  async function shop() {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const broilers = await listProduct(seller.cookie, { name: "Broiler chicken", category: "live-birds", unit: "bird", priceKobo: 10_000_00 });
    const customer = await buyer();
    const paid = await place(customer.cookie, eggs.id, 2);
    await pay(customer.cookie, paid.id);
    const retried = await place(customer.cookie, eggs.id, 1);
    expect(await attempt(customer.cookie, retried.id, "failed")).toBe("failed");
    await pay(customer.cookie, retried.id);
    const refunded = await place(customer.cookie, eggs.id, 1);
    await pay(customer.cookie, refunded.id);
    expect(dataOf(await cancel(customer.cookie, refunded.id)).order.paymentStatus).toBe("refunded");
    const dropped = await place(customer.cookie, eggs.id, 3);
    expect((await cancel(customer.cookie, dropped.id)).status).toBe(200);
    const waiting = await place(customer.cookie, eggs.id, 5);
    return { seller, eggs, broilers, customer, orders: { paid, retried, refunded, dropped, waiting } };
  }

  it("counts each paid order once and never counts unpaid ones as sales", async () => {
    const { seller } = await shop();
    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.overview.current).toEqual({
      placed: 5,
      paid: 3, // the failed attempt isn't a second sale
      completed: 0,
      cancelledUnpaid: 1,
      cancelledPaid: 1,
      refundedOrders: 1,
      salesKobo: 9_000_00 + 4_500_00 + 4_500_00,
      discountKobo: 0,
      promotionOrders: 0,
      refundsKobo: 4_500_00,
    });
    expect(report.overview.previous).toBeNull(); // no earlier history
    expect(report.overview.awaitingPaymentNow).toBe(1);
    expect(report.trend).toHaveLength(7);
    expect(report.trend.reduce((t, p) => t + p.salesKobo, 0)).toBe(report.overview.current.salesKobo);
    expect(report.trend.reduce((t, p) => t + p.paidOrders, 0)).toBe(3);
    expect(report.trend.reduce((t, p) => t + p.placed, 0)).toBe(5);
    expect(report.trend.reduce((t, p) => t + p.refundsKobo, 0)).toBe(4_500_00);
    expect(report.promotions).toEqual([]);
    expect(numbersIn(report).every(Number.isFinite)).toBe(true);
  });

  it("ranks products, lists the unsold ones and agrees with the CSV", async () => {
    const { seller, eggs, broilers } = await shop();
    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.products.bySales).toEqual([
      { productId: eggs.id, name: "Fresh eggs", units: 4, orders: 3, salesKobo: 18_000_00 },
    ]);
    expect(report.products.byUnits).toEqual(report.products.bySales);
    expect(report.products.unsold).toEqual([expect.objectContaining({ productId: broilers.id, name: "Broiler chicken", live: true })]);
    expect(report.products.unsoldCount).toBe(1);
    expect(report.products.insufficientHistory).toBe(false);

    const products = await download(sellerExportRoute, "/api/analytics/seller/export?report=products&period=last7", seller.cookie);
    expect(products.status).toBe(200);
    expect(products.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(products.headers.get("cache-control")).toBe("no-store");
    expect(products.headers.get("x-truncated")).toBe("false");
    expect(products.headers.get("x-row-limit")).toBe("1000");
    expect(products.headers.get("content-disposition")).toMatch(/attachment; filename="sales-products-\d{4}-\d\d-\d\d-to-\d{4}-\d\d-\d\d\.csv"/);
    expect(parseCsv(products.text)).toEqual([[...SELLER_COLUMNS.products], [eggs.id, "Fresh eggs", "4", "3", "1800000"]]);

    const trend = parseCsv((await download(sellerExportRoute, "/api/analytics/seller/export?report=trend&period=last7", seller.cookie)).text);
    expect(trend[0]).toEqual([...SELLER_COLUMNS.trend]);
    expect(trend).toHaveLength(8);
    const column = (name: string) => trend.slice(1).reduce((t, row) => t + Number(row[trend[0].indexOf(name)]), 0);
    expect(column("sales_collected_kobo")).toBe(report.overview.current.salesKobo);
    expect(column("paid_orders")).toBe(report.overview.current.paid);
    expect(column("orders_placed")).toBe(report.overview.current.placed);
    expect(column("refunds_kobo")).toBe(report.overview.current.refundsKobo);
  });

  it("says when there's too little history to rank products", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    await pay(customer.cookie, (await place(customer.cookie, eggs.id, 1)).id);
    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.products.insufficientHistory).toBe(true);
  });

  it("caps the products considered and says so", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const broilers = await listProduct(seller.cookie, { name: "Broiler chicken", priceKobo: 10_000_00 });
    const customer = await buyer();
    await pay(customer.cookie, (await place(customer.cookie, eggs.id, 1)).id);
    await pay(customer.cookie, (await place(customer.cookie, broilers.id, 1)).id);
    const result = await sellerProductSales(seller.userId, range(), 1);
    expect(result).toEqual({ truncated: true, rows: [expect.objectContaining({ productId: broilers.id })] });
    expect((await sellerProductSales(seller.userId, range(), 2)).truncated).toBe(false);
  });

  it("counts an expired order as cancelled before payment, never as a sale", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    const order = await place(customer.cookie, eggs.id, 1);
    expect(await attempt(customer.cookie, order.id, "failed")).toBe("failed");
    // what the order job does when the reservation runs out
    const { orders } = await collections();
    await orders.updateOne(
      { _id: new ObjectId(order.id) },
      { $set: { paymentStatus: "cancelled", fulfillmentStatus: "cancelled", cancelledAt: new Date() } },
    );
    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.overview.current).toMatchObject({ placed: 1, paid: 0, salesKobo: 0, cancelledUnpaid: 1, cancelledPaid: 0 });
    expect(report.products.bySales).toEqual([]);
  });

  it("handles old orders missing newer fields", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    const order = await place(customer.cookie, eggs.id, 2);
    await pay(customer.cookie, order.id);
    // an order from before promotions existed: no promotion or line discount fields
    await (await collections()).orders.updateOne({ _id: new ObjectId(order.id) }, { $unset: { promotion: "", "items.$[].discountKobo": "" } });
    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.overview.current).toMatchObject({ paid: 1, salesKobo: 9_000_00, discountKobo: 0, promotionOrders: 0 });
    expect(report.products.bySales[0]).toMatchObject({ units: 2, salesKobo: 9_000_00 });
    expect(numbersIn(report).every(Number.isFinite)).toBe(true);
  });

  it("is all zeros, with nothing to compare, for a new seller", async () => {
    const seller = await farmer();
    const { report } = dataOf(await sellerReport(seller.cookie, "period=last30"));
    expect(report.overview.previous).toBeNull();
    expect(Object.values(report.overview.current).every((v) => v === 0)).toBe(true);
    expect(report.trend).toHaveLength(30);
    expect(report.products).toMatchObject({ bySales: [], byUnits: [], unsold: [], unsoldCount: 0, insufficientHistory: true });
    expect(report.earnings.ledger).toEqual({ earningsKobo: 0, feesKobo: 0, refundsKobo: 0, netKobo: 0, payoutsPaidKobo: 0, payoutReleasesKobo: 0 });
    expect(report.earnings.balances).toEqual(await getWalletSummary(seller.userId));
    expect(numbersIn(report).every(Number.isFinite)).toBe(true);
    const csv = parseCsv((await download(sellerExportRoute, "/api/analytics/seller/export?report=promotions", seller.cookie)).text);
    expect(csv).toEqual([[...SELLER_COLUMNS.promotions]]);
  });
});

describe("period boundaries and comparison", () => {
  it("counts an instant in exactly one period and compares with the one before", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    const { orders } = await collections();
    const r = range({ period: "custom", from: "2026-09-01", to: "2026-09-30" });
    const at = async (instant: string) => {
      const order = await place(customer.cookie, eggs.id, 1);
      await pay(customer.cookie, order.id);
      await orders.updateOne({ _id: new ObjectId(order.id) }, { $set: { createdAt: new Date(instant), paidAt: new Date(instant) } });
    };
    await at(r.start); // first instant: in
    await at(new Date(new Date(r.end).getTime() - 1).toISOString()); // last millisecond: in
    await at(r.end); // the next period's first instant: out
    await at(r.previous.start); // the previous period

    const report = await getSellerReport(seller.userId, r);
    expect(report.overview.current).toMatchObject({ placed: 2, paid: 2, salesKobo: 9_000_00 });
    expect(report.overview.previous).toMatchObject({ placed: 1, paid: 1, salesKobo: 4_500_00 });
    // Lagos days: the first instant is 1 Sep, the last is 30 Sep
    expect(report.trend[0]).toMatchObject({ from: "2026-09-01", paidOrders: 1 });
    expect(report.trend.at(-1)).toMatchObject({ from: "2026-09-30", paidOrders: 1 });
    const next = await getSellerReport(seller.userId, range({ period: "custom", from: "2026-10-01", to: "2026-10-01" }));
    expect(next.overview.current).toMatchObject({ paid: 1, salesKobo: 4_500_00 });
  });
});

describe("seller earnings", () => {
  it("takes earnings, fees and refunds from the ledger and balances from the wallet", async () => {
    setCommission(1000); // 10%
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    const order = await place(customer.cookie, eggs.id, 2);
    await pay(customer.cookie, order.id);
    for (const action of ["accept", "ship", "deliver"]) expect((await fulfil(seller.cookie, order.id, action)).status).toBe(200);
    expect((await refund(seller.cookie, order.id, 3_000_00)).status).toBe(200);

    const { report } = dataOf(await sellerReport(seller.cookie));
    // fee 10% of ₦9,000; the seller's share of a ₦3,000 refund is ₦3,000 less its ₦300 fee
    expect(report.earnings.ledger).toMatchObject({ earningsKobo: 9_000_00, feesKobo: 900_00, refundsKobo: 2_700_00, netKobo: 5_400_00 });
    expect(report.earnings.balances).toEqual(await getWalletSummary(seller.userId));
    expect(report.earnings.paidNotInLedgerNow).toBe(0);
    expect(report.overview.current).toMatchObject({ salesKobo: 9_000_00, refundsKobo: 3_000_00, completed: 1, refundedOrders: 1 });

    const { report: all } = dataOf(await adminReport((await adminAccount()).cookie));
    expect(all.financial).toMatchObject({ paidKobo: 9_000_00, refundsKobo: 3_000_00, netCapturedKobo: 6_000_00, feesReturnedKobo: 300_00 });
    expect(all.financial.ledger).toMatchObject({ earningsKobo: 9_000_00, feesKobo: 900_00, refundsKobo: 2_700_00 });
  });

  it("shows paid orders the ledger doesn't have without estimating them", async () => {
    // no commission policy: the payment is recorded, the earning isn't
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    await pay(customer.cookie, (await place(customer.cookie, eggs.id, 1)).id);
    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.overview.current.salesKobo).toBe(4_500_00);
    expect(report.earnings.ledger.earningsKobo).toBe(0);
    expect(report.earnings.paidNotInLedgerNow).toBe(1);
  });

  it("splits payouts by status and by when each thing happened", async () => {
    const seller = await farmer();
    const other = await farmer();
    const { payouts } = await collections();
    const now = Date.now();
    const payout = (userId: ObjectId, status: PayoutDoc["status"], amountKobo: number, extra: Partial<PayoutDoc> = {}) =>
      ({
        _id: new ObjectId(),
        userId,
        status,
        amountKobo,
        idempotencyKey: randomUUID(),
        reference: `po_${randomUUID()}`,
        requestedAt: new Date(now - HOUR),
        paidAt: status === "paid" ? new Date(now - HOUR / 2) : null,
        failedAt: status === "failed" ? new Date(now - HOUR / 2) : null,
        ...extra,
      }) as unknown as PayoutDoc;
    await payouts.insertMany([
      payout(seller.userId, "requested", 1_000_00),
      payout(seller.userId, "processing", 2_000_00),
      payout(seller.userId, "paid", 3_000_00),
      payout(seller.userId, "failed", 4_000_00),
      // requested long ago, paid in this period
      payout(seller.userId, "paid", 5_000_00, { requestedAt: new Date(now - 40 * 24 * HOUR) }),
      payout(other.userId, "paid", 9_999_00), // someone else's
    ]);
    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.earnings.payouts).toEqual({
      requested: {
        requested: { count: 1, amountKobo: 1_000_00 },
        processing: { count: 1, amountKobo: 2_000_00 },
        paid: { count: 1, amountKobo: 3_000_00 },
        failed: { count: 1, amountKobo: 4_000_00 },
      },
      paidInPeriod: { count: 2, amountKobo: 8_000_00 },
      failedInPeriod: { count: 1, amountKobo: 4_000_00 },
    });
    const { report: all } = dataOf(await adminReport((await adminAccount()).cookie));
    expect(all.financial.payouts).toEqual({
      requested: { count: 5, amountKobo: 19_999_00 },
      paid: { count: 3, amountKobo: 17_999_00 },
      failed: { count: 1, amountKobo: 4_000_00 },
      inProgressNow: { count: 2, amountKobo: 3_000_00 },
    });
  });
});

describe("seller promotions", () => {
  it("counts paid orders and redeemed uses from the order snapshot, not reserved ones", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const promotion = await livePromotion(seller.cookie, { code: "HARVEST10" });
    const customer = await buyer();
    const paid = await place(customer.cookie, eggs.id, 2, { couponCode: "HARVEST10" });
    expect(await attempt(customer.cookie, paid.id, "failed")).toBe("failed");
    await pay(customer.cookie, paid.id);
    await place(customer.cookie, eggs.id, 2, { couponCode: "HARVEST10" }); // unpaid: a reserved use
    await place(customer.cookie, eggs.id, 1); // no promotion
    // changed afterwards: the label follows the promotion, the amounts stay as the order was priced
    await (await collections()).promotions.updateOne({ _id: new ObjectId(promotion.id) }, { $set: { name: "Renamed", value: 50 } });

    const { report } = dataOf(await sellerReport(seller.cookie));
    expect(report.promotions).toEqual([
      {
        promotionId: promotion.id,
        name: "Renamed",
        state: "live",
        code: "HARVEST10",
        paidOrders: 1,
        redeemedUses: 1,
        reservedUsesNow: 1,
        discountKobo: 900_00,
        salesKobo: 8_100_00,
      },
    ]);
    expect(report.overview.current).toMatchObject({ paid: 1, salesKobo: 8_100_00, discountKobo: 900_00, promotionOrders: 1, placed: 3 });

    const csv = parseCsv((await download(sellerExportRoute, "/api/analytics/seller/export?report=promotions&period=last7", seller.cookie)).text);
    expect(csv).toEqual([
      [...SELLER_COLUMNS.promotions],
      [promotion.id, "Renamed", "live", "HARVEST10", "1", "1", "1", "90000", "810000"],
    ]);
  });
});

// --- admin metrics --------------------------------------------------------------------

async function adminAccount() {
  const account = await farmer();
  allow(account);
  return account;
}

describe("admin analytics", () => {
  it("reports accounts, orders, listings and the same exception counts as the queues", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    await listProduct(seller.cookie, { name: "Old stock" });
    const customer = await buyer();
    const order = await place(customer.cookie, eggs.id, 2);
    await pay(customer.cookie, order.id);
    await place(customer.cookie, eggs.id, 1);
    const admin = await adminAccount();

    const { report } = dataOf(await adminReport(admin.cookie));
    expect(report.accounts.byRole).toEqual([
      { role: "poultry-farmer", total: 2, verified: 2 },
      { role: "veterinarian", total: 1, verified: 1 },
    ]);
    expect(report.accounts.newInPeriod.reduce((t, r) => t + r.count, 0)).toBe(3);
    expect(report.orders.current).toMatchObject({ placed: 2, paid: 1, salesKobo: 9_000_00 });
    expect(report.orders.paymentStatusNow).toEqual(
      expect.arrayContaining([{ status: "paid", count: 1 }, { status: "pending", count: 1 }]),
    );
    expect(report.listings).toEqual({ liveNow: 2, hiddenNow: 0, archivedNow: 0, newInPeriod: 2 });
    expect(report.sellers).toMatchObject({ withPaidOrders: 1, withLiveListingsNow: 1 });
    expect(report.financial.netCapturedKobo).toBe(report.financial.paidKobo - report.financial.refundsKobo);
    expect(report.operational.paidNotInLedger).toBe(1);
    expect(report.trend.reduce((t, p) => t + p.newAccounts, 0)).toBe(3);
    expect(numbersIn(report).every(Number.isFinite)).toBe(true);

    const summary = dataOf(await call<AdminSummary>(summaryRoute, "/api/admin/summary", { cookie: admin.cookie }));
    expect(report.operational).toMatchObject({
      openIssues: summary.openIssues,
      flaggedOrders: summary.flaggedOrders,
      flaggedPayouts: summary.flaggedPayouts,
      failedDeliveries: summary.failedDeliveries,
    });

    const csv = await download(adminExportRoute, "/api/admin/analytics/export?report=trend&period=last7", admin.cookie);
    expect(csv.status).toBe(200);
    const rows = parseCsv(csv.text);
    expect(rows[0]).toEqual(["date_from", "date_to", "orders_placed", "paid_orders", "paid_kobo", "refunds_kobo", "new_accounts"]);
    expect(rows.slice(1).reduce((t, r) => t + Number(r[4]), 0)).toBe(report.financial.paidKobo);
    expect(rows.slice(1).reduce((t, r) => t + Number(r[6]), 0)).toBe(3);
  });

  it("is only for configured admins", async () => {
    const seller = await farmer();
    const vet = await buyer();
    for (const res of [await adminReport(seller.cookie), await adminReport(vet.cookie)]) expect(res.status).toBe(404);
    expect((await adminReport("")).status).toBe(401);
    expect((await download(adminExportRoute, "/api/admin/analytics/export?report=trend", seller.cookie)).status).toBe(404);
    expect((await download(adminExportRoute, "/api/admin/analytics/export?report=trend", null)).status).toBe(401);
    // a forged role or admin flag in the request changes nothing
    expect((await adminReport(seller.cookie, `period=last7&admin=true&role=admin&userId=${seller.userId.toHexString()}`)).status).toBe(404);
    allow(seller);
    expect((await adminReport(seller.cookie)).status).toBe(200);
  });

  it("validates the range and the report name", async () => {
    const admin = await adminAccount();
    const bad = await adminReport(admin.cookie, "period=custom&from=2025-01-01&to=2026-06-30");
    expect(bad.status).toBe(400);
    expect(fieldErrorsOf(bad)).toHaveProperty("to");
    const csv = await download(adminExportRoute, "/api/admin/analytics/export?report=users&period=last7", admin.cookie);
    expect(csv.status).toBe(400);
    expect(JSON.parse(csv.text)).toMatchObject({ ok: false, fieldErrors: { report: expect.any(String) } });
  });
});

// --- security --------------------------------------------------------------------------

describe("who can see seller insights", () => {
  it("needs a session and a selling account", async () => {
    expect((await sellerReport("")).status).toBe(401);
    expect((await download(sellerExportRoute, "/api/analytics/seller/export?report=trend", null)).status).toBe(401);
    const vet = await buyer();
    const res = await sellerReport(vet.cookie);
    expect(res.status).toBe(403);
    expect(errorOf(res)).toMatch(/poultry farmers/);
    expect((await download(sellerExportRoute, "/api/analytics/seller/export?report=trend", vet.cookie)).status).toBe(403);
  });

  it("only ever shows the signed-in seller's own figures", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    await pay(customer.cookie, (await place(customer.cookie, eggs.id, 2)).id);
    const rival = await farmer();
    const forged = `period=last7&userId=${seller.userId.toHexString()}&sellerUserId=${seller.userId.toHexString()}`;
    const { report } = dataOf(await sellerReport(rival.cookie, forged));
    expect(report.overview.current.salesKobo).toBe(0);
    expect(report.products.bySales).toEqual([]);
    const csv = await download(sellerExportRoute, `/api/analytics/seller/export?report=products&${forged}`, rival.cookie);
    expect(parseCsv(csv.text)).toEqual([[...SELLER_COLUMNS.products]]);
    expect(dataOf(await sellerReport(seller.cookie, forged)).report.overview.current.salesKobo).toBe(9_000_00);
  });

  it("rejects invalid or excessive ranges", async () => {
    const seller = await farmer();
    for (const [query, field] of [
      ["period=yesterday", "period"],
      ["period=custom&from=2026-13-01&to=2026-10-01", "from"],
      ["period=custom&from=2024-01-01&to=2026-01-01", "to"],
      ["period=custom&from=2026-10-01&to=2099-01-01", "to"],
    ] as const) {
      const res = await sellerReport(seller.cookie, query);
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty(field);
    }
    const csv = await download(sellerExportRoute, "/api/analytics/seller/export?period=last7", seller.cookie);
    expect(csv.status).toBe(400);
  });

  it("keeps personal and payment details out of CSVs and defuses formulas", async () => {
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    const order = await place(customer.cookie, eggs.id, 1);
    await pay(customer.cookie, order.id);
    const c = await collections();
    await c.products.updateOne({ _id: new ObjectId(eggs.id) }, { $set: { name: '=HYPERLINK("http://x.invalid","Eggs")' } });

    const csv = await download(sellerExportRoute, "/api/analytics/seller/export?report=products&period=last7", seller.cookie);
    expect(parseCsv(csv.text)[1][1]).toBe(`'=HYPERLINK("http://x.invalid","Eggs")`);
    const users = await c.users.find({}).toArray();
    const stored = (await c.orders.findOne({ _id: new ObjectId(order.id) }))!;
    const payment = await c.orderPayments.findOne({ orderId: stored._id });
    for (const secret of [...users.map((u) => u.phoneNormalized), stored.number, payment?.reference].filter(Boolean) as string[])
      expect(csv.text).not.toContain(secret);
  });

  it("limits CSV downloads per account", async () => {
    const seller = await farmer();
    for (let i = 0; i < 30; i++)
      expect((await download(sellerExportRoute, "/api/analytics/seller/export?report=trend&period=last7", seller.cookie)).status).toBe(200);
    const limited = await download(sellerExportRoute, "/api/analytics/seller/export?report=trend&period=last7", seller.cookie);
    expect(limited.status).toBe(429);
  });
});

describe("reports are read-only", () => {
  it("doesn't change any record, including the ledger", async () => {
    setCommission(1000);
    const seller = await farmer();
    const eggs = await listProduct(seller.cookie);
    const customer = await buyer();
    const order = await place(customer.cookie, eggs.id, 2);
    await pay(customer.cookie, order.id);
    await place(customer.cookie, eggs.id, 1);
    const admin = await adminAccount();
    const before = await snapshot();

    expect((await sellerReport(seller.cookie)).status).toBe(200);
    for (const report of ["trend", "products", "promotions"])
      expect((await download(sellerExportRoute, `/api/analytics/seller/export?report=${report}`, seller.cookie)).status).toBe(200);
    expect((await adminReport(admin.cookie)).status).toBe(200);
    expect((await download(adminExportRoute, "/api/admin/analytics/export?report=trend", admin.cookie)).status).toBe(200);
    await getAdminReport(range());
    await getSellerReport(seller.userId, range({ period: "last_month" }));

    expect(await snapshot()).toBe(before);
  });
});

