import { randomUUID } from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { GET as orderRoute } from "@/app/api/orders/[id]/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { POST as placeRoute } from "@/app/api/orders/route";
import { PATCH as editRoute } from "@/app/api/products/[id]/route";
import { POST as addProductRoute } from "@/app/api/products/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import { sharedFulfillmentMethods, validateDeliveryAreas, validateFulfillmentMethods } from "@/lib/orders/validation";
import {
  DEFAULT_FULFILLMENT,
  type CheckoutResponse,
  type OrderResponse,
  type ProductFulfillment,
  type ProductResponse,
  type VerifyPaymentResponse,
} from "@/lib/orders/types";
import { FULFILLMENT_CHANGED } from "@/lib/server/orders";
import { collections } from "./support/db";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { completeCheckout, paystack } from "./support/paystack";
import { merchant } from "./support/wallet";

// Pickup and seller-arranged delivery. Choosing a method records what the
// seller offered at the time; it never adds anything to what the buyer pays.

type Ctx = { params: Promise<{ id: string }> };
type RouteWithId = (request: Request, context: Ctx) => Promise<Response>;

function callId<T>(handler: RouteWithId, path: string, id: string, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve({ id }) }), path, options);
}

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 10, description: "" };
const NOTE = "Call me when you're close, please.";

const BOTH: ProductFulfillment = {
  pickup: { enabled: true, instructions: "Farm gate, Opi road. Weekdays 8am to 5pm." },
  delivery: { enabled: true, areas: "Nsukka town and UNN campus", timing: "Within 2 days", instructions: "I'll call first." },
};
const DELIVERY_ONLY: ProductFulfillment = {
  pickup: { enabled: false, instructions: "" },
  delivery: { enabled: true, areas: "Enugu city", timing: "", instructions: "" },
};

const seller = () => merchant("poultry-farmer");
const buyer = () => merchant("veterinarian");

const addProduct = (cookie: string, body: Record<string, unknown>) =>
  call<ProductResponse>(addProductRoute, "/api/products", { body: { ...EGGS, ...body }, cookie });

async function listProduct(cookie: string, fulfillment?: ProductFulfillment, overrides: Record<string, unknown> = {}) {
  const res = await addProduct(cookie, fulfillment ? { fulfillment, ...overrides } : overrides);
  expect(res.status).toBe(201);
  return dataOf(res).product;
}

const edit = (cookie: string, id: string, body: unknown) =>
  callId<ProductResponse>(editRoute, `/api/products/${id}`, id, { method: "PATCH", body, cookie });

