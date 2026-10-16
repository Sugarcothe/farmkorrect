import { randomUUID } from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { POST as placeRoute } from "@/app/api/orders/route";
import { GET as productReviewsRoute, POST as postReviewRoute } from "@/app/api/products/[id]/reviews/route";
import { DELETE as archiveRoute } from "@/app/api/products/[id]/route";
import { POST as addProductRoute } from "@/app/api/products/route";
import { DELETE as withdrawRoute, PATCH as editRoute } from "@/app/api/reviews/[id]/route";
import { GET as mineRoute } from "@/app/api/reviews/mine/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import { POST as refundRoute } from "@/app/api/sales/[id]/refund/route";
import type { CheckoutResponse, OrderResponse, Product, ProductResponse, VerifyPaymentResponse } from "@/lib/orders/types";
import type { MyReviewsResponse, ProductReviewsResponse, ReviewResponse } from "@/lib/reviews/types";
import type { ReviewDoc } from "@/lib/server/models";
import { collections } from "./support/db";
import { newRegistration, registerPending } from "./support/flows";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { completeCheckout } from "./support/paystack";
import { merchant } from "./support/wallet";

// Reviews rest on real orders placed, paid (through the fake Paystack) and
// delivered through the API, so eligibility is always checked against
// stored orders, never against anything a test claims.

type Ctx = { params: Promise<{ id: string }> };
type RouteWithId = (request: Request, context: Ctx) => Promise<Response>;

function callId<T>(handler: RouteWithId, path: string, id: string, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve({ id }) }), path, options);
}

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 100, description: "" };
const NOTE = "Deliver to 12 Ring Road, Ibadan. Call on arrival.";
const GOOD = { rating: 5, text: "Fresh, well packed and delivered on time." };

type Account = Awaited<ReturnType<typeof merchant>>;

async function listProduct(cookie: string) {
  return dataOf(await call<ProductResponse>(addProductRoute, "/api/products", { body: EGGS, cookie })).product;
}

async function place(cookie: string, productId: string) {
  const res = await call<OrderResponse>(placeRoute, "/api/orders", {
    body: { items: [{ productId, quantity: 1 }], deliveryNote: NOTE, idempotencyKey: randomUUID() },
    cookie,
  });
  expect(res.status).toBe(201);
  return dataOf(res).order;
}

async function pay(cookie: string, id: string) {
  const { reference } = dataOf(
    await callId<CheckoutResponse>(checkoutRoute, `/api/orders/${id}/checkout`, id, { cookie, body: {} }),
  );
  completeCheckout(reference);
  const res = await callId<VerifyPaymentResponse>(verifyRoute, `/api/orders/${id}/verify-payment`, id, {
    cookie,
    body: { reference },
  });
  expect(dataOf(res).result).toBe("paid");
}

async function fulfil(cookie: string, id: string, actions: string[]) {
  for (const action of actions)
    expect((await callId(fulfilRoute, `/api/sales/${id}/fulfillment`, id, { cookie, body: { action } })).status).toBe(200);
}

/** A customer whose order for the product was paid and delivered. */
async function deliveredCustomer(seller: Account, product: Product, customer?: Account) {
  const buyer = customer ?? (await merchant("veterinarian"));
  const order = await place(buyer.cookie, product.id);
  await pay(buyer.cookie, order.id);
  await fulfil(seller.cookie, order.id, ["accept", "ship", "deliver"]);
  return { ...buyer, order };
}

/** A seller with one listing and one customer who received it. */
async function setup() {
  const seller = await merchant("poultry-farmer");
  const product = await listProduct(seller.cookie);
  const customer = await deliveredCustomer(seller, product);
  return { seller, product, customer };
}

const post = (cookie: string | undefined, productId: string, body: unknown = GOOD, extra: CallOptions = {}) =>
  callId<ReviewResponse>(postReviewRoute, `/api/products/${productId}/reviews`, productId, { cookie, body, ...extra });
const read = (cookie: string, productId: string, page?: number) =>
  callId<ProductReviewsResponse>(
    productReviewsRoute,
    `/api/products/${productId}/reviews${page ? `?page=${page}` : ""}`,
    productId,
    { cookie },
  );
