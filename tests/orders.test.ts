import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { POST as issuesRoute } from "@/app/api/internal/orders/issues/route";
import { POST as processRoute } from "@/app/api/internal/orders/process/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { POST as issueRoute } from "@/app/api/orders/[id]/issue/route";
import { GET as orderRoute } from "@/app/api/orders/[id]/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { GET as listRoute, POST as placeRoute } from "@/app/api/orders/route";
import { DELETE as archiveRoute, PATCH as editRoute } from "@/app/api/products/[id]/route";
import { GET as productsRoute, POST as addProductRoute } from "@/app/api/products/route";
import { POST as sellerCancelRoute } from "@/app/api/sales/[id]/cancel/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import { POST as refundRoute } from "@/app/api/sales/[id]/refund/route";
import { POST as webhookRoute } from "@/app/api/webhooks/paystack/route";
import type {
  CheckoutResponse,
  Order,
  OrderResponse,
  OrdersResponse,
  ProductResponse,
  ProductsResponse,
  VerifyPaymentResponse,
} from "@/lib/orders/types";
import { collections } from "./support/db";
import { newRegistration, registerPending } from "./support/flows";
import { call, dataOf, ORIGIN, type CallOptions, type CallResult } from "./support/http";
import { completeCheckout, paystack, signedChargeEvent, signedRefundEvent, TEST_PAYSTACK_KEY } from "./support/paystack";
import { HOUR, merchant, summaryOf } from "./support/wallet";

// Paystack is faked (tests/support/paystack.ts): checkouts are only paid
// when a test completes them, and refunds are processed immediately unless
// a test says otherwise. No commission policy is set unless a test sets one.

const JOB_SECRET = "test-order-job-secret-at-least-32-chars!";

type Ctx = { params: Promise<{ id: string }> };
type RouteWithId = (request: Request, context: Ctx) => Promise<Response>;

/** Calls a dynamic route the way Next.js would. */
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

async function farmer() {
  return merchant("poultry-farmer");
}
async function buyer() {
  return merchant("veterinarian");
}

async function listProduct(cookie: string, overrides: Partial<typeof EGGS> = {}) {
  const res = await call<ProductResponse>(addProductRoute, "/api/products", { body: { ...EGGS, ...overrides }, cookie });
  return dataOf(res).product;
}

