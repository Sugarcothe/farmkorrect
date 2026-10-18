import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { POST as processRoute } from "@/app/api/internal/orders/process/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { GET as orderRoute } from "@/app/api/orders/[id]/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { POST as quoteRoute } from "@/app/api/orders/quote/route";
import { POST as placeRoute } from "@/app/api/orders/route";
import { POST as addProductRoute } from "@/app/api/products/route";
import { GET as promotionRoute, PATCH as editRoute } from "@/app/api/promotions/[id]/route";
import { POST as statusRoute } from "@/app/api/promotions/[id]/status/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/promotions/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import { POST as refundRoute } from "@/app/api/sales/[id]/refund/route";
import { DEFAULT_MARKET_QUERY } from "@/lib/market/query";
import type { CheckoutResponse, OrderResponse, ProductResponse, VerifyPaymentResponse } from "@/lib/orders/types";
import { allocate, applyPromotion, isDiscount, type PricingRule } from "@/lib/promotions/pricing";
import type { Promotion, PromotionResponse, PromotionsResponse, QuoteResponse } from "@/lib/promotions/types";
import { normalizeCouponCode } from "@/lib/promotions/types";
import { validateCouponCode, validatePromotionValue } from "@/lib/promotions/validation";
import { searchMarket } from "@/lib/server/market";
import { findMarketProduct } from "@/lib/server/products";
import { collections } from "./support/db";
import { call, dataOf, ORIGIN, type CallOptions, type CallResult } from "./support/http";
import { completeCheckout, paystack } from "./support/paystack";
import { merchant } from "./support/wallet";

// Seller promotions end to end: the seller's API, pricing at checkout, the
// payment (Paystack is faked: tests/support/paystack.ts), limits under
// concurrency, cancellation, refunds and the ledger.

const JOB_SECRET = "test-order-job-secret-at-least-32-chars!";
const HOUR = 60 * 60_000;

type Ctx = { params: Promise<{ id: string }> };
type RouteWithId = (request: Request, context: Ctx) => Promise<Response>;

function callId<T>(handler: RouteWithId, path: string, id: string, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve({ id }) }), path, options);
}

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 10, description: "" };
const NOTE = "Deliver to 12 Ring Road, Ibadan. Call on arrival.";

const setCommission = (bps: number, id = "test-policy") => {
  vi.stubEnv("COMMISSION_POLICY_ID", id);
  vi.stubEnv("COMMISSION_RATE_BPS", String(bps));
};

const farmer = () => merchant("poultry-farmer");
const buyer = () => merchant("veterinarian");

async function listProduct(cookie: string, overrides: Partial<typeof EGGS> = {}) {
  return dataOf(await call<ProductResponse>(addProductRoute, "/api/products", { body: { ...EGGS, ...overrides }, cookie })).product;
}