const edit = (cookie: string, id: string, body: unknown) =>
  callId<ReviewResponse>(editRoute, `/api/reviews/${id}`, id, { cookie, body, method: "PATCH" });
const withdraw = (cookie: string, id: string) =>
  callId<ReviewResponse>(withdrawRoute, `/api/reviews/${id}`, id, { cookie, method: "DELETE" });
const mine = (cookie: string) => call<MyReviewsResponse>(mineRoute, "/api/reviews/mine", { cookie });

const stored = async (id: string) => (await (await collections()).reviews.findOne({ _id: new ObjectId(id) }))!;
const reviewCount = async () => (await collections()).reviews.countDocuments();

/** A review written straight into the database (for statuses only a moderator sets, and for paging). */
async function insertReview(productId: string, sellerUserId: ObjectId, fields: Partial<ReviewDoc> = {}) {
  const now = new Date();
  const doc: ReviewDoc = {
    _id: new ObjectId(),
    productId: new ObjectId(productId),
    sellerUserId,
    reviewerUserId: new ObjectId(),
    orderId: new ObjectId(),
    orderItemIndex: 0,
    rating: 4,
    text: "Inserted for this test.",
    status: "published",
    verifiedPurchase: true,
    editedAt: null,
    withdrawnAt: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  await (await collections()).reviews.insertOne(doc);
  return doc;
}

// --- eligibility -------------------------------------------------------------------------

describe("who can review", () => {
  it("lets a customer review a product from their paid, delivered order, with everything else set by the server", async () => {
    const { seller, product, customer } = await setup();
    expect(dataOf(await read(customer.cookie, product.id)).viewer).toEqual({ state: "eligible" });

    const res = await post(customer.cookie, product.id, { rating: 4, text: "  Good eggs.\r\n\r\n\r\n  Will buy again.  " });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { review } = dataOf(res);
    expect(review).toMatchObject({ rating: 4, text: "Good eggs.\n\nWill buy again.", status: "published", verifiedPurchase: true });

    const doc = await stored(review.id);
    expect(doc.reviewerUserId.equals(customer.userId)).toBe(true);
    expect(doc.sellerUserId.equals(seller.userId)).toBe(true);
    expect(doc.productId.toHexString()).toBe(product.id);
    expect(doc.orderId.toHexString()).toBe(customer.order.id);
    expect(doc.orderItemIndex).toBe(0);
    expect(doc.editedAt).toBeNull();

    const viewer = dataOf(await read(customer.cookie, product.id)).viewer;
    expect(viewer).toMatchObject({ state: "reviewed", review: { id: review.id } });
  });

  it("refuses customers who haven't bought it, haven't paid, or haven't received it yet", async () => {
    const seller = await merchant("poultry-farmer");
    const product = await listProduct(seller.cookie);

    const stranger = await merchant("veterinarian");
    expect(dataOf(await read(stranger.cookie, product.id)).viewer).toEqual({ state: "not_purchased" });
    expect((await post(stranger.cookie, product.id)).status).toBe(403);

    const unpaid = await merchant("veterinarian");
    await place(unpaid.cookie, product.id);
    expect(dataOf(await read(unpaid.cookie, product.id)).viewer).toEqual({ state: "not_purchased" });
    expect((await post(unpaid.cookie, product.id)).status).toBe(403);

    const waiting = await merchant("veterinarian");
    const order = await place(waiting.cookie, product.id);
    await pay(waiting.cookie, order.id);
    await fulfil(seller.cookie, order.id, ["accept", "ship"]);
    expect(dataOf(await read(waiting.cookie, product.id)).viewer).toEqual({ state: "awaiting_delivery" });
    const early = await post(waiting.cookie, product.id);
    expect(early.status).toBe(403);
    expect(errorOf(early)).toMatch(/once your order has been delivered/);

    expect(await reviewCount()).toBe(0);
  });

  it("refuses an order that was cancelled", async () => {
    const seller = await merchant("poultry-farmer");
    const product = await listProduct(seller.cookie);
    const buyer = await merchant("veterinarian");
    const order = await place(buyer.cookie, product.id);
    expect((await callId(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, { cookie: buyer.cookie, body: {} })).status).toBe(200);
    expect((await post(buyer.cookie, product.id)).status).toBe(403);

    // even if a cancelled order somehow had delivery fields, it doesn't count
    await (await collections()).orders.updateOne(
      { _id: new ObjectId(order.id) },
      { $set: { fulfillmentStatus: "delivered", deliveredAt: new Date(), paidAt: new Date(), paymentStatus: "paid" } },
    );
    expect((await post(buyer.cookie, product.id)).status).toBe(403);
  });

  it("still counts a delivered order that was refunded afterwards", async () => {
    const { seller, product, customer } = await setup();
    const refund = await callId(refundRoute, `/api/sales/${customer.order.id}/refund`, customer.order.id, {
      cookie: seller.cookie,
      body: { amountKobo: 1_000_00, reason: "One cracked tray", idempotencyKey: randomUUID() },
    });
    expect(refund.status).toBe(200);
    expect((await post(customer.cookie, product.id)).status).toBe(201);
  });

  it("doesn't let sellers review their own products", async () => {
    const { seller, product } = await setup();
    expect(dataOf(await read(seller.cookie, product.id)).viewer).toEqual({ state: "own_product" });
    const res = await post(seller.cookie, product.id);
    expect(res.status).toBe(403);
    expect(await reviewCount()).toBe(0);
  });

  it("only counts the signed-in customer's own orders", async () => {
    const { product } = await setup();
    // someone who never ordered can't borrow another customer's delivered order
    const other = await merchant("poultry-farmer");
    expect((await post(other.cookie, product.id)).status).toBe(403);
    expect(dataOf(await read(other.cookie, product.id)).viewer).toEqual({ state: "not_purchased" });
  });

  it("requires a verified session and a same-origin request, and 404s unknown or removed products", async () => {
    const { seller, product, customer } = await setup();
    expect((await post(undefined, product.id)).status).toBe(401);
    const { pendingCookie } = await registerPending(newRegistration({ role: "veterinarian" }));
    expect((await post(pendingCookie, product.id)).status).toBe(403);
    expect((await post(customer.cookie, product.id, GOOD, { origin: "https://evil.example" })).status).toBe(403);

    for (const id of ["not-an-id", new ObjectId().toHexString(), "aaaaaaaaaaaa"]) {
      expect((await post(customer.cookie, id)).status).toBe(404);
      expect((await read(customer.cookie, id)).status).toBe(404);
    }

    expect((await callId(archiveRoute, `/api/products/${product.id}`, product.id, { cookie: seller.cookie, method: "DELETE" })).status).toBe(200);
    expect((await post(customer.cookie, product.id)).status).toBe(404);
    expect(await reviewCount()).toBe(0);
  });
});

// --- input --------------------------------------------------------------------------------

describe("review input", () => {
  it("refuses identity, product, order, status and verification fields", async () => {
    const { seller, product, customer } = await setup();
    const forged = await post(customer.cookie, product.id, {
      ...GOOD,
      reviewerUserId: seller.userId.toHexString(),
      productId: new ObjectId().toHexString(),
      orderId: customer.order.id,
      status: "published",
      verifiedPurchase: true,
    });
    expect(forged.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(forged)).sort()).toEqual(["orderId", "productId", "reviewerUserId", "status", "verifiedPurchase"]);
    expect(await reviewCount()).toBe(0);
  });

  it("checks the rating and text", async () => {
    const { product, customer } = await setup();
    for (const rating of [0, 6, 2.5, -1, "5", null]) {
      const res = await post(customer.cookie, product.id, { ...GOOD, rating });
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("rating");
    }
    for (const text of ["", "   ", "Too short", "x".repeat(1_001), 42]) {
      const res = await post(customer.cookie, product.id, { ...GOOD, text });
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("text");
    }
    expect(fieldErrorsOf(await post(customer.cookie, product.id, {}))).toEqual({
      rating: "Choose a star rating.",
      text: "Tell other buyers about this product.",
    });
    expect(await reviewCount()).toBe(0);
    // whitespace doesn't count towards the minimum, and the limit is inclusive
    expect((await post(customer.cookie, product.id, { rating: 1, text: `  ${"y".repeat(1_000)}  ` })).status).toBe(201);
  });
});