function place(cookie: string, items: { productId: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  return call<OrderResponse>(placeRoute, "/api/orders", {
    body: { items, fulfillmentMethod: "pickup", deliveryNote: NOTE, idempotencyKey: randomUUID(), ...extra },
    cookie,
  });
}

/** A seller with one listing and a buyer with an unpaid order for `quantity` of it. */
async function setup(quantity = 2, listing: Partial<typeof EGGS> = {}) {
  const seller = await farmer();
  const product = await listProduct(seller.cookie, listing);
  const customer = await buyer();
  const res = await place(customer.cookie, [{ productId: product.id, quantity }]);
  expect(res.status).toBe(201);
  return { seller, customer, product, order: dataOf(res).order };
}

const checkout = (cookie: string, id: string) =>
  callId<CheckoutResponse>(checkoutRoute, `/api/orders/${id}/checkout`, id, { cookie, body: {} });
const verify = (cookie: string, id: string, reference?: string) =>
  callId<VerifyPaymentResponse>(verifyRoute, `/api/orders/${id}/verify-payment`, id, {
    cookie,
    body: reference ? { reference } : {},
  });
const fulfil = (cookie: string, id: string, action: string) =>
  callId<OrderResponse>(fulfilRoute, `/api/sales/${id}/fulfillment`, id, { cookie, body: { action } });
const getOrder = (cookie: string, id: string) => callId<OrderResponse>(orderRoute, `/api/orders/${id}`, id, { cookie });

/** Pays through the (fake) checkout page and returns from it. */
async function pay(cookie: string, id: string) {
  const { reference } = dataOf(await checkout(cookie, id));
  completeCheckout(reference);
  const res = await verify(cookie, id, reference);
  expect(dataOf(res).result).toBe("paid");
  return reference;
}

async function paidSetup(quantity = 2, listing: Partial<typeof EGGS> = {}) {
  const s = await setup(quantity, listing);
  const reference = await pay(s.customer.cookie, s.order.id);
  return { ...s, reference };
}

async function deliveredSetup(quantity = 2) {
  const s = await paidSetup(quantity);
  for (const action of ["accept", "ship", "deliver"]) expect((await fulfil(s.seller.cookie, s.order.id, action)).status).toBe(200);
  return s;
}

const stockOf = async (productId: string) =>
  (await (await collections()).products.findOne({ _id: new ObjectId(productId) }))!.stockQuantity;
const storedOrder = async (id: string) => (await (await collections()).orders.findOne({ _id: new ObjectId(id) }))!;
const entriesFor = async (number: string) =>
  (await collections()).ledger.find({ "source.type": "order", "source.id": number }).sort({ sequence: 1 }).toArray();

function webhook(raw: string, signature: string | null) {
  const headers = new Headers({ "content-type": "application/json", "x-real-ip": "52.31.139.75" });
  if (signature !== null) headers.set("x-paystack-signature", signature);
  return webhookRoute(new Request(`${ORIGIN}/api/webhooks/paystack`, { method: "POST", headers, body: raw }));
}

function internal(handler: (request: Request) => Promise<Response>, path: string, authorization: string | null, body = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== null) headers.set("authorization", authorization);
  return handler(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}
const runJob = () => internal(processRoute, "/api/internal/orders/process", `Bearer ${JOB_SECRET}`);

/** Moves an order's delivery (and the ledger's) into the past. */
async function deliveredHoursAgo(order: Order, hours: number) {
  const at = new Date(Date.now() - hours * HOUR);
  const db = await collections();
  await db.orders.updateOne({ _id: new ObjectId(order.id) }, { $set: { deliveredAt: at } });
  await db.fulfillments.updateOne({ sourceId: order.number }, { $set: { deliveredAt: at } });
}

// --- listings -------------------------------------------------------------------------

describe("product listings", () => {
  it("lets a poultry farmer list products, owned by their session account", async () => {
    const seller = await farmer();
    const res = await call<ProductResponse>(addProductRoute, "/api/products", { body: EGGS, cookie: seller.cookie });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { product } = dataOf(res);
    expect(product).toMatchObject({ name: "Fresh eggs", priceKobo: 4_500_00, stockQuantity: 10, active: true });
    const stored = await (await collections()).products.findOne({ _id: new ObjectId(product.id) });
    expect(stored!.sellerUserId.equals(seller.userId)).toBe(true);
    expect(dataOf(await call<ProductsResponse>(productsRoute, "/api/products", { cookie: seller.cookie })).products).toHaveLength(1);
  });

  it("refuses other roles, unverified accounts, cross-site requests and fields like the seller", async () => {
    const vet = await buyer();
    expect((await call(addProductRoute, "/api/products", { body: EGGS, cookie: vet.cookie })).status).toBe(403);

    const { pendingCookie } = await registerPending(newRegistration({ role: "poultry-farmer" }));
    expect((await call(addProductRoute, "/api/products", { body: EGGS, cookie: pendingCookie })).status).toBe(403);
    expect((await call(addProductRoute, "/api/products", { body: EGGS })).status).toBe(401);

    const seller = await farmer();
    const crossSite = await call(addProductRoute, "/api/products", { body: EGGS, cookie: seller.cookie, origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);

    const forged = await call(addProductRoute, "/api/products", {
      body: { ...EGGS, sellerUserId: vet.userId.toHexString() },
      cookie: seller.cookie,
    });
    expect(forged.status).toBe(400);
    expect(fieldErrorsOf(forged)).toHaveProperty("sellerUserId");
    expect((await call(addProductRoute, "/api/products", { body: { ...EGGS, priceKobo: 0 }, cookie: seller.cookie })).status).toBe(400);
    expect(await (await collections()).products.countDocuments()).toBe(0);
  });

  it("only lets the owner edit or remove a listing", async () => {
    const seller = await farmer();
    const other = await farmer();
    const product = await listProduct(seller.cookie);
    const path = `/api/products/${product.id}`;

    const stolen = await callId(editRoute, path, product.id, { body: { priceKobo: 1_00 }, cookie: other.cookie, method: "PATCH" });
    expect(stolen.status).toBe(404);
    expect((await callId(archiveRoute, path, product.id, { cookie: other.cookie, method: "DELETE" })).status).toBe(404);

    const edited = await callId<ProductResponse>(editRoute, path, product.id, {
      body: { priceKobo: 5_000_00 },
      cookie: seller.cookie,
      method: "PATCH",
    });
    expect(dataOf(edited).product.priceKobo).toBe(5_000_00);
    expect((await callId(archiveRoute, path, product.id, { cookie: seller.cookie, method: "DELETE" })).status).toBe(200);
  });

  it("won't overwrite stock that changed since the seller looked (an order was placed)", async () => {
    const { seller, product } = await setup(3);
    const path = `/api/products/${product.id}`;
    const noExpected = await callId(editRoute, path, product.id, { body: { stockQuantity: 50 }, cookie: seller.cookie, method: "PATCH" });
    expect(noExpected.status).toBe(400);
    const stale = await callId(editRoute, path, product.id, {
      body: { stockQuantity: 50, expectedStockQuantity: 10 },
      cookie: seller.cookie,
      method: "PATCH",
    });
    expect(stale.status).toBe(409);
    expect(await stockOf(product.id)).toBe(7);
    const fresh = await callId<ProductResponse>(editRoute, path, product.id, {
      body: { stockQuantity: 50, expectedStockQuantity: 7 },
      cookie: seller.cookie,
      method: "PATCH",
    });
    expect(dataOf(fresh).product.stockQuantity).toBe(50);
  });
});

// --- placing orders ----------------------------------------------------------------------

describe("placing an order", () => {
  it("prices it from the database, reserves the stock and records who placed it", async () => {
    const { customer, product, order } = await setup(3);
    expect(order).toMatchObject({
      viewer: "buyer",
      subtotalKobo: 13_500_00,
      totalKobo: 13_500_00,
      currency: "NGN",
      paymentStatus: "pending",
      fulfillmentStatus: "pending",
      actions: ["pay", "cancel"],
    });
    expect(order.number).toMatch(/^FKO-[A-Z0-9]{8}$/);
    expect(order.items[0]).toMatchObject({ unitPriceKobo: 4_500_00, quantity: 3, lineTotalKobo: 13_500_00 });
    expect(order.payBy).not.toBeNull();
    expect(await stockOf(product.id)).toBe(7);
    const stored = await storedOrder(order.id);
    expect(stored.buyerUserId.equals(customer.userId)).toBe(true);
  });

  it("refuses prices, totals, statuses or a buyer sent by the browser", async () => {
    const seller = await farmer();
    const product = await listProduct(seller.cookie);
    const customer = await buyer();
    for (const extra of [
      { totalKobo: 1 },
      { paymentStatus: "paid" },
      { buyerUserId: seller.userId.toHexString() },
    ]) {
      const res = await place(customer.cookie, [{ productId: product.id, quantity: 1 }], extra);
      expect(res.status).toBe(400);
    }
    const priced = await place(customer.cookie, [{ productId: product.id, quantity: 1, priceKobo: 1 } as never]);
    expect(priced.status).toBe(400);
    expect(await (await collections()).orders.countDocuments()).toBe(0);
    expect(await stockOf(product.id)).toBe(10);
  });

  it("returns the same order for a repeated submission and refuses a reused key with other details", async () => {
    const seller = await farmer();
    const product = await listProduct(seller.cookie);
    const customer = await buyer();
    const idempotencyKey = randomUUID();
    const first = await place(customer.cookie, [{ productId: product.id, quantity: 2 }], { idempotencyKey });
    const again = await place(customer.cookie, [{ productId: product.id, quantity: 2 }], { idempotencyKey });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(dataOf(again).order.id).toBe(dataOf(first).order.id);
    const changed = await place(customer.cookie, [{ productId: product.id, quantity: 3 }], { idempotencyKey });
    expect(changed.status).toBe(409);
    expect(await stockOf(product.id)).toBe(8);
    expect(await (await collections()).orders.countDocuments()).toBe(1);
  });

  it("tells the buyer when the price changed since they looked", async () => {
    const seller = await farmer();
    const product = await listProduct(seller.cookie);
    const customer = await buyer();
    const res = await place(customer.cookie, [{ productId: product.id, quantity: 1 }], { expectedTotalKobo: 4_000_00 });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toContain("₦4,500");
    expect(await stockOf(product.id)).toBe(10);
  });

  it("never oversells: concurrent orders for the last units can't both succeed", async () => {
    const seller = await farmer();
    const product = await listProduct(seller.cookie, { stockQuantity: 3 });
    const buyers = await Promise.all([buyer(), buyer(), buyer()]);
    const results = await Promise.all(buyers.map((b) => place(b.cookie, [{ productId: product.id, quantity: 2 }])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await stockOf(product.id)).toBe(1);
  });

  it("refuses the seller's own product, mixed sellers, sold-out and archived listings", async () => {
    const seller = await farmer();
    const product = await listProduct(seller.cookie, { stockQuantity: 1 });
    expect((await place(seller.cookie, [{ productId: product.id, quantity: 1 }])).status).toBe(400);

    const otherSeller = await farmer();
    const otherProduct = await listProduct(otherSeller.cookie);
    const customer = await buyer();
    const mixed = await place(customer.cookie, [
      { productId: product.id, quantity: 1 },
      { productId: otherProduct.id, quantity: 1 },
    ]);
    expect(mixed.status).toBe(400);

    expect((await place(customer.cookie, [{ productId: product.id, quantity: 2 }])).status).toBe(409);
    await callId(archiveRoute, `/api/products/${otherProduct.id}`, otherProduct.id, { cookie: otherSeller.cookie, method: "DELETE" });
    expect((await place(customer.cookie, [{ productId: otherProduct.id, quantity: 1 }])).status).toBe(409);
  });

  it("limits how many unpaid orders a buyer can hold", async () => {
    const seller = await farmer();
    const product = await listProduct(seller.cookie, { stockQuantity: 100 });
    const customer = await buyer();
    for (let i = 0; i < 5; i++) expect((await place(customer.cookie, [{ productId: product.id, quantity: 1 }])).status).toBe(201);
    expect((await place(customer.cookie, [{ productId: product.id, quantity: 1 }])).status).toBe(409);
  });
});

// --- reading orders ------------------------------------------------------------------------

describe("reading orders", () => {
  it("shows an order to its buyer and seller only, and never the buyer's contact details", async () => {
    const { seller, customer, order } = await setup();
    const asBuyer = await getOrder(customer.cookie, order.id);
    expect(asBuyer.headers.get("cache-control")).toBe("no-store");
    expect(dataOf(asBuyer).order.viewer).toBe("buyer");

    const asSeller = dataOf(await getOrder(seller.cookie, order.id)).order;
    expect(asSeller.viewer).toBe("seller");
    expect(asSeller.deliveryNote).toBe(NOTE);
    const exposed = JSON.stringify(asSeller);
    const buyerDoc = await (await collections()).users.findOne({ _id: customer.userId });
    expect(exposed).not.toContain(buyerDoc!.phoneNormalized);
    expect(exposed).not.toContain(buyerDoc!.emailNormalized);
    expect(exposed).not.toContain(customer.userId.toHexString());

    const stranger = await buyer();
    expect((await getOrder(stranger.cookie, order.id)).status).toBe(404);
    expect((await getOrder(stranger.cookie, "not-an-id")).status).toBe(404);

    const mine = dataOf(await call<OrdersResponse>(listRoute, "/api/orders", { cookie: customer.cookie }));
    expect(mine.orders.map((o) => o.id)).toEqual([order.id]);
    const sales = dataOf(await call<OrdersResponse>(listRoute, "/api/orders?as=seller", { cookie: seller.cookie }));
    expect(sales.orders.map((o) => o.id)).toEqual([order.id]);
    expect(dataOf(await call<OrdersResponse>(listRoute, "/api/orders", { cookie: stranger.cookie })).orders).toEqual([]);
  });
});

// --- paying ---------------------------------------------------------------------------------

describe("paying for an order", () => {
  it("starts a Paystack checkout for the stored total with the buyer's own email, and resumes it", async () => {
    const { customer, order } = await setup(2);
    const res = await checkout(customer.cookie, order.id);
    expect(res.status).toBe(200);
    const { authorizationUrl, reference } = dataOf(res);
    expect(authorizationUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    expect(reference).toMatch(/^fko_[0-9a-f]{24}$/);

    const sent = paystack.requests.find((r) => r.operation === "initialize")!;
    const buyerDoc = await (await collections()).users.findOne({ _id: customer.userId });
    expect(sent.body).toMatchObject({ amount: 9_000_00, currency: "NGN", email: buyerDoc!.emailNormalized, reference });
    expect(sent.body).toMatchObject({ metadata: { order_id: order.id } });
    expect(JSON.stringify(dataOf(res))).not.toContain(TEST_PAYSTACK_KEY);

    // a second click reuses the open checkout instead of starting another
    expect(dataOf(await checkout(customer.cookie, order.id)).reference).toBe(reference);
    expect(paystack.requests.filter((r) => r.operation === "initialize")).toHaveLength(1);
  });

  it("doesn't treat returning from the checkout page as payment", async () => {
    const { customer, order } = await setup();
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    const res = dataOf(await verify(customer.cookie, order.id, reference));
    expect(res.result).toBe("pending");
    expect(res.order.paymentStatus).toBe("pending");
    expect(await entriesFor(order.number)).toHaveLength(0);
  });

  it("marks the order paid only once Paystack confirms it, exactly once", async () => {
    const { customer, order } = await setup();
    const reference = await pay(customer.cookie, order.id);
    const again = dataOf(await verify(customer.cookie, order.id, reference));
    expect(again.result).toBe("paid");
    const stored = await storedOrder(order.id);
    expect(stored).toMatchObject({ paymentStatus: "paid", paymentReference: reference, paidKobo: 9_000_00 });
    expect(stored.history.filter((h) => h.event === "paid")).toHaveLength(1);
    expect(again.order.actions).toEqual(["cancel"]);
    expect((await checkout(customer.cookie, order.id)).status).toBe(409);
  });

  it("doesn't mark a payment for the wrong amount or another order as paid", async () => {
    const { customer, order } = await setup();
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    completeCheckout(reference, "success", { amount: 100 });
    const res = dataOf(await verify(customer.cookie, order.id, reference));
    expect(res.result).not.toBe("paid");
    const stored = await storedOrder(order.id);
    expect(stored.paymentStatus).not.toBe("paid");
    expect(stored.reviewIssue).toBeTruthy();
  });

  it("ignores a reference from another order", async () => {
    const a = await setup();
    const b = await setup();
    const refB = await pay(b.customer.cookie, b.order.id);
    const res = dataOf(await verify(a.customer.cookie, a.order.id, refB));
    expect(res.result).toBe("pending");
    expect((await storedOrder(a.order.id)).paymentStatus).toBe("pending");
  });

  it("is unavailable, not faked, when Paystack isn't configured or can't be reached", async () => {
    const { customer, order } = await setup();
    paystack.behaviour.initialize = "timeout";
    expect((await checkout(customer.cookie, order.id)).status).toBe(503);

    const other = await setup();
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    const res = await checkout(other.customer.cookie, other.order.id);
    expect(res.status).toBe(503);
    expect((await storedOrder(other.order.id)).paymentStatus).toBe("pending");
  });

  it("only hands the browser Paystack's own checkout pages", async () => {
    const { customer, order } = await setup();
    paystack.behaviour.initialize = "malformed";
    const res = await checkout(customer.cookie, order.id);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.json)).not.toContain("evil.example");
  });
});

// --- webhooks --------------------------------------------------------------------------------

describe("Paystack webhooks for orders", () => {
  it("marks an order paid from a signed charge.success, verified with Paystack, once", async () => {
    const { customer, order } = await setup();
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    const transaction = completeCheckout(reference);
    const { raw, signature } = signedChargeEvent(transaction);
    expect((await webhook(raw, signature)).status).toBe(200);
    expect((await webhook(raw, signature)).status).toBe(200);
    const stored = await storedOrder(order.id);
    expect(stored.paymentStatus).toBe("paid");
    expect(stored.history.filter((h) => h.event === "paid")).toHaveLength(1);
    expect(paystack.requests.filter((r) => r.operation === "transaction")).toHaveLength(1);
  });

  it("rejects unsigned or tampered events and trusts nothing in the event body", async () => {
    const { customer, order } = await setup();
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    const transaction = paystack.transactions.get(reference)!;
    // claims success, but Paystack's own record isn't paid
    const forged = signedChargeEvent({ ...transaction, status: "success" });
    expect((await webhook(forged.raw, "0".repeat(128))).status).toBe(401);
    expect((await webhook(forged.raw, null)).status).toBe(401);
    expect((await webhook(forged.raw, forged.signature)).status).toBe(200);
    expect((await storedOrder(order.id)).paymentStatus).toBe("pending");
  });

  it("asks Paystack to retry when it can't confirm the payment", async () => {
    const { customer, order } = await setup();
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    const { raw, signature } = signedChargeEvent(completeCheckout(reference));
    paystack.behaviour.transaction = "server-error";
    expect((await webhook(raw, signature)).status).toBeGreaterThanOrEqual(500);
    paystack.behaviour.transaction = "ok";
    expect((await webhook(raw, signature)).status).toBe(200);
    expect((await storedOrder(order.id)).paymentStatus).toBe("paid");
  });

  it("acknowledges charges that aren't Market orders without changing anything", async () => {
    const raw = JSON.stringify({ event: "charge.success", data: { reference: "someone-elses-ref", amount: 100 } });
    const { signature } = signedChargeEvent({
      id: 1, reference: "x", amount: 1, currency: "NGN", email: "", status: "success", metadata: null, paid_at: null,
    });
    // the signature above is for a different body: only a correct one is accepted
    expect((await webhook(raw, signature)).status).toBe(401);
    const { createHmac } = await import("node:crypto");
    const good = createHmac("sha512", TEST_PAYSTACK_KEY).update(raw).digest("hex");
    expect((await webhook(raw, good)).status).toBe(200);
    expect(paystack.requests.filter((r) => r.operation === "transaction")).toHaveLength(0);
  });
});

// --- commission & the seller's wallet ----------------------------------------------------------

describe("commission and the seller's earnings", () => {
  it("records no earning while no commission policy is configured, then settles once one is", async () => {
    const { seller, order } = await paidSetup(2);
    expect(await entriesFor(order.number)).toHaveLength(0);
    expect((await storedOrder(order.id)).settlement).toBeNull();
    expect((await summaryOf(seller.userId)).pendingKobo).toBe(0);

    setCommission(500, "2026-test");
    expect((await runJob()).status).toBe(200);
    const entries = await entriesFor(order.number);
    expect(entries.map((e) => [e.type, e.amountKobo])).toEqual([
      ["earning", 9_000_00],
      ["platform_fee", 450_00],
    ]);
    expect((await storedOrder(order.id)).settlement).toMatchObject({ policyId: "2026-test", rateBps: 500, feeKobo: 450_00 });
    expect((await summaryOf(seller.userId)).pendingKobo).toBe(8_550_00);

    // settled once: another run (or a changed rate) doesn't touch it again
    setCommission(1000, "2026-other");
    await runJob();
    expect(await entriesFor(order.number)).toHaveLength(2);
  });

  it("makes the earning available 24 hours after the seller marks delivery, at the server's time", async () => {
    setCommission(250);
    const { seller, customer, order } = await deliveredSetup(2);
    const stored = await storedOrder(order.id);
    expect(Math.abs(stored.deliveredAt!.getTime() - Date.now())).toBeLessThan(10_000);
    expect(await summaryOf(seller.userId)).toMatchObject({ pendingKobo: 8_775_00, availableKobo: 0 });

    await deliveredHoursAgo(order, 25);
    expect(await summaryOf(seller.userId)).toMatchObject({ pendingKobo: 0, availableKobo: 8_775_00 });
    expect((await getOrder(customer.cookie, order.id)).status).toBe(200);
  });
});

// --- fulfilment -------------------------------------------------------------------------------------

describe("fulfilment", () => {
  it("lets only the seller move a paid order along, one step at a time", async () => {
    const { seller, customer, order } = await setup();
    expect((await fulfil(seller.cookie, order.id, "accept")).status).toBe(409); // unpaid
    await pay(customer.cookie, order.id);

    // the buyer (or anyone else) can't use the seller's endpoints
    expect((await fulfil(customer.cookie, order.id, "deliver")).status).toBe(404);
    expect((await fulfil((await farmer()).cookie, order.id, "accept")).status).toBe(404);

    expect((await fulfil(seller.cookie, order.id, "ship")).status).toBe(409); // not accepted yet
    const accepted = dataOf(await fulfil(seller.cookie, order.id, "accept")).order;
    expect(accepted.fulfillmentStatus).toBe("processing");
    expect((await fulfil(seller.cookie, order.id, "accept")).status).toBe(409);
    expect(dataOf(await fulfil(seller.cookie, order.id, "ship")).order.fulfillmentStatus).toBe("in_transit");
    const delivered = dataOf(await fulfil(seller.cookie, order.id, "deliver")).order;
    expect(delivered.fulfillmentStatus).toBe("delivered");
    expect((await fulfil(seller.cookie, order.id, "deliver")).status).toBe(409);
  });

  it("refuses a delivery time or any other field from the browser", async () => {
    const { seller, order } = await paidSetup();
    await fulfil(seller.cookie, order.id, "accept");
    const res = await callId(fulfilRoute, `/api/sales/${order.id}/fulfillment`, order.id, {
      cookie: seller.cookie,
      body: { action: "deliver", deliveredAt: "2020-01-01T00:00:00Z" },
    });
    expect(res.status).toBe(400);
    expect((await storedOrder(order.id)).fulfillmentStatus).toBe("processing");
  });
});

// --- cancelling ---------------------------------------------------------------------------------------

describe("cancelling", () => {
  it("gives an unpaid order's stock back exactly once", async () => {
    const { customer, product, order } = await setup(4);
    expect(await stockOf(product.id)).toBe(6);
    const res = await callId<OrderResponse>(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: customer.cookie, body: {} });
    expect(res.status).toBe(200);
    expect(dataOf(res).order).toMatchObject({ paymentStatus: "cancelled", fulfillmentStatus: "cancelled", cancelledBy: "buyer" });
    expect(await stockOf(product.id)).toBe(10);
    expect((await callId(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: customer.cookie, body: {} })).status).toBe(409);
    await runJob();
    expect(await stockOf(product.id)).toBe(10);
  });

  it("refunds a paid order in full through Paystack when the buyer cancels before it's accepted", async () => {
    setCommission(500);
    const { seller, customer, product, order, reference } = await paidSetup(2);
    const res = await callId<OrderResponse>(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, {
      cookie: customer.cookie,
      body: { reason: "Ordered by mistake" },
    });
    expect(res.status).toBe(200);
    const after = dataOf(res).order;
    expect(after).toMatchObject({ fulfillmentStatus: "cancelled", paymentStatus: "refunded", refundedKobo: 9_000_00 });
    const sent = paystack.requests.filter((r) => r.operation === "refund");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ transaction: reference, amount: 9_000_00 });
    expect(await stockOf(product.id)).toBe(10);
    // the seller's net earning is reversed (the platform returns its fee share)
    expect((await entriesFor(order.number)).map((e) => [e.type, e.amountKobo])).toEqual([
      ["earning", 9_000_00],
      ["platform_fee", 450_00],
      ["refund", 8_550_00],
    ]);
    expect(await summaryOf(seller.userId)).toMatchObject({ pendingKobo: 0, availableKobo: 0, underReviewKobo: 0 });
  });

  it("stops the buyer cancelling once the seller has accepted; the seller still can, with a reason", async () => {
    const { seller, customer, product, order } = await paidSetup(2);
    await fulfil(seller.cookie, order.id, "accept");
    expect((await callId(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: customer.cookie, body: {} })).status).toBe(409);
    expect((await callId(sellerCancelRoute, `/api/sales/${order.id}/cancel`, order.id, { cookie: seller.cookie, body: {} })).status).toBe(400);
    const res = await callId<OrderResponse>(sellerCancelRoute, `/api/sales/${order.id}/cancel`, order.id, {
      cookie: seller.cookie,
      body: { reason: "Flock is sick" },
    });
    expect(dataOf(res).order).toMatchObject({ fulfillmentStatus: "cancelled", paymentStatus: "refunded", cancelledBy: "seller" });
    expect(await stockOf(product.id)).toBe(10);
  });

  it("never restocks a delivered order", async () => {
    const { seller, product, order } = await deliveredSetup(2);
    expect((await callId(sellerCancelRoute, `/api/sales/${order.id}/cancel`, order.id, { cookie: seller.cookie, body: { reason: "Changed my mind" } })).status).toBe(409);
    await runJob();
    expect(await stockOf(product.id)).toBe(8);
  });

  it("won't cancel an unpaid order while Paystack can't say whether it was paid", async () => {
    const { customer, product, order } = await setup(2);
    await checkout(customer.cookie, order.id);
    paystack.behaviour.transaction = "server-error";
    const res = await callId(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: customer.cookie, body: {} });
    expect(res.status).toBe(503);
    expect(await stockOf(product.id)).toBe(8);
  });

  it("cancels as paid (and refunds) if the open checkout turns out to have been paid", async () => {
    const { customer, order } = await setup(2);
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    completeCheckout(reference);
    const res = await callId<OrderResponse>(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: customer.cookie, body: {} });
    expect(dataOf(res).order).toMatchObject({ fulfillmentStatus: "cancelled", paymentStatus: "refunded" });
    expect(paystack.requests.filter((r) => r.operation === "refund")).toHaveLength(1);
  });
});