function place(cookie: string, items: { productId: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  return call<OrderResponse>(placeRoute, "/api/orders", {
    body: { items, fulfillmentMethod: "pickup", deliveryNote: NOTE, idempotencyKey: randomUUID(), ...extra },
    cookie,
  });
}

const stockOf = async (productId: string) =>
  (await (await collections()).products.findOne({ _id: new ObjectId(productId) }))!.stockQuantity;
const storedOrder = async (id: string) => (await (await collections()).orders.findOne({ _id: new ObjectId(id) }))!;
const getOrder = (cookie: string, id: string) => callId<OrderResponse>(orderRoute, `/api/orders/${id}`, id, { cookie });

describe("a listing's pickup and delivery options", () => {
  it("defaults to pickup only", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie);
    expect(product.fulfillment).toEqual(DEFAULT_FULFILLMENT);
    expect(DEFAULT_FULFILLMENT).toMatchObject({ pickup: { enabled: true }, delivery: { enabled: false } });
  });

  it("saves the seller's options, tidying the text", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, {
      ...BOTH,
      delivery: { ...BOTH.delivery, areas: "  Nsukka   town and UNN campus " },
    });
    expect(product.fulfillment).toEqual(BOTH);
  });

  it("can be edited, replacing the options as a whole", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, BOTH);
    const res = await edit(s.cookie, product.id, { fulfillment: DELIVERY_ONLY });
    expect(res.status).toBe(200);
    expect(dataOf(res).product.fulfillment).toEqual(DELIVERY_ONLY);
    const doc = await (await collections()).products.findOne({ _id: new ObjectId(product.id) });
    expect(doc!.fulfillment).toEqual(DELIVERY_ONLY);
  });

  it("needs at least one method", async () => {
    const s = await seller();
    const none = { pickup: { enabled: false, instructions: "" }, delivery: { enabled: false, areas: "", timing: "", instructions: "" } };
    const res = await addProduct(s.cookie, { fulfillment: none });
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res).fulfillment).toBe("Offer pickup, delivery or both.");

    const product = await listProduct(s.cookie);
    expect((await edit(s.cookie, product.id, { fulfillment: none })).status).toBe(400);
    expect((await (await collections()).products.findOne({ _id: new ObjectId(product.id) }))!.fulfillment).toEqual(DEFAULT_FULFILLMENT);
  });

  it("needs the delivery areas while delivery is on", async () => {
    const s = await seller();
    const res = await addProduct(s.cookie, { fulfillment: { ...DELIVERY_ONLY, delivery: { ...DELIVERY_ONLY.delivery, areas: " " } } });
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res)["fulfillment.delivery.areas"]).toBe("Say where you deliver to.");
  });

  it("rejects unknown fields, wrong types and over-long text", async () => {
    const s = await seller();
    const cases: unknown[] = [
      null,
      [],
      "pickup",
      { pickup: BOTH.pickup },
      { ...BOTH, courier: { enabled: true } },
      { ...BOTH, delivery: { ...BOTH.delivery, feeKobo: 500_00 } },
      { ...BOTH, pickup: { ...BOTH.pickup, enabled: "yes" } },
      { ...BOTH, delivery: { ...BOTH.delivery, areas: 7 } },
      { ...BOTH, pickup: { ...BOTH.pickup, instructions: "x".repeat(301) } },
      { ...BOTH, delivery: { ...BOTH.delivery, timing: "x".repeat(121) } },
      { ...BOTH, delivery: { ...BOTH.delivery, areas: "x".repeat(201) } },
    ];
    for (const fulfillment of cases) {
      const res = await addProduct(s.cookie, { fulfillment });
      expect(res.status, JSON.stringify(fulfillment)?.slice(0, 80)).toBe(400);
    }
    const unknown = await addProduct(s.cookie, { fulfillment: { ...BOTH, delivery: { ...BOTH.delivery, feeKobo: 500_00 } } });
    expect(fieldErrorsOf(unknown)).toHaveProperty(["fulfillment.delivery.feeKobo"]);
    expect(await (await collections()).products.countDocuments()).toBe(0);
  });

  it("shares the rules with the browser", () => {
    expect(validateFulfillmentMethods(false, false)).toBe("Offer pickup, delivery or both.");
    expect(validateFulfillmentMethods(true, false)).toBeUndefined();
    expect(validateDeliveryAreas("", false)).toBeUndefined();
    expect(validateDeliveryAreas("", true)).toBe("Say where you deliver to.");
    expect(sharedFulfillmentMethods([BOTH, DELIVERY_ONLY])).toEqual(["delivery"]);
    expect(sharedFulfillmentMethods([BOTH, DEFAULT_FULFILLMENT])).toEqual(["pickup"]);
    expect(sharedFulfillmentMethods([DEFAULT_FULFILLMENT, DELIVERY_ONLY])).toEqual([]);
  });
});