/** A full promotion body: a 10% automatic sale on everything, running now. */
function fields(overrides: Record<string, unknown> = {}) {
  return {
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
}

const create = (cookie: string, body: Record<string, unknown>, options: Partial<CallOptions> = {}) =>
  call<PromotionResponse>(createRoute, "/api/promotions", { body, cookie, ...options });
const setStatus = (cookie: string, promotion: Pick<Promotion, "id" | "version">, action: string) =>
  callId<PromotionResponse>(statusRoute, `/api/promotions/${promotion.id}/status`, promotion.id, {
    cookie,
    body: { action, expectedVersion: promotion.version },
  });
const edit = (cookie: string, promotion: Pick<Promotion, "id" | "version">, body: Record<string, unknown>) =>
  callId<PromotionResponse>(editRoute, `/api/promotions/${promotion.id}`, promotion.id, {
    cookie,
    method: "PATCH",
    body: { ...body, expectedVersion: promotion.version },
  });

/** Creates and activates a promotion for the seller. */
async function livePromotion(cookie: string, overrides: Record<string, unknown> = {}) {
  const created = await create(cookie, fields(overrides));
  expect(created.status).toBe(201);
  const res = await setStatus(cookie, dataOf(created).promotion, "activate");
  expect(res.status).toBe(200);
  return dataOf(res).promotion;
}

function place(cookie: string, items: { productId: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  return call<OrderResponse>(placeRoute, "/api/orders", {
    body: { items, fulfillmentMethod: "pickup", deliveryNote: NOTE, idempotencyKey: randomUUID(), ...extra },
    cookie,
  });
}
const quote = (cookie: string, body: Record<string, unknown>) =>
  call<QuoteResponse>(quoteRoute, "/api/orders/quote", { body, cookie });
const quoted = async (cookie: string, body: Record<string, unknown>) => dataOf(await quote(cookie, body)).quote;
const checkout = (cookie: string, id: string) =>
  callId<CheckoutResponse>(checkoutRoute, `/api/orders/${id}/checkout`, id, { cookie, body: {} });
const verify = (cookie: string, id: string, reference: string) =>
  callId<VerifyPaymentResponse>(verifyRoute, `/api/orders/${id}/verify-payment`, id, { cookie, body: { reference } });
const getOrder = (cookie: string, id: string) => callId<OrderResponse>(orderRoute, `/api/orders/${id}`, id, { cookie });
const fulfil = (cookie: string, id: string, action: string) =>
  callId<OrderResponse>(fulfilRoute, `/api/sales/${id}/fulfillment`, id, { cookie, body: { action } });

async function pay(cookie: string, id: string) {
  const { reference } = dataOf(await checkout(cookie, id));
  completeCheckout(reference);
  expect(dataOf(await verify(cookie, id, reference)).result).toBe("paid");
  return reference;
}

const runJob = () =>
  processRoute(
    new Request(`${ORIGIN}/api/internal/orders/process`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${JOB_SECRET}` },
      body: "{}",
    }),
  );

const storedOrder = async (id: string) => (await (await collections()).orders.findOne({ _id: new ObjectId(id) }))!;
const storedPromotion = async (id: string) => (await (await collections()).promotions.findOne({ _id: new ObjectId(id) }))!;
const redemptionFor = async (orderId: string) =>
  (await collections()).redemptions.findOne({ orderId: new ObjectId(orderId) });
const entriesFor = async (number: string) =>
  (await collections()).ledger.find({ "source.type": "order", "source.id": number }).sort({ sequence: 1 }).toArray();

/** A seller with a listing and a buyer. */
async function market(listing: Partial<typeof EGGS> = {}) {
  const seller = await farmer();
  const product = await listProduct(seller.cookie, listing);
  const customer = await buyer();
  return { seller, product, customer };
}

// --- the arithmetic -----------------------------------------------------------------------------

describe("pricing", () => {
  const rule = (overrides: Partial<PricingRule> = {}): PricingRule => ({
    type: "percentage",
    value: 10,
    scope: "all",
    productIds: [],
    minOrderKobo: null,
    maxDiscountKobo: null,
    ...overrides,
  });

  it("rounds percentages down to the kobo and respects the cap", () => {
    const result = applyPromotion(rule({ value: 15 }), [{ productId: "a", lineTotalKobo: 333 }]);
    expect(result).toEqual({ eligibleSubtotalKobo: 333, discountKobo: 49, lineDiscounts: [49] }); // 49.95 → 49
    const capped = applyPromotion(rule({ value: 50, maxDiscountKobo: 1_000_00 }), [{ productId: "a", lineTotalKobo: 9_000_00 }]);
    expect(isDiscount(capped) && capped.discountKobo).toBe(1_000_00);
  });

  it("only discounts eligible products, and measures the minimum on them", () => {
    const lines = [
      { productId: "a", lineTotalKobo: 4_000_00 },
      { productId: "b", lineTotalKobo: 6_000_00 },
    ];
    const some = rule({ scope: "products", productIds: ["b"], value: 50 });
    expect(applyPromotion(some, lines)).toEqual({ eligibleSubtotalKobo: 6_000_00, discountKobo: 3_000_00, lineDiscounts: [0, 3_000_00] });
    // ₦10,000 in the order, but only ₦6,000 of it is eligible
    expect(applyPromotion({ ...some, minOrderKobo: 8_000_00 }, lines)).toEqual({
      reason: "below_minimum",
      minOrderKobo: 8_000_00,
      eligibleSubtotalKobo: 6_000_00,
    });
    expect(applyPromotion(rule({ scope: "products", productIds: ["z"] }), lines)).toEqual({ reason: "no_eligible_items" });
  });

  it("never takes off more than the eligible products, and always leaves ₦1 to pay", () => {
    const fixed = rule({ type: "fixed", value: 5_000_00, scope: "products", productIds: ["a"] });
    const lines = [
      { productId: "a", lineTotalKobo: 1_000_00 },
      { productId: "b", lineTotalKobo: 2_000_00 },
    ];
    expect(applyPromotion(fixed, lines)).toMatchObject({ discountKobo: 1_000_00, lineDiscounts: [1_000_00, 0] });
    const whole = applyPromotion(rule({ type: "fixed", value: 5_000_00 }), [{ productId: "a", lineTotalKobo: 3_000_00 }]);
    expect(isDiscount(whole) && whole.discountKobo).toBe(3_000_00 - 100);
    expect(applyPromotion(rule({ type: "fixed", value: 500 }), [{ productId: "a", lineTotalKobo: 100 }])).toEqual({ reason: "no_saving" });
  });

  it("splits a discount across lines exactly, in proportion", () => {
    expect(allocate(100, [100, 100, 100])).toEqual([34, 33, 33]);
    expect(allocate(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(() => allocate(4, [1, 1, 1])).toThrow(RangeError);
    for (const [discount, totals] of [
      [999, [333, 333, 334]],
      [12_345, [10_000, 70_001, 1]],
      [7, [3, 4]],
    ] as const) {
      const split = allocate(discount, totals);
      expect(split.reduce((a, b) => a + b, 0)).toBe(discount);
      split.forEach((s, i) => expect(s).toBeLessThanOrEqual(totals[i]));
    }
  });

  it("validates values and normalizes codes", () => {
    expect(validatePromotionValue("percentage", 0)).toBeTruthy();
    expect(validatePromotionValue("percentage", 91)).toBeTruthy();
    expect(validatePromotionValue("percentage", 12.5)).toBeTruthy();
    expect(validatePromotionValue("percentage", 90)).toBeUndefined();
    expect(validatePromotionValue("fixed", 0)).toBeTruthy();
    expect(validatePromotionValue("fixed", -500)).toBeTruthy();
    expect(validatePromotionValue("fixed", 100.5)).toBeTruthy();
    expect(validatePromotionValue("fixed", 500_00)).toBeUndefined();
    expect(normalizeCouponCode("  harvest-10 ")).toBe("HARVEST-10");
    expect(validateCouponCode("harvest-10")).toBeUndefined();
    expect(validateCouponCode("no spaces")).toBeTruthy();
    expect(validateCouponCode("A--B1")).toBeTruthy();
    expect(validateCouponCode("ABC")).toBeTruthy();
  });
});

// --- the seller's promotions ------------------------------------------------------------------

describe("managing promotions", () => {
  it("creates drafts for the signed-in seller only, from their own products", async () => {
    const seller = await farmer();
    const product = await listProduct(seller.cookie);
    const other = await farmer();
    const theirs = await listProduct(other.cookie);

    expect((await call(createRoute, "/api/promotions", { body: fields() })).status).toBe(401);
    expect((await create((await buyer()).cookie, fields())).status).toBe(403);
    expect((await create(seller.cookie, fields(), { origin: "https://evil.example" })).status).toBe(403);

    // the seller, status and counts can't be chosen
    const forged = await create(seller.cookie, { ...fields(), sellerUserId: other.userId.toHexString(), status: "active", redemptionCount: 5 });
    expect(forged.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(forged)).sort()).toEqual(["redemptionCount", "sellerUserId", "status"]);

    const stolen = await create(seller.cookie, fields({ scope: "products", productIds: [theirs.id] }));
    expect(stolen.status).toBe(400);
    expect(fieldErrorsOf(stolen).productIds).toBeTruthy();

    const res = await create(seller.cookie, fields({ scope: "products", productIds: [product.id], code: " harvest-10 " }));
    expect(res.status).toBe(201);
    const { promotion } = dataOf(res);
    expect(promotion).toMatchObject({ status: "draft", state: "draft", version: 1, code: "HARVEST-10", redemptionCount: 0 });
    expect(promotion.products).toEqual([{ id: product.id, name: EGGS.name }]);
    expect((await storedPromotion(promotion.id)).sellerUserId.equals(seller.userId)).toBe(true);

    // codes are unique across sellers, whatever the case
    const taken = await create(other.cookie, fields({ code: "Harvest-10" }));
    expect(taken.status).toBe(409);
    expect(fieldErrorsOf(taken).code).toMatch(/already in use/);

    // another seller can't see or change it
    const peek = await callId(promotionRoute, `/api/promotions/${promotion.id}`, promotion.id, { cookie: other.cookie });
    expect(peek.status).toBe(404);
    expect((await setStatus(other.cookie, promotion, "activate")).status).toBe(404);
    expect((await edit(other.cookie, promotion, fields({ name: "Hijacked" }))).status).toBe(404);
    expect(dataOf(await call<PromotionsResponse>(listRoute, "/api/promotions", { cookie: other.cookie })).promotions).toEqual([]);
    expect(dataOf(await call<PromotionsResponse>(listRoute, "/api/promotions", { cookie: seller.cookie })).promotions).toHaveLength(1);
  });

  it("validates values, dates and limits on the server", async () => {
    const seller = await farmer();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ value: 0 }, "value"],
      [{ value: 95 }, "value"],
      [{ type: "fixed", value: -100 }, "value"],
      [{ type: "fixed", value: 500_00, maxDiscountKobo: 100_00 }, "maxDiscountKobo"],
      [{ endsAt: new Date(Date.now() - 1000).toISOString() }, "endsAt"],
      [{ startsAt: new Date(Date.now() + 2 * HOUR).toISOString(), endsAt: new Date(Date.now() + HOUR).toISOString() }, "endsAt"],
      [{ totalLimit: 2, perBuyerLimit: 3 }, "perBuyerLimit"],
      [{ minOrderKobo: 0 }, "minOrderKobo"],
      [{ code: "two words" }, "code"],
      [{ scope: "products", productIds: [] }, "productIds"],
      [{ scope: "all", productIds: [new ObjectId().toHexString()] }, "productIds"],
    ];
    for (const [overrides, field] of cases) {
      const res = await create(seller.cookie, fields(overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(400);
      expect(fieldErrorsOf(res)[field], JSON.stringify(overrides)).toBeTruthy();
    }
    expect(await (await collections()).promotions.countDocuments()).toBe(0);
  });

  it("activates, pauses, edits and ends, refusing stale or out-of-order changes", async () => {
    const seller = await farmer();
    await listProduct(seller.cookie);
    let promotion = dataOf(await create(seller.cookie, fields())).promotion;

    promotion = dataOf(await setStatus(seller.cookie, promotion, "activate")).promotion;
    expect(promotion).toMatchObject({ status: "active", state: "live", version: 2 });

    // live terms can't change under buyers
    const live = await edit(seller.cookie, promotion, fields({ value: 50 }));
    expect(live.status).toBe(409);
    expect(errorOf(live)).toMatch(/Pause/);
    // a stale page is refused
    expect((await setStatus(seller.cookie, { ...promotion, version: 1 }, "pause")).status).toBe(409);

    promotion = dataOf(await setStatus(seller.cookie, promotion, "pause")).promotion;
    expect(promotion.state).toBe("paused");
    promotion = dataOf(await edit(seller.cookie, promotion, fields({ value: 20 }))).promotion;
    expect(promotion).toMatchObject({ value: 20, status: "paused", version: 4 });

    promotion = dataOf(await setStatus(seller.cookie, promotion, "end")).promotion;
    expect(promotion.state).toBe("ended");
    expect((await setStatus(seller.cookie, promotion, "activate")).status).toBe(409);
    expect((await edit(seller.cookie, promotion, fields())).status).toBe(409);
    expect((await storedPromotion(promotion.id)).history.map((h) => h.event)).toEqual([
      "created",
      "activated",
      "paused",
      "edited",
      "ended",
    ]);
  });

  it("shows scheduled and expired promotions for what they are", async () => {
    const seller = await farmer();
    await listProduct(seller.cookie);
    const scheduled = await livePromotion(seller.cookie, {
      startsAt: new Date(Date.now() + HOUR).toISOString(),
      endsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    expect(scheduled.state).toBe("scheduled");
    const running = await livePromotion(seller.cookie, { name: "Second sale" });
    await (await collections()).promotions.updateOne({ _id: new ObjectId(running.id) }, { $set: { endsAt: new Date(Date.now() - 1000) } });
    const listed = dataOf(await call<PromotionsResponse>(listRoute, "/api/promotions", { cookie: seller.cookie })).promotions;
    expect(Object.fromEntries(listed.map((p) => [p.name, p.state]))).toEqual({ "Harvest sale": "scheduled", "Second sale": "expired" });
  });
});

// --- buying with a promotion ---------------------------------------------------------------------

describe("checkout with a promotion", () => {
  it("applies a live sale to the order, the payment and the seller's earning", async () => {
    setCommission(500);
    const { seller, product, customer } = await market();
    const promotion = await livePromotion(seller.cookie);
    const items = [{ productId: product.id, quantity: 2 }];

    const q = (await quoted(customer.cookie, { items }));
    expect(q).toMatchObject({ subtotalKobo: 9_000_00, discountKobo: 900_00, totalKobo: 8_100_00, couponError: null });
    expect(q.promotion).toMatchObject({ name: "Harvest sale", code: null, type: "percentage", value: 10 });

    // the total the buyer saw must be the discounted one
    expect((await place(customer.cookie, items, { expectedTotalKobo: 9_000_00 })).status).toBe(409);
    const res = await place(customer.cookie, items, { expectedTotalKobo: q.totalKobo });
    expect(res.status).toBe(201);
    const { order } = dataOf(res);
    expect(order).toMatchObject({ subtotalKobo: 9_000_00, discountKobo: 900_00, totalKobo: 8_100_00 });
    expect(order.items[0]).toMatchObject({ lineTotalKobo: 9_000_00, discountKobo: 900_00 });
    expect(order.promotion).toMatchObject({ name: "Harvest sale", eligibleSubtotalKobo: 9_000_00, discountKobo: 900_00 });
    expect(await redemptionFor(order.id)).toMatchObject({ status: "reserved", discountKobo: 900_00, totalKobo: 8_100_00 });
    expect((await storedPromotion(promotion.id)).redemptionCount).toBe(1);

    // Paystack is asked for the discounted total, and the order is paid with it
    const reference = await pay(customer.cookie, order.id);
    const init = paystack.requests.find((r) => r.operation === "initialize")!;
    expect(init.body).toMatchObject({ amount: 8_100_00, reference });
    expect(await storedOrder(order.id)).toMatchObject({ paymentStatus: "paid", paidKobo: 8_100_00 });
    expect(await redemptionFor(order.id)).toMatchObject({ status: "redeemed" });

    // the seller funds the discount: the earning is what was paid, the fee its usual share of that
    for (const action of ["accept", "ship", "deliver"]) expect((await fulfil(seller.cookie, order.id, action)).status).toBe(200);
    expect((await entriesFor(order.number)).map((e) => [e.type, e.amountKobo])).toEqual([
      ["earning", 8_100_00],
      ["platform_fee", 405_00],
    ]);

    const stats = dataOf(await call<PromotionsResponse>(listRoute, "/api/promotions", { cookie: seller.cookie })).promotions[0].stats;
    expect(stats).toEqual({ redeemedCount: 1, reservedCount: 0, discountKobo: 900_00, paidKobo: 8_100_00 });
  });

  it("never accepts prices, discounts or a promotion from the browser", async () => {
    const { seller, product, customer } = await market();
    const promotion = await livePromotion(seller.cookie);
    const items = [{ productId: product.id, quantity: 1 }];
    for (const extra of [{ discountKobo: 4_000_00 }, { totalKobo: 100 }, { promotionId: promotion.id }, { promotion: { discountKobo: 1 } }]) {
      const res = await place(customer.cookie, items, extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await quote(customer.cookie, { items, discountKobo: 1 })).status).toBe(400);
    expect((await call(quoteRoute, "/api/orders/quote", { body: { items } })).status).toBe(401);
    expect(await (await collections()).orders.countDocuments()).toBe(0);
  });

  it("uses a coupon code instead of the automatic sale, never both", async () => {
    const { seller, product, customer } = await market();
    await livePromotion(seller.cookie); // 10% automatic
    await livePromotion(seller.cookie, { name: "Coupon", type: "fixed", value: 500_00, code: "EGGS500" });
    const items = [{ productId: product.id, quantity: 2 }];

    expect((await quoted(customer.cookie, { items })).discountKobo).toBe(900_00);
    const coupon = (await quoted(customer.cookie, { items, couponCode: "  eggs500 " }));
    expect(coupon).toMatchObject({ discountKobo: 500_00, totalKobo: 8_500_00, couponError: null });
    expect(coupon.promotion).toMatchObject({ name: "Coupon", code: "EGGS500" });

    const { order } = dataOf(await place(customer.cookie, items, { couponCode: "eggs500", expectedTotalKobo: 8_500_00 }));
    expect(order).toMatchObject({ discountKobo: 500_00, totalKobo: 8_500_00 });
    expect(order.promotion?.code).toBe("EGGS500");
  });

  it("explains codes that can't be used, without revealing other sellers' codes", async () => {
    const { seller, product, customer } = await market();
    const items = [{ productId: product.id, quantity: 1 }];
    const other = await farmer();
    await listProduct(other.cookie);
    await livePromotion(other.cookie, { code: "THEIRS" });
    const draft = dataOf(await create(seller.cookie, fields({ code: "DRAFTY" }))).promotion;
    const paused = await livePromotion(seller.cookie, { code: "PAUSED" });
    await setStatus(seller.cookie, paused, "pause");
    await livePromotion(seller.cookie, {
      code: "LATER",
      startsAt: new Date(Date.now() + HOUR).toISOString(),
      endsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    const expired = await livePromotion(seller.cookie, { code: "OLDONE" });
    await (await collections()).promotions.updateOne({ _id: new ObjectId(expired.id) }, { $set: { endsAt: new Date(Date.now() - 1000) } });
    await livePromotion(seller.cookie, { code: "BIGSPEND", minOrderKobo: 10_000_00 });

    const errors: Record<string, RegExp> = {
      NOPE: /don't recognise/,
      THEIRS: /don't recognise/,
      [draft.code!]: /don't recognise/,
      PAUSED: /paused/,
      LATER: /can be used from/,
      OLDONE: /expired/,
      BIGSPEND: /Spend at least ₦10,000/,
    };
    for (const [code, message] of Object.entries(errors)) {
      const q = (await quoted(customer.cookie, { items, couponCode: code }));
      expect(q.couponError, code).toMatch(message);
      expect(q).toMatchObject({ discountKobo: 0, totalKobo: 4_500_00, promotion: null });
      const res = await place(customer.cookie, items, { couponCode: code });
      expect(res.status, code).toBe(422);
      expect(fieldErrorsOf(res).couponCode).toMatch(message);
    }
    expect(await (await collections()).orders.countDocuments()).toBe(0);
  });

  it("enforces the per-buyer limit, counting unpaid orders that hold a use", async () => {
    const { seller, product, customer } = await market();
    await livePromotion(seller.cookie, { code: "ONCE", perBuyerLimit: 1 });
    const items = [{ productId: product.id, quantity: 1 }];
    expect((await place(customer.cookie, items, { couponCode: "ONCE" })).status).toBe(201);
    const again = await place(customer.cookie, items, { couponCode: "ONCE" });
    expect(again.status).toBe(422);
    expect(fieldErrorsOf(again).couponCode).toMatch(/already used this code/);
    // someone else still can
    expect((await place((await buyer()).cookie, items, { couponCode: "ONCE" })).status).toBe(201);
  });

  it("never lets concurrent orders exceed the total or per-buyer limit", async () => {
    const { seller, product } = await market({ stockQuantity: 50 });
    const promotion = await livePromotion(seller.cookie, { code: "FIRST3", totalLimit: 3 });
    const items = [{ productId: product.id, quantity: 1 }];
    const buyers = await Promise.all(Array.from({ length: 6 }, () => buyer()));
    const results = await Promise.all(buyers.map((b) => place(b.cookie, items, { couponCode: "FIRST3" })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    results.filter((r) => r.status !== 201).forEach((r) => expect([409, 422]).toContain(r.status));
    expect((await storedPromotion(promotion.id)).redemptionCount).toBe(3);
    expect(await (await collections()).redemptions.countDocuments({ promotionId: new ObjectId(promotion.id) })).toBe(3);

    // one buyer racing themselves on a once-per-buyer code
    const once = await livePromotion(seller.cookie, { code: "SOLO", perBuyerLimit: 1 });
    const racer = await buyer();
    const raced = await Promise.all([1, 2, 3].map(() => place(racer.cookie, items, { couponCode: "SOLO" })));
    expect(raced.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await storedPromotion(once.id)).redemptionCount).toBe(1);
  });

  it("returns the same order for a resubmission, without using the code twice", async () => {
    const { seller, product, customer } = await market();
    const promotion = await livePromotion(seller.cookie, { code: "AGAIN" });
    const body = {
      items: [{ productId: product.id, quantity: 1 }],
      fulfillmentMethod: "pickup",
      deliveryNote: NOTE,
      idempotencyKey: randomUUID(),
      couponCode: "AGAIN",
    };
    const [a, b] = await Promise.all([1, 2].map(() => call<OrderResponse>(placeRoute, "/api/orders", { body, cookie: customer.cookie })));
    expect(dataOf(a).order.id).toBe(dataOf(b).order.id);
    expect((await storedPromotion(promotion.id)).redemptionCount).toBe(1);
    // the same key with a different code is a different request
    const changed = await call(placeRoute, "/api/orders", { body: { ...body, couponCode: null }, cookie: customer.cookie });
    expect(changed.status).toBe(409);
  });

  it("refuses an order whose offer changed after it was priced", async () => {
    const { seller, product, customer } = await market();
    const promotion = await livePromotion(seller.cookie, { code: "FLASH", totalLimit: 1 });
    const items = [{ productId: product.id, quantity: 1 }];
    // another buyer takes the last use between this buyer's quote and order
    const q = (await quoted(customer.cookie, { items, couponCode: "FLASH" }));
    expect(q.discountKobo).toBe(450_00);
    expect((await place((await buyer()).cookie, items, { couponCode: "FLASH" })).status).toBe(201);
    const late = await place(customer.cookie, items, { couponCode: "FLASH", expectedTotalKobo: q.totalKobo });
    expect(late.status).toBe(422);
    expect(fieldErrorsOf(late).couponCode).toMatch(/fully used/);
    expect((await storedPromotion(promotion.id)).redemptionCount).toBe(1);
  });
});

// --- after the order is placed ------------------------------------------------------------------

describe("orders placed with a promotion", () => {
  async function discountedOrder(overrides: Record<string, unknown> = {}, quantity = 2) {
    const s = await market();
    const promotion = await livePromotion(s.seller.cookie, overrides);
    const res = await place(s.customer.cookie, [{ productId: s.product.id, quantity }], overrides.code ? { couponCode: overrides.code } : {});
    expect(res.status).toBe(201);
    return { ...s, promotion, order: dataOf(res).order };
  }

  it("keeps its price when the seller changes or ends the promotion", async () => {
    const { seller, customer, promotion, order } = await discountedOrder();
    let current = dataOf(await setStatus(seller.cookie, promotion, "pause")).promotion;
    current = dataOf(await edit(seller.cookie, current, fields({ value: 50 }))).promotion;
    await setStatus(seller.cookie, current, "end");

    // the unpaid order still checks out at the price it was given
    await pay(customer.cookie, order.id);
    const init = paystack.requests.find((r) => r.operation === "initialize")!;
    expect(init.body).toMatchObject({ amount: 8_100_00 });
    const seen = dataOf(await getOrder(customer.cookie, order.id)).order;
    expect(seen).toMatchObject({ paymentStatus: "paid", discountKobo: 900_00, totalKobo: 8_100_00 });
    expect(seen.promotion).toMatchObject({ name: "Harvest sale", value: 10 });
    expect((await storedOrder(order.id)).promotion).toMatchObject({ version: 2, value: 10 });
  });

  it("gives the use back when an unpaid order expires, and counts it once when paid after a failure", async () => {
    const first = await discountedOrder({ code: "LIMITED", totalLimit: 1 });
    await (await collections()).orders.updateOne(
      { _id: new ObjectId(first.order.id) },
      { $set: { "inventory.expiresAt": new Date(Date.now() - 1000) } },
    );
    expect((await runJob()).status).toBe(200);
    expect(await redemptionFor(first.order.id)).toMatchObject({ status: "released" });
    expect((await storedPromotion(first.promotion.id)).redemptionCount).toBe(0);
    // released once: running the job again changes nothing
    await runJob();
    expect((await storedPromotion(first.promotion.id)).redemptionCount).toBe(0);

    // the freed use goes to the next buyer, whose first payment fails
    const next = await buyer();
    const res = await place(next.cookie, [{ productId: first.product.id, quantity: 2 }], { couponCode: "LIMITED" });
    expect(res.status).toBe(201);
    const { order } = dataOf(res);
    const failed = dataOf(await checkout(next.cookie, order.id)).reference;
    completeCheckout(failed, "failed");
    expect(dataOf(await verify(next.cookie, order.id, failed)).result).toBe("failed");
    expect(await redemptionFor(order.id)).toMatchObject({ status: "reserved" });

    await pay(next.cookie, order.id);
    const amounts = paystack.requests.filter((r) => r.operation === "initialize").map((r) => (r.body as { amount: number }).amount);
    expect(amounts.slice(-2)).toEqual([8_100_00, 8_100_00]);
    expect(await redemptionFor(order.id)).toMatchObject({ status: "redeemed" });
    expect((await storedPromotion(first.promotion.id)).redemptionCount).toBe(1);
  });

  it("refunds what was paid, not the list price, and releases the use", async () => {
    setCommission(500);
    const { customer, promotion, order } = await discountedOrder();
    const reference = await pay(customer.cookie, order.id);
    const res = await callId<OrderResponse>(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, {
      cookie: customer.cookie,
      body: { reason: "Ordered by mistake" },
    });
    expect(dataOf(res).order).toMatchObject({ paymentStatus: "refunded", refundedKobo: 8_100_00 });
    const sent = paystack.requests.filter((r) => r.operation === "refund");
    expect(sent.map((r) => r.body)).toEqual([expect.objectContaining({ transaction: reference, amount: 8_100_00 })]);
    expect(await redemptionFor(order.id)).toMatchObject({ status: "released" });
    expect((await storedPromotion(promotion.id)).redemptionCount).toBe(0);
    const entries = await entriesFor(order.number);
    expect(entries.filter((e) => e.type === "earning").map((e) => e.amountKobo)).toEqual([8_100_00]);
  });

  it("caps a seller's refund after delivery at what the buyer paid", async () => {
    const { seller, customer, order } = await discountedOrder();
    await pay(customer.cookie, order.id);
    for (const action of ["accept", "ship", "deliver"]) await fulfil(seller.cookie, order.id, action);
    const refund = (amountKobo: number) =>
      callId<OrderResponse>(refundRoute, `/api/sales/${order.id}/refund`, order.id, {
        cookie: seller.cookie,
        body: { amountKobo, reason: "Cracked eggs", idempotencyKey: randomUUID() },
      });
    const tooMuch = await refund(9_000_00);
    expect(tooMuch.status).toBe(422);
    expect(errorOf(tooMuch)).toMatch(/₦8,100/);
    expect(dataOf(await refund(8_100_00)).order).toMatchObject({ refundedKobo: 8_100_00, refundableKobo: 0 });
  });

  it("won't take payment for an order whose stored amounts don't add up", async () => {
    const { customer, order } = await discountedOrder();
    // someone edits the stored total: the discount no longer explains it
    await (await collections()).orders.updateOne({ _id: new ObjectId(order.id) }, { $set: { totalKobo: 100 } });
    const res = await checkout(customer.cookie, order.id);
    expect(res.status).toBe(409);
    expect(paystack.requests.filter((r) => r.operation === "initialize")).toHaveLength(0);
    expect((await storedOrder(order.id)).reviewIssue).toMatch(/don't add up/);
  });

  it("doesn't mark an order paid when Paystack reports another amount", async () => {
    const { customer, order } = await discountedOrder();
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    // the full list price arrives instead of the discounted total
    completeCheckout(reference, "success", { amount: 9_000_00 });
    expect(dataOf(await verify(customer.cookie, order.id, reference)).result).toBe("pending");
    const stored = await storedOrder(order.id);
    expect(stored.paymentStatus).toBe("pending");
    expect(stored.reviewIssue).toMatch(/doesn't match/);
    expect(await redemptionFor(order.id)).toMatchObject({ status: "reserved" });
  });

  it("leaves orders without a promotion exactly as before", async () => {
    const { product, customer } = await market();
    const { order } = dataOf(await place(customer.cookie, [{ productId: product.id, quantity: 2 }], { expectedTotalKobo: 9_000_00 }));
    expect(order).toMatchObject({ subtotalKobo: 9_000_00, discountKobo: 0, totalKobo: 9_000_00, promotion: null });
    expect(order.items[0].discountKobo).toBe(0);
    expect((await storedOrder(order.id)).promotion).toBeNull();
    expect(await (await collections()).redemptions.countDocuments()).toBe(0);
  });
});

// --- the Market --------------------------------------------------------------------------------------

describe("offers in the Market", () => {
  it("shows live automatic sales only, with the sale price", async () => {
    const { seller, product, customer } = await market();
    const other = await listProduct(seller.cookie, { name: "Broiler chicken", category: "live-birds", unit: "bird", priceKobo: 10_000_00 });
    await livePromotion(seller.cookie, { name: "Coupon only", code: "SECRET", value: 50 });
    const view = async () => (await findMarketProduct(customer.userId, product.id))!.offer;
    expect(await view()).toBeNull(); // coupon codes are never advertised

    const sale = await livePromotion(seller.cookie, { scope: "products", productIds: [product.id], value: 20 });
    expect(await view()).toMatchObject({ name: "Harvest sale", type: "percentage", value: 20, salePriceKobo: 3_600_00 });
    const page = await searchMarket(customer.userId, DEFAULT_MARKET_QUERY);
    const offers = Object.fromEntries(page.products.map((p) => [p.id, p.offer]));
    expect(offers[product.id]).toMatchObject({ salePriceKobo: 3_600_00 });
    expect(offers[other.id]).toBeNull();

    // paused or expired sales are never shown
    await setStatus(seller.cookie, sale, "pause");
    expect(await view()).toBeNull();
    const fixed = await livePromotion(seller.cookie, { type: "fixed", value: 200_00, minOrderKobo: 9_000_00 });
    // a minimum spend means no single-unit sale price is promised
    expect(await view()).toMatchObject({ type: "fixed", salePriceKobo: null, minOrderKobo: 9_000_00 });
    await (await collections()).promotions.updateOne({ _id: new ObjectId(fixed.id) }, { $set: { endsAt: new Date(Date.now() - 1000) } });
    expect(await view()).toBeNull();
  });
});

describe("products and services", () => {
  it("applies to product listings only: a service can't be chosen, quoted or discounted", async () => {
    const { seller, product, customer } = await market();
    const now = new Date();
    const serviceId = new ObjectId();
    await (await collections()).services.insertOne({
      _id: serviceId,
      ownerUserId: seller.userId,
      name: "Farm visit",
      category: "farm-visit",
      description: "",
      priceNgn: 5_000,
      durationMinutes: 60,
      active: true,
      bookingAvailable: true,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // a promotion is built from the seller's product listings; a service id isn't one
    const res = await create(seller.cookie, fields({ scope: "products", productIds: [serviceId.toHexString()] }));
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res).productIds).toBeTruthy();

    // a seller-wide sale covers products, and a service can't be priced at checkout at all
    await livePromotion(seller.cookie);
    expect((await quote(customer.cookie, { items: [{ productId: serviceId.toHexString(), quantity: 1 }] })).status).toBe(409);
    expect((await place(customer.cookie, [{ productId: serviceId.toHexString(), quantity: 1 }])).status).toBe(409);
    expect(await quoted(customer.cookie, { items: [{ productId: product.id, quantity: 1 }] })).toMatchObject({
      subtotalKobo: 4_500_00,
      discountKobo: 450_00,
      totalKobo: 4_050_00,
    });
  });
});