// --- expiry & late payments --------------------------------------------------------------------------

describe("the order job", () => {
  it("is protected by its own secret", async () => {
    expect((await internal(processRoute, "/api/internal/orders/process", null)).status).toBe(401);
    expect((await internal(processRoute, "/api/internal/orders/process", "Bearer wrong-secret")).status).toBe(401);
    vi.stubEnv("ORDER_JOB_SECRET", "");
    expect((await runJob()).status).toBe(404);
  });

  it("cancels unpaid orders whose reservation ran out and gives their stock back", async () => {
    const { product, order } = await setup(3);
    await (await collections()).orders.updateOne(
      { _id: new ObjectId(order.id) },
      { $set: { "inventory.expiresAt": new Date(Date.now() - 1000) } },
    );
    const res = await runJob();
    expect(dataOf(await call(() => Promise.resolve(res), "/"))).toMatchObject({ expired: 1, stockReleased: 0 });
    expect((await storedOrder(order.id)).paymentStatus).toBe("cancelled");
    expect(await stockOf(product.id)).toBe(10);
  });

  it("refunds a payment that arrives after the order expired", async () => {
    const { customer, order } = await setup(1);
    const { reference } = dataOf(await checkout(customer.cookie, order.id));
    // Paystack's record isn't found paid when the job checks, so the order expires
    await (await collections()).orders.updateOne(
      { _id: new ObjectId(order.id) },
      { $set: { "inventory.expiresAt": new Date(Date.now() - 1000) } },
    );
    await runJob();
    expect((await storedOrder(order.id)).paymentStatus).toBe("cancelled");

    const { raw, signature } = signedChargeEvent(completeCheckout(reference));
    expect((await webhook(raw, signature)).status).toBe(200);
    const refunds = paystack.requests.filter((r) => r.operation === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].body).toMatchObject({ transaction: reference, amount: 4_500_00 });
    const stored = await (await collections()).refunds.findOne({ orderId: new ObjectId(order.id) });
    expect(stored).toMatchObject({ kind: "late_payment", status: "processed" });
    expect((await storedOrder(order.id)).paymentStatus).toBe("cancelled");
  });
});