describe("choosing pickup or delivery when ordering", () => {
  it("requires a method the listing offers", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie); // pickup only
    const b = await buyer();
    const items = [{ productId: product.id, quantity: 1 }];

    const missing = await place(b.cookie, items, { fulfillmentMethod: undefined });
    expect(missing.status).toBe(400);
    expect(fieldErrorsOf(missing).fulfillmentMethod).toBe("Choose pickup or delivery.");
    for (const forged of ["courier", "", 1, null, "Pickup"])
      expect((await place(b.cookie, items, { fulfillmentMethod: forged })).status).toBe(400);

    const unavailable = await place(b.cookie, items, { fulfillmentMethod: "delivery" });
    expect(unavailable.status).toBe(409);
    expect(errorOf(unavailable)).toBe("Fresh eggs isn't available for delivery any more. Choose another option.");
    expect(fieldErrorsOf(unavailable)).toHaveProperty("fulfillmentMethod");

    expect(await stockOf(product.id)).toBe(10);
    expect(await (await collections()).orders.countDocuments()).toBe(0);
  });

  it("records what the seller offered, without changing the total", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, BOTH);
    const b = await buyer();
    const res = await place(b.cookie, [{ productId: product.id, quantity: 2 }], { fulfillmentMethod: "delivery" });
    expect(res.status).toBe(201);
    const { order } = dataOf(res);
    expect(order.subtotalKobo).toBe(9_000_00);
    expect(order.totalKobo).toBe(order.subtotalKobo);
    expect(order.fulfillment).toEqual({
      method: "delivery",
      details: [{ productId: product.id, name: "Fresh eggs", areas: BOTH.delivery.areas, timing: BOTH.delivery.timing, instructions: BOTH.delivery.instructions }],
    });
    expect(order.deliveryNote).toBe(NOTE);
    expect(await stockOf(product.id)).toBe(8);

    // the seller sees the same record
    const sale = dataOf(await getOrder(s.cookie, order.id)).order;
    expect(sale.fulfillment).toEqual(order.fulfillment);
  });

  it("records pickup instructions for a pickup order", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, BOTH);
    const b = await buyer();
    const { order } = dataOf(await place(b.cookie, [{ productId: product.id, quantity: 1 }]));
    expect(order.fulfillment).toEqual({
      method: "pickup",
      details: [{ productId: product.id, name: "Fresh eggs", areas: "", timing: "", instructions: BOTH.pickup.instructions }],
    });
  });

  it("keeps the order's record when the listing changes later", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, BOTH);
    const b = await buyer();
    const { order } = dataOf(await place(b.cookie, [{ productId: product.id, quantity: 1 }], { fulfillmentMethod: "delivery" }));
    const before = order.fulfillment;

    expect((await edit(s.cookie, product.id, { fulfillment: DEFAULT_FULFILLMENT, name: "Brown eggs" })).status).toBe(200);
    expect(dataOf(await getOrder(b.cookie, order.id)).order.fulfillment).toEqual(before);
    expect((await storedOrder(order.id)).fulfillment!.details[0].areas).toBe(BOTH.delivery.areas);
  });

  it("only allows a method every product in the order offers", async () => {
    const s = await seller();
    const both = await listProduct(s.cookie, BOTH);
    const deliveryOnly = await listProduct(s.cookie, DELIVERY_ONLY, { name: "Broilers" });
    const b = await buyer();
    const items = [
      { productId: both.id, quantity: 1 },
      { productId: deliveryOnly.id, quantity: 1 },
    ];

    const pickup = await place(b.cookie, items, { fulfillmentMethod: "pickup" });
    expect(pickup.status).toBe(409);
    expect(errorOf(pickup)).toBe("Broilers isn't available for pickup any more. Choose an option every product offers.");
    expect(await stockOf(both.id)).toBe(10);

    const res = await place(b.cookie, items, { fulfillmentMethod: "delivery" });
    expect(res.status).toBe(201);
    const { fulfillment } = dataOf(res).order;
    expect(fulfillment!.method).toBe("delivery");
    expect(fulfillment!.details.map((d) => [d.name, d.areas])).toEqual([
      ["Fresh eggs", BOTH.delivery.areas],
      ["Broilers", DELIVERY_ONLY.delivery.areas],
    ]);
  });

  it("notices the seller changing the options while the order is placed", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, BOTH);
    const b = await buyer();

    // the listing is edited after it was read for the order, before stock is reserved
    const original = Collection.prototype.findOne;
    const spy = vi.spyOn(Collection.prototype, "findOne").mockImplementation(async function (
      this: Collection,
      ...args: Parameters<Collection["findOne"]>
    ) {
      if (this.collectionName === "users" && (args[0] as Record<string, unknown> | undefined)?.role)
        await (await collections()).products.updateOne(
          { _id: new ObjectId(product.id) },
          { $set: { "fulfillment.delivery.areas": "Enugu only" } },
        );
      return original.apply(this, args);
    } as Collection["findOne"]);
    const res = await place(b.cookie, [{ productId: product.id, quantity: 1 }], { fulfillmentMethod: "delivery" });
    spy.mockRestore();

    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe(FULFILLMENT_CHANGED);
    expect(fieldErrorsOf(res).fulfillmentMethod).toBe(FULFILLMENT_CHANGED);
    expect(await stockOf(product.id)).toBe(10);
    expect(await (await collections()).orders.countDocuments()).toBe(0);

    // trying again records the new details
    const again = await place(b.cookie, [{ productId: product.id, quantity: 1 }], { fulfillmentMethod: "delivery" });
    expect(again.status).toBe(201);
    expect(dataOf(again).order.fulfillment!.details[0].areas).toBe("Enugu only");
  });

  it("treats a listing from before these options as pickup only", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie);
    await (await collections()).products.updateOne({ _id: new ObjectId(product.id) }, { $unset: { fulfillment: "" } });
    const b = await buyer();
    const items = [{ productId: product.id, quantity: 1 }];

    expect((await place(b.cookie, items, { fulfillmentMethod: "delivery" })).status).toBe(409);
    const res = await place(b.cookie, items, { fulfillmentMethod: "pickup" });
    expect(res.status).toBe(201);
    expect(dataOf(res).order.fulfillment).toEqual({
      method: "pickup",
      details: [{ productId: product.id, name: "Fresh eggs", areas: "", timing: "", instructions: "" }],
    });
  });

  it("shows orders from before these options without a record", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie);
    const b = await buyer();
    const { order } = dataOf(await place(b.cookie, [{ productId: product.id, quantity: 1 }]));
    await (await collections()).orders.updateOne({ _id: new ObjectId(order.id) }, { $unset: { fulfillment: "" } });

    const res = await getOrder(b.cookie, order.id);
    expect(res.status).toBe(200);
    expect(dataOf(res).order.fulfillment).toBeNull();
    expect(dataOf(res).order.deliveryNote).toBe(NOTE);
    expect(dataOf(await getOrder(s.cookie, order.id)).order.fulfillment).toBeNull();
  });

  it("treats the same idempotency key with a different method as a different order", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, BOTH);
    const b = await buyer();
    const items = [{ productId: product.id, quantity: 1 }];
    const idempotencyKey = randomUUID();

    const first = await place(b.cookie, items, { idempotencyKey, fulfillmentMethod: "pickup" });
    expect(first.status).toBe(201);
    const replay = await place(b.cookie, items, { idempotencyKey, fulfillmentMethod: "pickup" });
    expect(replay.status).toBe(200);
    expect(dataOf(replay).order.id).toBe(dataOf(first).order.id);
    const changed = await place(b.cookie, items, { idempotencyKey, fulfillmentMethod: "delivery" });
    expect(changed.status).toBe(409);

    expect(await stockOf(product.id)).toBe(9);
    expect(await (await collections()).orders.countDocuments()).toBe(1);
  });
});