// --- duplicates ---------------------------------------------------------------------------

describe("one review per customer per product", () => {
  it("answers a second review with 'already reviewed'", async () => {
    const { product, customer } = await setup();
    expect((await post(customer.cookie, product.id)).status).toBe(201);
    const again = await post(customer.cookie, product.id, { rating: 1, text: "Trying to post a second review." });
    expect(again.status).toBe(409);
    expect(errorOf(again)).toMatch(/already reviewed/);
    expect(await reviewCount()).toBe(1);
  });

  it("stores exactly one review when several are sent at once", async () => {
    const { product, customer } = await setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => post(customer.cookie, product.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await reviewCount()).toBe(1);
  });

  it("keeps one review even with several delivered orders for the product", async () => {
    const { seller, product, customer } = await setup();
    await deliveredCustomer(seller, product, customer);
    expect((await post(customer.cookie, product.id)).status).toBe(201);
    expect((await post(customer.cookie, product.id)).status).toBe(409);
    expect(await reviewCount()).toBe(1);
  });
});

// --- editing and withdrawing ----------------------------------------------------------------

describe("editing and withdrawing", () => {
  it("lets the author change the rating and text, recording when", async () => {
    const { product, customer } = await setup();
    const { review } = dataOf(await post(customer.cookie, product.id));
    const res = await edit(customer.cookie, review.id, { rating: 3, text: "Good, but two eggs were cracked." });
    expect(res.status).toBe(200);
    const doc = await stored(review.id);
    expect(doc).toMatchObject({ rating: 3, text: "Good, but two eggs were cracked.", status: "published", verifiedPurchase: true });
    expect(doc.editedAt).toBeInstanceOf(Date);
    expect(doc.updatedAt.getTime()).toBeGreaterThanOrEqual(doc.createdAt.getTime());
    expect(dataOf(await read(customer.cookie, product.id)).reviews[0]).toMatchObject({ rating: 3, editedAt: doc.editedAt!.toISOString() });

    expect((await edit(customer.cookie, review.id, {})).status).toBe(400);
    expect((await edit(customer.cookie, review.id, { rating: 9 })).status).toBe(400);
  });

  it("never lets an edit set the status, the product or the verified flag", async () => {
    const { product, customer } = await setup();
    const { review } = dataOf(await post(customer.cookie, product.id));
    await (await collections()).reviews.updateOne({ _id: new ObjectId(review.id) }, { $set: { verifiedPurchase: false, status: "pending" } });

    for (const field of [{ verifiedPurchase: true }, { status: "published" }, { productId: new ObjectId().toHexString() }, { reviewerUserId: "x" }]) {
      const res = await edit(customer.cookie, review.id, { rating: 2, ...field });
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty(Object.keys(field)[0]);
    }
    expect(dataOf(await edit(customer.cookie, review.id, { rating: 2 })).review).toMatchObject({
      rating: 2,
      status: "pending",
      verifiedPurchase: false,
    });
  });

  it("hides other people's reviews from edits and withdrawals, including the seller's", async () => {
    const { seller, product, customer } = await setup();
    const { review } = dataOf(await post(customer.cookie, product.id));
    const stranger = await merchant("veterinarian");
    for (const who of [stranger, seller]) {
      expect((await edit(who.cookie, review.id, { rating: 1 })).status).toBe(404);
      expect((await withdraw(who.cookie, review.id)).status).toBe(404);
    }
    expect((await edit(customer.cookie, "nope", { rating: 1 })).status).toBe(404);
    expect((await edit(customer.cookie, review.id, { rating: 1 }))).toMatchObject({ status: 200 });
    expect(await stored(review.id)).toMatchObject({ rating: 1, status: "published" });

    const crossSite = await callId(editRoute, `/api/reviews/${review.id}`, review.id, {
      cookie: customer.cookie,
      body: { rating: 5 },
      method: "PATCH",
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
  });

  it("withdraws a review, then lets the customer write a new one in its place", async () => {
    const { product, customer } = await setup();
    const { review } = dataOf(await post(customer.cookie, product.id));
    expect(dataOf(await withdraw(customer.cookie, review.id)).review.status).toBe("withdrawn");
    expect((await stored(review.id)).withdrawnAt).toBeInstanceOf(Date);
    expect((await withdraw(customer.cookie, review.id)).status).toBe(200);
    expect((await edit(customer.cookie, review.id, { rating: 1 })).status).toBe(409);

    const listed = dataOf(await read(customer.cookie, product.id));
    expect(listed.reviews).toHaveLength(0);
    expect(listed.summary.count).toBe(0);
    expect(listed.viewer).toEqual({ state: "eligible" });

    const again = await post(customer.cookie, product.id, { rating: 2, text: "Second thoughts: it went off quickly." });
    expect(again.status).toBe(201);
    expect(dataOf(again).review).toMatchObject({ id: review.id, rating: 2, status: "published", editedAt: null });
    expect(await reviewCount()).toBe(1);
  });

  it("keeps rejected reviews locked", async () => {
    const { product, customer } = await setup();
    const { review } = dataOf(await post(customer.cookie, product.id));
    await (await collections()).reviews.updateOne({ _id: new ObjectId(review.id) }, { $set: { status: "rejected" } });
    expect((await edit(customer.cookie, review.id, { rating: 5 })).status).toBe(409);
    expect((await withdraw(customer.cookie, review.id)).status).toBe(409);
    expect((await post(customer.cookie, product.id)).status).toBe(409);
    expect(dataOf(await read(customer.cookie, product.id)).viewer).toMatchObject({ state: "reviewed", review: { status: "rejected" } });
  });
});

// --- reading --------------------------------------------------------------------------------

describe("product ratings and lists", () => {
  it("averages published reviews only", async () => {
    const seller = await merchant("poultry-farmer");
    const product = await listProduct(seller.cookie);
    for (const rating of [5, 4, 4]) {
      const buyer = await deliveredCustomer(seller, product);
      expect((await post(buyer.cookie, product.id, { ...GOOD, rating })).status).toBe(201);
    }
    await insertReview(product.id, seller.userId, { rating: 1, status: "pending" });
    await insertReview(product.id, seller.userId, { rating: 1, status: "rejected" });
    await insertReview(product.id, seller.userId, { rating: 1, status: "withdrawn" });
    // another product's reviews don't count either
    const other = await listProduct(seller.cookie);
    await insertReview(other.id, seller.userId, { rating: 1 });

    const { summary, reviews } = dataOf(await read(seller.cookie, product.id));
    expect(summary).toEqual({
      count: 3,
      average: 4.3,
      distribution: [
        { stars: 5, count: 1 },
        { stars: 4, count: 2 },
        { stars: 3, count: 0 },
        { stars: 2, count: 0 },
        { stars: 1, count: 0 },
      ],
    });
    expect(reviews).toHaveLength(3);
    expect(reviews.every((r) => r.verifiedPurchase)).toBe(true);
  });

  it("reports no average for a product without reviews", async () => {
    const seller = await merchant("poultry-farmer");
    const product = await listProduct(seller.cookie);
    const { summary, reviews, hasMore } = dataOf(await read(seller.cookie, product.id));
    expect(summary.count).toBe(0);
    expect(summary.average).toBeNull();
    expect(reviews).toEqual([]);
    expect(hasMore).toBe(false);
  });

  it("shows the reviewer's first name and initial, and nothing about their account or order", async () => {
    const seller = await merchant("poultry-farmer");
    const product = await listProduct(seller.cookie);
    const customer = await deliveredCustomer(seller, product);
    await (await collections()).users.updateOne({ _id: customer.userId }, { $set: { fullName: "Adaeze  Chioma Okafor" } });
    await post(customer.cookie, product.id);

    const res = await read((await merchant("veterinarian")).cookie, product.id);
    const [review] = dataOf(res).reviews;
    expect(review.reviewerName).toBe("Adaeze O.");
    expect(review.verifiedPurchase).toBe(true);
    expect(Object.keys(review).sort()).toEqual(["createdAt", "editedAt", "id", "rating", "reviewerName", "text", "verifiedPurchase"]);
    const raw = JSON.stringify(res.json);
    const user = await (await collections()).users.findOne({ _id: customer.userId });
    for (const secret of [customer.userId.toHexString(), customer.order.id, customer.order.number, user!.phoneNormalized, user!.emailNormalized])
      expect(raw).not.toContain(secret);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("pages through reviews, newest first", async () => {
    const seller = await merchant("poultry-farmer");
    const product = await listProduct(seller.cookie);
    for (let i = 0; i < 12; i++) await insertReview(product.id, seller.userId, { createdAt: new Date(Date.UTC(2026, 0, i + 1)), text: `Review number ${i}` });
    const first = dataOf(await read(seller.cookie, product.id));
    expect(first.reviews).toHaveLength(10);
    expect(first.reviews[0].text).toBe("Review number 11");
    expect(first.hasMore).toBe(true);
    const second = dataOf(await read(seller.cookie, product.id, 2));
    expect(second.reviews.map((r) => r.text)).toEqual(["Review number 1", "Review number 0"]);
    expect(second.hasMore).toBe(false);
    expect(second.summary.count).toBe(12);
    expect((await callId(productReviewsRoute, `/api/products/${product.id}/reviews?page=0`, product.id, { cookie: seller.cookie })).status).toBe(400);
  });

  it("lists only the signed-in user's own reviews on My Reviews, with their status", async () => {
    const { seller, product, customer } = await setup();
    const { review } = dataOf(await post(customer.cookie, product.id));
    const other = await deliveredCustomer(seller, product);
    await post(other.cookie, product.id, { rating: 1, text: "Not what I ordered at all." });
    await withdraw(customer.cookie, review.id);

    const res = await mine(customer.cookie);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { reviews } = dataOf(res);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ id: review.id, productId: product.id, productName: "Fresh eggs", productListed: true, status: "withdrawn" });
    expect(dataOf(await mine(seller.cookie)).reviews).toEqual([]);
    expect((await call(mineRoute, "/api/reviews/mine")).status).toBe(401);
  });
});

// --- limits and failures ------------------------------------------------------------------------

describe("limits and failures", () => {
  it("rate-limits review changes per account", async () => {
    const buyer = await merchant("veterinarian");
    const id = new ObjectId().toHexString();
    for (let i = 0; i < 30; i++) expect((await edit(buyer.cookie, id, { rating: 3 })).status).toBe(404);
    const limited = await edit(buyer.cookie, id, { rating: 3 });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // another account isn't affected
    expect((await edit((await merchant("veterinarian")).cookie, id, { rating: 3 })).status).toBe(404);
  });

  it("reports a database failure without details and without saving anything", async () => {
    const { product, customer } = await setup();
    const original = Collection.prototype.insertOne;
    const spy = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (this: Collection, ...args) {
      if (this.collectionName === "reviews")
        return Promise.reject(Object.assign(new Error("connection to mongodb://internal-host closed"), { name: "MongoNetworkError" }));
      return original.apply(this, args as Parameters<typeof original>) as never;
    });
    try {
      const res = await post(customer.cookie, product.id);
      expect(res.status).toBe(500);
      expect(errorOf(res)).toBe("Something went wrong on our side. Please try again.");
      expect(JSON.stringify(res.json)).not.toMatch(/mongo|internal-host/i);
    } finally {
      spy.mockRestore();
    }
    expect(await reviewCount()).toBe(0);
    expect((await post(customer.cookie, product.id)).status).toBe(201);

    const aggregate = vi.spyOn(Collection.prototype, "aggregate").mockImplementation(() => {
      throw Object.assign(new Error("boom"), { name: "MongoServerError" });
    });
    try {
      const res = await read(customer.cookie, product.id);
      expect(res.status).toBe(500);
      expect(errorOf(res)).toBe("Something went wrong on our side. Please try again.");
    } finally {
      aggregate.mockRestore();
    }
  });
});