// --- refunds after delivery & issues ----------------------------------------------------------------

describe("refunds after delivery", () => {
  const refund = (cookie: string, id: string, body: Record<string, unknown>) =>
    callId<OrderResponse>(refundRoute, `/api/sales/${id}/refund`, id, { cookie, body });

  it("sends a partial refund once, debits the seller's share, and refuses more than is left", async () => {
    setCommission(1000);
    const { seller, customer, order, reference } = await deliveredSetup(2);
    const idempotencyKey = randomUUID();
    const body = { amountKobo: 3_000_00, reason: "Two eggs cracked", idempotencyKey };
    const res = await refund(seller.cookie, order.id, body);
    expect(res.status).toBe(200);
    expect(dataOf(res).order).toMatchObject({ paymentStatus: "partially_refunded", refundedKobo: 3_000_00, refundableKobo: 6_000_00 });
    expect((await refund(seller.cookie, order.id, body)).status).toBe(200);
    expect(paystack.requests.filter((r) => r.operation === "refund")).toHaveLength(1);
    expect(paystack.requests.find((r) => r.operation === "refund")!.body).toMatchObject({ transaction: reference, amount: 3_000_00 });

    // 10% fee: of a ₦3,000 refund the seller bears ₦2,700, the platform ₦300
    const refundEntries = (await entriesFor(order.number)).filter((e) => e.type === "refund");
    expect(refundEntries.map((e) => e.amountKobo)).toEqual([2_700_00]);
    expect((await summaryOf(seller.userId)).pendingKobo).toBe(8_100_00 - 2_700_00);

    const tooMuch = await refund(seller.cookie, order.id, { ...body, idempotencyKey: randomUUID(), amountKobo: 7_000_00 });
    expect(tooMuch.status).toBe(422);
    expect((await refund(customer.cookie, order.id, { ...body, idempotencyKey: randomUUID() })).status).toBe(404);
  });

  it("holds the earning while a refund is pending and applies it when Paystack confirms", async () => {
    setCommission(0);
    const { seller, order } = await deliveredSetup(2);
    await deliveredHoursAgo(order, 25);
    paystack.newRefundStatus = "pending";
    const res = await refund(seller.cookie, order.id, { amountKobo: 9_000_00, reason: "Wrong breed sent", idempotencyKey: randomUUID() });
    expect(dataOf(res).order).toMatchObject({ paymentStatus: "paid", refundPendingKobo: 9_000_00 });
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 0, underReviewKobo: 9_000_00 });

    const sent = [...paystack.refunds.values()][0];
    sent.status = "processed";
    const { raw, signature } = signedRefundEvent("refund.processed", sent);
    expect((await webhook(raw, signature)).status).toBe(200);
    expect((await storedOrder(order.id))).toMatchObject({ paymentStatus: "refunded", refundedKobo: 9_000_00, refundInFlight: null });
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 0, underReviewKobo: 0, pendingKobo: 0 });
  });

  it("releases the hold and flags the order when Paystack fails a refund", async () => {
    setCommission(0);
    const { seller, order } = await deliveredSetup(1);
    await deliveredHoursAgo(order, 25);
    paystack.newRefundStatus = "failed";
    await refund(seller.cookie, order.id, { amountKobo: 1_000_00, reason: "Late delivery", idempotencyKey: randomUUID() });
    const stored = await storedOrder(order.id);
    expect(stored).toMatchObject({ paymentStatus: "paid", refundedKobo: 0, refundInFlight: null });
    expect(stored.reviewIssue).toBeTruthy();
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 4_500_00, underReviewKobo: 0 });
  });

  it("works out what happened when a refund response is lost, without refunding twice", async () => {
    setCommission(0);
    const { seller, order } = await deliveredSetup(1);
    paystack.behaviour.refund = "timeout-after-create";
    const res = await refund(seller.cookie, order.id, { amountKobo: 1_000_00, reason: "Late delivery", idempotencyKey: randomUUID() });
    expect(res.status).toBe(200);
    expect(dataOf(res).order.refundPendingKobo).toBe(1_000_00);
    paystack.behaviour.refund = "ok";
    await (await collections()).refunds.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    await runJob();
    expect(paystack.refunds.size).toBe(1);
    expect(await storedOrder(order.id)).toMatchObject({ paymentStatus: "partially_refunded", refundedKobo: 1_000_00 });
  });

  it("uses cancellation, not a partial refund, before delivery", async () => {
    const { seller, order } = await paidSetup();
    const res = await refund(seller.cookie, order.id, { amountKobo: 1_00, reason: "Late delivery", idempotencyKey: randomUUID() });
    expect(res.status).toBe(409);
  });
});