describe("delivery never changes what is paid", () => {
  it("charges exactly the products' subtotal through Paystack, and refunds it in full", async () => {
    vi.stubEnv("COMMISSION_POLICY_ID", "test-policy");
    vi.stubEnv("COMMISSION_RATE_BPS", "500");
    const s = await seller();
    const product = await listProduct(s.cookie, BOTH);
    const b = await buyer();
    const { order } = dataOf(await place(b.cookie, [{ productId: product.id, quantity: 3 }], { fulfillmentMethod: "delivery" }));
    expect(order.totalKobo).toBe(13_500_00);

    const { reference } = dataOf(
      await callId<CheckoutResponse>(checkoutRoute, `/api/orders/${order.id}/checkout`, order.id, { cookie: b.cookie, body: {} }),
    );
    const initialize = paystack.requests.find((r) => r.operation === "initialize");
    expect((initialize!.body as { amount: number }).amount).toBe(13_500_00);
    expect(paystack.transactions.get(reference)!.amount).toBe(13_500_00);

    completeCheckout(reference);
    const verified = await callId<VerifyPaymentResponse>(verifyRoute, `/api/orders/${order.id}/verify-payment`, order.id, {
      cookie: b.cookie,
      body: { reference },
    });
    expect(dataOf(verified).result).toBe("paid");
    const paid = await storedOrder(order.id);
    expect(paid).toMatchObject({ paidKobo: 13_500_00, totalKobo: 13_500_00, subtotalKobo: 13_500_00 });

    // the ledger only ever sees the order's amount
    const entriesFor = async () =>
      (await (await collections()).ledger.find({ "source.type": "order", "source.id": order.number }).sort({ sequence: 1 }).toArray()).map(
        (e) => [e.type, e.amountKobo],
      );
    expect(await entriesFor()).toEqual([
      ["earning", 13_500_00],
      ["platform_fee", 675_00],
    ]);

    // a cancellation before it's accepted refunds what was paid, and no more
    const cancelled = await callId<OrderResponse>(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: b.cookie, body: {} });
    expect(cancelled.status).toBe(200);
    expect(dataOf(cancelled).order).toMatchObject({ paymentStatus: "refunded", refundedKobo: 13_500_00 });
    const refunds = paystack.requests.filter((r) => r.operation === "refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].body).toMatchObject({ transaction: reference, amount: 13_500_00 });
    expect(await entriesFor()).toEqual([
      ["earning", 13_500_00],
      ["platform_fee", 675_00],
      ["refund", 12_825_00],
    ]);
    expect(await stockOf(product.id)).toBe(10);
    expect(dataOf(cancelled).order.fulfillment!.method).toBe("delivery");
  });

  it("releases the stock of an unpaid delivery order when it's cancelled", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, DELIVERY_ONLY);
    const b = await buyer();
    const { order } = dataOf(await place(b.cookie, [{ productId: product.id, quantity: 4 }], { fulfillmentMethod: "delivery" }));
    expect(await stockOf(product.id)).toBe(6);
    expect((await callId(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: b.cookie, body: {} })).status).toBe(200);
    expect(await stockOf(product.id)).toBe(10);
  });

  it("doesn't treat choosing delivery as the order being shipped", async () => {
    const s = await seller();
    const product = await listProduct(s.cookie, DELIVERY_ONLY);
    const b = await buyer();
    const { order } = dataOf(await place(b.cookie, [{ productId: product.id, quantity: 1 }], { fulfillmentMethod: "delivery" }));
    expect(order).toMatchObject({ fulfillmentStatus: "pending", paymentStatus: "pending" });
    expect((await storedOrder(order.id)).shippedAt).toBeNull();
    // and the seller can't mark an unpaid order as shipped
    const ship = await callId(fulfilRoute, `/api/sales/${order.id}/fulfillment`, order.id, { cookie: s.cookie, body: { action: "ship" } });
    expect(ship.status).toBe(409);
  });
});