describe("reporting a problem", () => {
  const report = (cookie: string, id: string, note: string) =>
    callId<OrderResponse>(issueRoute, `/api/orders/${id}/issue`, id, { cookie, body: { note } });

  it("puts the seller's earning under review until support closes the issue", async () => {
    setCommission(0);
    const { seller, customer, order } = await deliveredSetup(2);
    expect((await report(seller.cookie, order.id, "Seller can't report this")).status).toBe(404);
    const res = await report(customer.cookie, order.id, "Half the eggs were broken on arrival.");
    expect(res.status).toBe(200);
    expect(dataOf(res).order.issue).toMatchObject({ open: true });
    expect((await report(customer.cookie, order.id, "Reporting the same problem again.")).status).toBe(409);
    await deliveredHoursAgo(order, 30);
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 0, underReviewKobo: 9_000_00 });

    expect((await internal(issuesRoute, "/api/internal/orders/issues", null, { orderNumber: order.number })).status).toBe(401);
    const closed = await internal(issuesRoute, "/api/internal/orders/issues", `Bearer ${JOB_SECRET}`, { orderNumber: order.number });
    expect(closed.status).toBe(200);
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 9_000_00, underReviewKobo: 0 });
  });

  it("can't be reported before delivery or more than 24 hours after it", async () => {
    const paid = await paidSetup();
    expect((await report(paid.customer.cookie, paid.order.id, "Never arrived at all.")).status).toBe(409);
    const { customer, order } = await deliveredSetup();
    await deliveredHoursAgo(order, 25);
    expect((await report(customer.cookie, order.id, "Half the eggs were broken.")).status).toBe(409);
  });
});

describe("privacy", () => {
  it("doesn't log secrets or buyer contact details", async () => {
    const { customer, order } = await deliveredSetup();
    await callId(issueRoute, `/api/orders/${order.id}/issue`, order.id, { cookie: customer.cookie, body: { note: "Half the eggs were broken." } });
    const buyerDoc = await (await collections()).users.findOne({ _id: customer.userId });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    for (const secret of [TEST_PAYSTACK_KEY, JOB_SECRET, buyerDoc!.emailNormalized, buyerDoc!.phoneNormalized, NOTE])
      expect(logged).not.toContain(secret);
  });
});
