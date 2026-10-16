import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { POST as forgotRoute } from "@/app/api/auth/password/forgot/route";
import { POST as resetRoute } from "@/app/api/auth/password/reset/route";
import { PATCH as replaceAccount } from "@/app/api/bank-details/route";
import { POST as processRoute } from "@/app/api/internal/notifications/process/route";
import { GET as preferencesRoute, PATCH as updatePreferencesRoute } from "@/app/api/notification-preferences/route";
import { PATCH as markRoute } from "@/app/api/notifications/[id]/route";
import { POST as readAllRoute } from "@/app/api/notifications/read-all/route";
import { GET as listRoute } from "@/app/api/notifications/route";
import { GET as unreadRoute } from "@/app/api/notifications/unread-count/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { POST as placeRoute } from "@/app/api/orders/route";
import { POST as postReviewRoute } from "@/app/api/products/[id]/reviews/route";
import { POST as addProductRoute } from "@/app/api/products/route";
import { DELETE as unsubscribeRoute, POST as subscribeRoute } from "@/app/api/push-subscriptions/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import { POST as payoutRoute } from "@/app/api/payouts/route";
import { POST as webhookRoute } from "@/app/api/webhooks/paystack/route";
import type { NotificationPage, PreferencesResponse, UnreadCount } from "@/lib/notifications/types";
import type { CheckoutResponse, OrderResponse, Product, ProductResponse, VerifyPaymentResponse } from "@/lib/orders/types";
import type { NotificationDoc } from "@/lib/server/models";
import {
  claimDelivery,
  MAX_ATTEMPTS,
  notificationEmail,
  processDelivery,
  recoverStaleClaims,
  retryDelayMs,
  runNotificationJob,
} from "@/lib/server/notification-delivery";
import { createNotifications, sweepNotificationSync } from "@/lib/server/notifications";
import { collections } from "./support/db";
import { newRegistration, registerPending, registerVerified } from "./support/flows";
import { call, dataOf, ORIGIN, type CallOptions, type CallResult } from "./support/http";
import { flushAfter, lastResetToken, outbox } from "./support/outbox";
import { completeCheckout, signedChargeEvent, TEST_PAYSTACK_KEY } from "./support/paystack";
import { ACCESS, addBankAccount, merchant, paidOrder, ZENITH } from "./support/wallet";

// Notifications are only ever created by the server from events it has
// recorded: these tests drive real orders, payments (through the fake
// Paystack), payouts, reviews and bank-detail changes through the API and
// check who was told what. External sends go to the fake Termii / Resend in
// tests/support/setup.ts; web-push is mocked below. Nothing reaches a real
// provider.

const push = vi.hoisted(() => ({
  sent: [] as { endpoint: string; payload: string }[],
  /** an HTTP status to fail every push with, or 0 to accept them */
  failWith: 0,
}));

vi.mock("web-push", () => {
  class WebPushError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "WebPushError";
    }
  }
  return {
    default: {
      sendNotification: vi.fn(async (subscription: { endpoint: string }, payload: string) => {
        if (push.failWith) throw new WebPushError("Received unexpected response code", push.failWith);
        push.sent.push({ endpoint: subscription.endpoint, payload });
        return { statusCode: 201, body: "", headers: {} };
      }),
    },
    WebPushError,
  };
});

const JOB_SECRET = "test-notification-job-secret-32-chars!!";
// format-valid placeholders: web-push is mocked, so no real key is ever used
const FAKE_VAPID = {
  WEB_PUSH_VAPID_PUBLIC_KEY: `B${"A".repeat(86)}`,
  WEB_PUSH_VAPID_PRIVATE_KEY: "C".repeat(43),
  WEB_PUSH_SUBJECT: "mailto:ops@example.com",
};

function enablePush() {
  push.sent.length = 0;
  push.failWith = 0;
  for (const [key, value] of Object.entries(FAKE_VAPID)) vi.stubEnv(key, value);
}

function enableEmail() {
  vi.stubEnv("RESEND_API_KEY", "re_test_placeholder");
  vi.stubEnv("EMAIL_FROM", "Farm Korret <noreply@example.com>");
}

type Ctx = { params: Promise<{ id: string }> };
type RouteWithId = (request: Request, context: Ctx) => Promise<Response>;

function callId<T>(handler: RouteWithId, path: string, id: string, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve({ id }) }), path, options);
}

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;

const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 100, description: "" };
const NOTE = "Deliver to 12 Ring Road, Ibadan. Call 08031234567 on arrival.";


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

async function startCheckout(cookie: string, id: string) {
  return dataOf(await callId<CheckoutResponse>(checkoutRoute, `/api/orders/${id}/checkout`, id, { cookie, body: {} }))
    .reference;
}

async function verify(cookie: string, id: string, reference: string) {
  return dataOf(
    await callId<VerifyPaymentResponse>(verifyRoute, `/api/orders/${id}/verify-payment`, id, { cookie, body: { reference } }),
  ).result;
}

async function pay(cookie: string, id: string) {
  const reference = await startCheckout(cookie, id);
  const transaction = completeCheckout(reference);
  expect(await verify(cookie, id, reference)).toBe("paid");
  return transaction;
}

async function fulfil(cookie: string, id: string, action: string) {
  return callId(fulfilRoute, `/api/sales/${id}/fulfillment`, id, { cookie, body: { action } });
}

function webhook(raw: string, signature: string) {
  const headers = new Headers({ "content-type": "application/json", "x-real-ip": "52.31.139.75" });
  headers.set("x-paystack-signature", signature);
  return webhookRoute(new Request(`${ORIGIN}/api/webhooks/paystack`, { method: "POST", headers, body: raw }));
}

function processJob(authorization: string | null) {
  const headers = new Headers();
  if (authorization !== null) headers.set("authorization", authorization);
  return processRoute(new Request(`${ORIGIN}/api/internal/notifications/process`, { method: "POST", headers }));
}

/** A seller with a listing and a separate buyer. */
async function market() {
  const seller = await merchant("poultry-farmer");
  const product = await listProduct(seller.cookie);
  const buyer = await merchant("veterinarian");
  return { seller, buyer, product };
}

async function paidSale() {
  const { seller, buyer, product } = await market();
  const order = await place(buyer.cookie, product.id);
  const transaction = await pay(buyer.cookie, order.id);
  return { seller, buyer, product, order, transaction };
}

async function stored(userId: ObjectId) {
  return (await collections()).notifications.find({ recipientUserId: userId }).sort({ createdAt: 1, _id: 1 }).toArray();
}
const typesOf = async (userId: ObjectId) => (await stored(userId)).map((n) => n.type);

const inbox = (cookie: string, query = "") => call<NotificationPage>(listRoute, `/api/notifications${query}`, { cookie });
const unread = async (cookie: string) =>
  dataOf(await call<UnreadCount>(unreadRoute, "/api/notifications/unread-count", { cookie })).unreadCount;
const mark = (cookie: string, id: string, body: unknown, options: CallOptions = {}) =>
  callId(markRoute as RouteWithId, `/api/notifications/${id}`, id, { cookie, body, method: "PATCH", ...options });

/** Inserts notifications directly (for inbox mechanics only; events are tested through the real flows). */
async function seed(userId: ObjectId, count: number, overrides: Partial<NotificationDoc> = {}) {
  const base = Date.now() - count * 60_000;
  const docs: NotificationDoc[] = Array.from({ length: count }, (_, i) => ({
    _id: new ObjectId(),
    recipientUserId: userId,
    type: "order_accepted",
    category: "orders",
    title: `Notice ${i + 1}`,
    body: "Something happened.",
    url: "/orders",
    eventKey: `seed:${randomUUID()}`,
    subject: { kind: "account" as const, id: "test" },
    eventAt: new Date(base + i * 60_000),
    readAt: null,
    createdAt: new Date(base + i * 60_000),
    ...overrides,
  }));
  await (await collections()).notifications.insertMany(docs);
  return docs;
}

const notificationSms = () => outbox.sms.filter((m) => m.text.startsWith("Farm Korret:"));

function expectNothingSensitiveLogged(...extra: string[]) {
  const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
  for (const secret of [JOB_SECRET, TEST_PAYSTACK_KEY, ZENITH.accountNumber, "08031234567", "Ring Road", ...extra])
    expect(logged).not.toContain(secret);
}

// --- the inbox API ----------------------------------------------------------------------------

describe("the inbox", () => {
  it("lists only the signed-in user's notifications, newest first, without caching", async () => {
    const me = await merchant();
    const other = await merchant();
    await seed(me.userId, 3);
    await seed(other.userId, 2, { title: "Not yours" });

    const res = await inbox(me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = dataOf(res);
    expect(page.notifications.map((n) => n.title)).toEqual(["Notice 3", "Notice 2", "Notice 1"]);
    expect(page).toMatchObject({ page: 1, hasMore: false, unreadCount: 3 });
    expect(JSON.stringify(page)).not.toContain("Not yours");
    expect(Object.keys(page.notifications[0]).sort()).toEqual(
      ["body", "category", "createdAt", "id", "readAt", "title", "type", "url"].sort(),
    );
  });

  it("shows an empty inbox", async () => {
    const me = await merchant();
    expect(dataOf(await inbox(me.cookie))).toEqual({ notifications: [], page: 1, hasMore: false, unreadCount: 0 });
    expect(await unread(me.cookie)).toBe(0);
  });

  it("pages 20 at a time and filters by unread and category", async () => {
    const me = await merchant();
    const docs = await seed(me.userId, 23);
    await seed(me.userId, 2, { type: "payout_paid", category: "payouts", title: "Paid out" });
    await (await collections()).notifications.updateOne({ _id: docs[22]._id }, { $set: { readAt: new Date() } });

    const first = dataOf(await inbox(me.cookie));
    expect(first.notifications).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    const second = dataOf(await inbox(me.cookie, "?page=2"));
    expect(second.notifications).toHaveLength(5);
    expect(second.hasMore).toBe(false);
    expect(dataOf(await inbox(me.cookie, "?page=9")).notifications).toEqual([]);

    const unreadOnly = dataOf(await inbox(me.cookie, "?filter=unread&page=2"));
    expect(unreadOnly.notifications).toHaveLength(4);
    expect(unreadOnly.notifications.every((n) => n.readAt === null)).toBe(true);
    const payouts = dataOf(await inbox(me.cookie, "?category=payouts"));
    expect(payouts.notifications.map((n) => n.title)).toEqual(["Paid out", "Paid out"]);
    expect(first.unreadCount).toBe(24);
  });

  it("rejects bad filters, signed-out and unverified callers", async () => {
    const me = await merchant();
    for (const query of ["?filter=read", "?category=promotions", "?page=0", "?page=abc"])
      expect((await inbox(me.cookie, query)).status).toBe(400);
    expect((await inbox("")).status).toBe(401);
    expect((await call(unreadRoute, "/api/notifications/unread-count")).status).toBe(401);
    const { pendingCookie } = await registerPending(newRegistration());
    expect((await inbox(pendingCookie)).status).toBe(403);
    expect((await call(readAllRoute, "/api/notifications/read-all", { cookie: pendingCookie, body: {} })).status).toBe(403);
  });

  it("marks one read and unread, keeping the unread count in step", async () => {
    const me = await merchant();
    const [a, b] = await seed(me.userId, 2);
    const res = await mark(me.cookie, a._id.toHexString(), { read: true });
    expect(res.status).toBe(200);
    const data = dataOf(res) as { notification: { readAt: string | null }; unreadCount: number };
    expect(data.notification.readAt).not.toBeNull();
    expect(data.unreadCount).toBe(1);
    // reading again keeps the first read time
    const firstRead = (await stored(me.userId)).find((n) => n._id.equals(a._id))!.readAt;
    await mark(me.cookie, a._id.toHexString(), { read: true });
    expect((await stored(me.userId)).find((n) => n._id.equals(a._id))!.readAt).toEqual(firstRead);

    expect(dataOf(await mark(me.cookie, a._id.toHexString(), { read: false }))).toMatchObject({ unreadCount: 2 });
    expect(await unread(me.cookie)).toBe(2);
    expect(b).toBeTruthy();
  });

  it("treats someone else's notification and invalid ids as not found", async () => {
    const me = await merchant();
    const other = await merchant();
    const [theirs] = await seed(other.userId, 1);
    const res = await mark(me.cookie, theirs._id.toHexString(), { read: true });
    expect(res.status).toBe(404);
    expect((await stored(other.userId))[0].readAt).toBeNull();
    expect((await mark(me.cookie, "not-an-id", { read: true })).status).toBe(404);
    expect((await mark(me.cookie, new ObjectId().toHexString(), { read: true })).status).toBe(404);
  });

  it("validates the body and the request origin", async () => {
    const me = await merchant();
    const [n] = await seed(me.userId, 1);
    const id = n._id.toHexString();
    expect((await mark(me.cookie, id, { read: "yes" })).status).toBe(400);
    expect((await mark(me.cookie, id, { read: true, title: "Hacked" })).status).toBe(400);
    expect((await mark(me.cookie, id, { read: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await stored(me.userId))[0]).toMatchObject({ readAt: null, title: "Notice 1" });
  });

  it("marks everything read for this user only", async () => {
    const me = await merchant();
    const other = await merchant();
    await seed(me.userId, 3);
    await seed(other.userId, 2);
    const res = await call(readAllRoute, "/api/notifications/read-all", { cookie: me.cookie, body: {} });
    expect(dataOf(res)).toEqual({ updated: 3, unreadCount: 0 });
    expect(dataOf(await call(readAllRoute, "/api/notifications/read-all", { cookie: me.cookie, body: {} }))).toEqual({
      updated: 0,
      unreadCount: 0,
    });
    expect(await unread(other.cookie)).toBe(2);
  });

  it("answers with a generic error when the database fails", async () => {
    const me = await merchant();
    const { notifications } = await collections();
    const spy = vi.spyOn(Object.getPrototypeOf(notifications), "find").mockImplementation(() => {
      throw new Error("connection reset by mongodb host 10.0.0.5");
    });
    try {
      const res = await inbox(me.cookie);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.json)).not.toMatch(/mongo|10\.0\.0\.5|stack/i);
    } finally {
      spy.mockRestore();
    }
  });
});

// --- preferences --------------------------------------------------------------------------------

describe("notification preferences", () => {
  const get = (cookie: string) => call<PreferencesResponse>(preferencesRoute, "/api/notification-preferences", { cookie });
  const patch = (cookie: string, body: unknown, options: CallOptions = {}) =>
    call<PreferencesResponse>(updatePreferencesRoute, "/api/notification-preferences", {
      cookie,
      body,
      method: "PATCH",
      ...options,
    });

  it("starts from conservative defaults and says which channels can reach the account", async () => {
    const me = await merchant();
    const data = dataOf(await get(me.cookie));
    expect(data.preferences.reviews).toEqual({ email: false, sms: false, push: true });
    expect(data.preferences.security).toEqual({ email: true, sms: true, push: true });
    expect(data.mandatory).toEqual(["security"]);
    // email isn't set up in tests and no address is verified; SMS goes to the verified phone
    expect(data.channels.email.available).toBe(false);
    expect(data.channels.sms.available).toBe(true);
    expect(data.channels.push).toEqual({ available: false, note: "Push notifications aren't set up yet." });
    expect(data.pushPublicKey).toBeNull();
  });

  it("stores changes per user and refuses to turn off security notices", async () => {
    const me = await merchant();
    const other = await merchant();
    const res = await patch(me.cookie, { orders: { sms: false }, reviews: { email: true } });
    expect(res.status).toBe(200);
    expect(dataOf(res).preferences.orders).toEqual({ email: true, sms: false, push: true });
    expect(dataOf(await get(me.cookie)).preferences.reviews.email).toBe(true);
    expect(dataOf(await get(other.cookie)).preferences.orders.sms).toBe(true);

    for (const bad of [
      { security: { sms: false } },
      { promotions: { email: true } },
      { orders: { fax: true } },
      { orders: { sms: "no" } },
      { orders: [] },
      {},
    ])
      expect((await patch(me.cookie, bad)).status).toBe(400);
    expect((await patch(me.cookie, { orders: { sms: true } }, { origin: "https://evil.example" })).status).toBe(403);
    expect(dataOf(await get(me.cookie)).preferences.orders.sms).toBe(false);
    expect((await get("")).status).toBe(401);
  });

  it("skips channels turned off before the delivery was sent, keeping the inbox entry", async () => {
    const { seller } = await paidSale();
    const { deliveries } = await collections();
    expect(await deliveries.countDocuments({ recipientUserId: seller.userId, channel: "sms" })).toBe(1);
    await patch(seller.cookie, { orders: { sms: false } });
    await runNotificationJob();
    expect(await deliveries.findOne({ recipientUserId: seller.userId, channel: "sms" })).toMatchObject({
      state: "skipped",
      lastFailure: "channel_disabled",
    });
    expect(notificationSms()).toHaveLength(0);
    expect(await typesOf(seller.userId)).toContain("sale_paid");
  });

  it("doesn't queue channels that are off when the event happens", async () => {
    const { seller, buyer, product } = await market();
    await patch(seller.cookie, { orders: { sms: false } });
    const order = await place(buyer.cookie, product.id);
    await pay(buyer.cookie, order.id);
    expect(await (await collections()).deliveries.countDocuments({ recipientUserId: seller.userId })).toBe(0);
    expect(await typesOf(seller.userId)).toEqual(["sale_paid"]);
  });
});

// --- business events --------------------------------------------------------------------------

describe("order and payment events", () => {
  it("tells the buyer about the order, and the seller only once it's paid", async () => {
    const { seller, buyer, product } = await market();
    const order = await place(buyer.cookie, product.id);
    expect(await typesOf(buyer.userId)).toEqual(["order_placed"]);
    expect(await typesOf(seller.userId)).toEqual([]);

    await pay(buyer.cookie, order.id);
    expect(await typesOf(buyer.userId)).toEqual(["order_placed", "payment_confirmed"]);
    const [sale] = await stored(seller.userId);
    expect(sale).toMatchObject({ type: "sale_paid", category: "orders", url: `/sales/${order.id}`, readAt: null });
    expect((await stored(buyer.userId))[1].url).toBe(`/orders/${order.id}`);
    // no address, phone number or amounts beyond what the title/body say
    expect(JSON.stringify(await stored(seller.userId))).not.toMatch(/Ring Road|08031234567|deliveryNote/);
  });

  it("doesn't notify twice when the webhook repeats a payment already verified", async () => {
    const { seller, buyer, transaction } = await paidSale();
    const { raw, signature } = signedChargeEvent(transaction);
    expect((await webhook(raw, signature)).status).toBe(200);
    expect((await webhook(raw, signature)).status).toBe(200);
    expect(await typesOf(buyer.userId)).toEqual(["order_placed", "payment_confirmed"]);
    expect(await typesOf(seller.userId)).toEqual(["sale_paid"]);
  });

  it("tells the buyer when Paystack reports a failed payment, and nobody else", async () => {
    const { seller, buyer, product } = await market();
    const order = await place(buyer.cookie, product.id);
    const reference = await startCheckout(buyer.cookie, order.id);
    completeCheckout(reference, "failed");
    expect(await verify(buyer.cookie, order.id, reference)).toBe("failed");
    expect(await verify(buyer.cookie, order.id, reference)).toBe("failed");
    expect(await typesOf(buyer.userId)).toEqual(["order_placed", "payment_failed"]);
    expect(await typesOf(seller.userId)).toEqual([]);
  });

  it("follows the order through acceptance, dispatch and delivery, once per change", async () => {
    const { seller, buyer, order } = await paidSale();
    expect((await fulfil(seller.cookie, order.id, "accept")).status).toBe(200);
    // an unchanged status is refused and says nothing new
    expect((await fulfil(seller.cookie, order.id, "accept")).status).toBeGreaterThanOrEqual(400);
    expect((await fulfil(seller.cookie, order.id, "ship")).status).toBe(200);
    expect((await fulfil(seller.cookie, order.id, "deliver")).status).toBe(200);
    expect(await typesOf(buyer.userId)).toEqual([
      "order_placed",
      "payment_confirmed",
      "order_accepted",
      "order_dispatched",
      "order_delivered",
    ]);
    // the seller did these themselves
    expect(await typesOf(seller.userId)).toEqual(["sale_paid"]);
  });

  it("tells the seller when the buyer cancels a paid order, and the buyer about the refund", async () => {
    const { seller, buyer, order } = await paidSale();
    const res = await callId(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, {
      cookie: buyer.cookie,
      body: { reason: "Ordered by mistake" },
    });
    expect(res.status).toBe(200);
    const sellerTypes = await typesOf(seller.userId);
    expect(sellerTypes).toContain("sale_cancelled");
    const buyerTypes = await typesOf(buyer.userId);
    expect(buyerTypes).not.toContain("order_cancelled");
    expect(buyerTypes.some((t) => t === "refund_processing" || t === "refund_completed")).toBe(true);
  });

  it("doesn't tell the seller about a cancelled order that was never paid", async () => {
    const { seller, buyer, product } = await market();
    const order = await place(buyer.cookie, product.id);
    const res = await callId(cancelRoute, `/api/orders/${order.id}/cancel`, order.id, {
      cookie: buyer.cookie,
      body: { reason: "Ordered by mistake" },
    });
    expect(res.status).toBe(200);
    expect(await typesOf(seller.userId)).toEqual([]);
    expect(await typesOf(buyer.userId)).toEqual(["order_placed"]);
  });

  it("never notifies someone who isn't part of the order", async () => {
    const outsider = await merchant();
    const { order, seller } = await paidSale();
    await fulfil(seller.cookie, order.id, "accept");
    expect(await stored(outsider.userId)).toEqual([]);
    expect((await mark(outsider.cookie, (await stored(seller.userId))[0]._id.toHexString(), { read: true })).status).toBe(
      404,
    );
  });

  it("sends nothing externally until the job runs (no sends inside the payment)", async () => {
    const { seller } = await paidSale();
    expect(notificationSms()).toHaveLength(0);
    const result = await runNotificationJob();
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const sms = notificationSms();
    expect(sms).toHaveLength(1);
    expect(sms[0].text).toMatch(/^Farm Korret: New paid order \S+\. Open the app for details\.$/);
    const user = await (await collections()).users.findOne({ _id: seller.userId });
    expect(sms[0].to).toBe(user!.phoneNormalized.replace(/^\+/, ""));
    expectNothingSensitiveLogged(user!.phoneNormalized);
  });
});

describe("payouts, reviews and account events", () => {
  it("tells the merchant about each payout status", async () => {
    const m = await merchant();
    await addBankAccount(m.cookie);
    await paidOrder(m.userId, { grossKobo: 10_000_00 });
    const res = await call(payoutRoute, "/api/payouts", { body: { amountKobo: 4_000_00, idempotencyKey: randomUUID() }, cookie: m.cookie });
    expect(res.status).toBe(201);
    await flushAfter();
    const types = await typesOf(m.userId);
    expect(types).toEqual(["bank_account_added", "payout_requested", "payout_processing", "payout_paid"]);
    const paid = (await stored(m.userId)).at(-1)!;
    expect(paid.url).toBe("/wallet/payouts");
    expect(JSON.stringify(await stored(m.userId))).not.toContain(ZENITH.accountNumber);
  });

  it("tells the seller about a new published review", async () => {
    const { seller, buyer, order, product } = await paidSale();
    for (const action of ["accept", "ship", "deliver"]) await fulfil(seller.cookie, order.id, action);
    const res = await call(
      (request) => (postReviewRoute as RouteWithId)(request, { params: Promise.resolve({ id: product.id }) }),
      `/api/products/${product.id}/reviews`,
      { cookie: buyer.cookie, body: { rating: 5, text: "Fresh and well packed." } },
    );
    expect(res.status).toBe(201);
    const review = (await stored(seller.userId)).find((n) => n.type === "review_published");
    expect(review).toMatchObject({ category: "reviews", url: `/market/${(product as Product).id}#reviews` });
    expect(review!.body).not.toContain("Fresh and well packed");
  });

  it("tells the account owner when bank details are added and changed", async () => {
    const m = await merchant();
    await addBankAccount(m.cookie);
    await addBankAccount(m.cookie, ACCESS, replaceAccount);
    const notices = await stored(m.userId);
    expect(notices.map((n) => n.type)).toEqual(["bank_account_added", "bank_account_changed"]);
    expect(notices.every((n) => n.category === "security")).toBe(true);
    expect(JSON.stringify(notices)).not.toMatch(/0123456789|1234567890/);
    // security notices go out by SMS whatever the preferences say
    expect(await (await collections()).deliveries.countDocuments({ recipientUserId: m.userId, channel: "sms" })).toBe(2);
  });
});

// --- recovery and dedupe ------------------------------------------------------------------------

describe("durability", () => {
  it("creates notifications the post-commit step missed, exactly once", async () => {
    const { buyer, seller, order } = await paidSale();
    const db = await collections();
    // as if the process died between the payment committing and the notifications being written
    await db.notifications.deleteMany({});
    await db.deliveries.deleteMany({});
    await db.orders.updateOne(
      { _id: new ObjectId(order.id) },
      { $set: { notifiedThrough: 0, notifySyncAt: new Date(Date.now() - 60_000) } },
    );

    const first = await sweepNotificationSync(10);
    expect(first).toEqual({ synced: 1, failed: 0 });
    expect(await typesOf(buyer.userId)).toEqual(["order_placed", "payment_confirmed"]);
    expect(await typesOf(seller.userId)).toEqual(["sale_paid"]);
    expect((await db.orders.findOne({ _id: new ObjectId(order.id) }))!.notifySyncAt).toBeNull();

    // running again, or creating the same events again, adds nothing
    await db.orders.updateOne(
      { _id: new ObjectId(order.id) },
      { $set: { notifiedThrough: 0, notifySyncAt: new Date(Date.now() - 60_000) } },
    );
    await sweepNotificationSync(10);
    expect(await db.notifications.countDocuments({})).toBe(3);
    expect(await db.deliveries.countDocuments({ recipientUserId: seller.userId })).toBe(1);
  });

  it("dedupes concurrent creation of the same event", async () => {
    const me = await merchant();
    const spec = {
      recipientUserId: me.userId,
      type: "payout_paid" as const,
      title: "Payout paid",
      body: "Your payout was paid.",
      url: "/wallet/payouts",
      eventKey: `payout:${new ObjectId().toHexString()}:2:paid`,
      subject: { kind: "account" as const, id: "test" },
      eventAt: new Date(),
    };
    const results = await Promise.all([createNotifications([spec]), createNotifications([spec]), createNotifications([spec])]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await (await collections()).notifications.countDocuments({ recipientUserId: me.userId })).toBe(1);
    expect(await (await collections()).deliveries.countDocuments({ recipientUserId: me.userId, channel: "sms" })).toBe(1);
  });

  it("never stores an external link", async () => {
    const me = await merchant();
    for (const url of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      await createNotifications([
        {
          recipientUserId: me.userId,
          type: "order_accepted",
          title: "t",
          body: "b",
          url,
          eventKey: `x:${randomUUID()}`,
          subject: { kind: "account" as const, id: "test" },
          eventAt: new Date(),
        },
      ]);
    }
    expect((await stored(me.userId)).map((n) => n.url)).toEqual([null, null, null, null]);
  });
});

// --- delivery -------------------------------------------------------------------------------

describe("the delivery job", () => {
  it("is hidden without a secret and refuses a wrong one", async () => {
    expect((await processJob(null)).status).toBe(401);
    expect((await processJob("Bearer wrong")).status).toBe(401);
    expect((await processJob(JOB_SECRET)).status).toBe(401);
    vi.stubEnv("NOTIFICATION_JOB_SECRET", "");
    expect((await processJob(`Bearer ${JOB_SECRET}`)).status).toBe(404);
  });

  it("returns counts only", async () => {
    await paidSale();
    const res = await processJob(`Bearer ${JOB_SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ok: true; data: Record<string, number> };
    expect(Object.values(body.data).every((v) => typeof v === "number")).toBe(true);
    expect(body.data.sent).toBe(1);
    expectNothingSensitiveLogged();
  });

  it("retries SMS failures with backoff, then gives up after the limit", async () => {
    const { seller } = await paidSale();
    const { deliveries } = await collections();
    outbox.smsFailing = true;
    await runNotificationJob();
    let delivery = (await deliveries.findOne({ recipientUserId: seller.userId, channel: "sms" }))!;
    expect(delivery).toMatchObject({ state: "failed", attempts: 1, lastFailure: "http_400", sentAt: null });

    // a 5xx is worth retrying
    await deliveries.updateOne({ _id: delivery._id }, { $set: { state: "pending", attempts: 0, nextAttemptAt: new Date() } });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("termii") ? Response.json({ message: "down" }, { status: 503 }) : realFetch(input, init),
    );
    const before = Date.now();
    await runNotificationJob();
    delivery = (await deliveries.findOne({ _id: delivery._id }))!;
    expect(delivery).toMatchObject({ state: "retryable_failure", attempts: 1, lastFailure: "http_503", claimToken: null });
    const wait = delivery.nextAttemptAt!.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(30_000);
    expect(wait).toBeLessThanOrEqual(61_000);

    // not due yet: nothing is claimed
    expect(await claimDelivery()).toBeNull();
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await deliveries.updateOne({ _id: delivery._id }, { $set: { nextAttemptAt: new Date() } });
      await runNotificationJob();
    }
    delivery = (await deliveries.findOne({ _id: delivery._id }))!;
    expect(delivery).toMatchObject({ state: "exhausted", attempts: MAX_ATTEMPTS, sentAt: null });
    await deliveries.updateOne({ _id: delivery._id }, { $set: { nextAttemptAt: new Date() } });
    expect(await claimDelivery()).toBeNull();
    // the inbox entry stays
    expect(await typesOf(seller.userId)).toEqual(["sale_paid"]);
  });

  it("caps the backoff and keeps jitter within bounds", () => {
    expect(retryDelayMs(1, () => 0)).toBe(30_000);
    expect(retryDelayMs(1, () => 1)).toBe(60_000);
    expect(retryDelayMs(3, () => 1)).toBe(240_000);
    expect(retryDelayMs(20, () => 1)).toBe(60 * 60_000);
    expect(retryDelayMs(20, () => 0)).toBe(30 * 60_000);
  });

  it("skips SMS when Termii isn't configured, without failing anything", async () => {
    const { seller } = await paidSale();
    vi.stubEnv("TERMII_API_KEY", "");
    await runNotificationJob();
    expect(await (await collections()).deliveries.findOne({ recipientUserId: seller.userId })).toMatchObject({
      state: "skipped",
      lastFailure: "not_configured",
    });
    expect(notificationSms()).toHaveLength(0);
  });

  it("only one worker gets a delivery, and a crashed worker's claim is recovered", async () => {
    const { seller } = await paidSale();
    const claims = await Promise.all([claimDelivery(), claimDelivery(), claimDelivery()]);
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    const [claimed] = won;
    expect(claimed).toMatchObject({ state: "sending", attempts: 1 });

    // the worker dies; after the lease, the claim is put back
    expect(await recoverStaleClaims()).toBe(0);
    const later = new Date(Date.now() + 6 * 60_000);
    expect(await recoverStaleClaims(later)).toBe(1);
    const { deliveries } = await collections();
    expect(await deliveries.findOne({ _id: claimed!._id })).toMatchObject({
      state: "retryable_failure",
      lastFailure: "interrupted",
      claimToken: null,
    });
    // the old worker waking up can't overwrite the new state
    expect(await processDelivery(claimed!)).toBe("lost");
    expect(notificationSms()).toHaveLength(1);
    expect((await deliveries.findOne({ _id: claimed!._id }))!.state).toBe("retryable_failure");

    const again = (await claimDelivery(later))!;
    expect(again.attempts).toBe(2);
    expect(await processDelivery(again, later)).toBe("sent");
    expect(await deliveries.findOne({ _id: claimed!._id })).toMatchObject({ state: "sent", providerMessageId: expect.any(String) });
    expect(seller).toBeTruthy();
  });

  it("doesn't mark a delivery sent when the provider gives no message id", async () => {
    const { seller } = await paidSale();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("termii") ? Response.json({ message: "Successfully Sent" }) : realFetch(input, init),
    );
    await runNotificationJob();
    // an "OK" without a message id isn't proof of sending: it's retried, never marked sent
    expect(await (await collections()).deliveries.findOne({ recipientUserId: seller.userId })).toMatchObject({
      state: "retryable_failure",
      lastFailure: "http_200",
      sentAt: null,
      providerMessageId: null,
    });
  });

  it("drops deliveries too old to be useful", async () => {
    const { seller } = await paidSale();
    const { notifications } = await collections();
    await notifications.updateMany({ recipientUserId: seller.userId }, { $set: { eventAt: new Date(Date.now() - 25 * 60 * 60_000) } });
    await runNotificationJob();
    expect(await (await collections()).deliveries.findOne({ recipientUserId: seller.userId })).toMatchObject({
      state: "skipped",
      lastFailure: "stale",
    });
    expect(notificationSms()).toHaveLength(0);
  });
});

describe("email", () => {
  it("is never queued for an unverified address", async () => {
    enableEmail();
    const { seller } = await paidSale();
    expect(await (await collections()).deliveries.countDocuments({ recipientUserId: seller.userId, channel: "email" })).toBe(0);
  });

  it("sends an escaped message with an app link once the address is verified", async () => {
    enableEmail();
    const { seller, buyer, product } = await market();
    await (await collections()).users.updateOne({ _id: seller.userId }, { $set: { emailVerifiedAt: new Date() } });
    const order = await place(buyer.cookie, product.id);
    await pay(buyer.cookie, order.id);
    await runNotificationJob();
    const { deliveries } = await collections();
    expect(await deliveries.findOne({ recipientUserId: seller.userId, channel: "email" })).toMatchObject({
      state: "sent",
      providerMessageId: "email-1",
    });
    expect(outbox.email).toHaveLength(1);
    expect(outbox.email[0].text).toContain(`http://localhost:3000/sales/${order.id}`);
    expect(outbox.email[0].text).not.toMatch(/Ring Road|08031234567/);
  });

  it("escapes HTML in templates", () => {
    const { html, text } = notificationEmail({
      title: "<script>alert(1)</script>",
      body: 'Tom & "Jerry"',
      url: "/orders",
      category: "orders",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain("Tom &#38; &#34;Jerry&#34;");
    expect(text).toContain("http://localhost:3000/orders");
  });

  it("skips email when Resend isn't configured", async () => {
    enableEmail();
    const { seller, buyer, product } = await market();
    await (await collections()).users.updateOne({ _id: seller.userId }, { $set: { emailVerifiedAt: new Date() } });
    const order = await place(buyer.cookie, product.id);
    await pay(buyer.cookie, order.id);
    vi.stubEnv("RESEND_API_KEY", "");
    await runNotificationJob();
    expect(await (await collections()).deliveries.findOne({ recipientUserId: seller.userId, channel: "email" })).toMatchObject({
      state: "skipped",
      lastFailure: "not_configured",
    });
    expect(outbox.email).toHaveLength(0);
  });
});

describe("web push", () => {
  const subscription = (n = 1) => ({
    endpoint: `https://push.example.test/send/${n}-${randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: `B${"p".repeat(86)}`, auth: "a".repeat(22) },
  });
  const subscribe = (cookie: string, body: unknown, options: CallOptions = {}) =>
    call(subscribeRoute, "/api/push-subscriptions", { cookie, body, ...options });
  const unsubscribe = (cookie: string, endpoint: string) =>
    call(unsubscribeRoute, "/api/push-subscriptions", { cookie, body: { endpoint }, method: "DELETE" });

  it("isn't offered until it's configured", async () => {
    const me = await merchant();
    const res = await subscribe(me.cookie, subscription());
    expect(res.status).toBe(503);
    expect(await (await collections()).pushSubscriptions.countDocuments({})).toBe(0);
  });

  it("saves a subscription for the signed-in user only and validates it", async () => {
    enablePush();
    const me = await merchant();
    const sub = subscription();
    expect((await subscribe(me.cookie, sub)).status).toBe(201);
    expect((await subscribe(me.cookie, sub)).status).toBe(201);
    const { pushSubscriptions } = await collections();
    expect(await pushSubscriptions.countDocuments({ userId: me.userId })).toBe(1);

    expect((await subscribe(me.cookie, { ...sub, endpoint: "http://insecure.example/x" })).status).toBe(400);
    expect((await subscribe(me.cookie, { ...sub, keys: { p256dh: "x", auth: "y" } })).status).toBe(400);
    expect((await subscribe(me.cookie, { ...sub, userId: new ObjectId().toHexString() })).status).toBe(400);
    expect((await subscribe("", sub)).status).toBe(401);
    expect((await subscribe(me.cookie, sub, { origin: "https://evil.example" })).status).toBe(403);

    const prefs = dataOf(await call<PreferencesResponse>(preferencesRoute, "/api/notification-preferences", { cookie: me.cookie }));
    expect(prefs.channels.push.available).toBe(true);
    expect(prefs.pushPublicKey).toBe(FAKE_VAPID.WEB_PUSH_VAPID_PUBLIC_KEY);
    expect(JSON.stringify(prefs)).not.toContain(FAKE_VAPID.WEB_PUSH_VAPID_PRIVATE_KEY);
  });

  it("only lets the owner remove a subscription", async () => {
    enablePush();
    const me = await merchant();
    const other = await merchant();
    const sub = subscription();
    await subscribe(me.cookie, sub);
    const res = await unsubscribe(other.cookie, sub.endpoint);
    expect(res.status).toBe(200);
    const { pushSubscriptions } = await collections();
    expect(await pushSubscriptions.countDocuments({ userId: me.userId })).toBe(1);
    expect((await unsubscribe(me.cookie, sub.endpoint)).status).toBe(200);
    expect(await pushSubscriptions.countDocuments({ userId: me.userId })).toBe(0);
  });

  it("sends to subscribed browsers and removes expired ones", async () => {
    enablePush();
    const { seller, buyer, product } = await market();
    await subscribe(seller.cookie, subscription(1));
    const order = await place(buyer.cookie, product.id);
    await pay(buyer.cookie, order.id);
    await runNotificationJob();
    const { deliveries, pushSubscriptions } = await collections();
    expect(await deliveries.findOne({ recipientUserId: seller.userId, channel: "push" })).toMatchObject({ state: "sent" });
    expect(push.sent).toHaveLength(1);
    expect(JSON.parse(push.sent[0].payload)).toMatchObject({ title: `New paid order ${order.number}`, url: `/sales/${order.id}` });
    expect(push.sent[0].payload).not.toMatch(/Ring Road|08031234567/);
    expect((await pushSubscriptions.findOne({ userId: seller.userId }))!.lastSuccessAt).toBeInstanceOf(Date);
  });

  it.each([404, 410])("removes a subscription the push service answers %i for", async (status) => {
    enablePush();
    const me = await merchant();
    await subscribe(me.cookie, subscription());
    await createNotifications([
      {
        recipientUserId: me.userId,
        type: "payout_paid",
        title: "Payout paid",
        body: "Your payout was paid.",
        url: "/wallet/payouts",
        eventKey: `payout:${new ObjectId().toHexString()}:2:paid`,
        subject: { kind: "account" as const, id: "test" },
        eventAt: new Date(),
      },
    ]);
    push.failWith = status;
    await runNotificationJob();
    const { deliveries, pushSubscriptions } = await collections();
    expect(await deliveries.findOne({ recipientUserId: me.userId, channel: "push" })).toMatchObject({
      state: "skipped",
      lastFailure: "subscription_expired",
    });
    expect(await pushSubscriptions.countDocuments({ userId: me.userId })).toBe(0);
  });
});

describe("password changes", () => {
  it("tells the account owner once after a completed reset, and never mentions the token", async () => {
    const { input } = await registerVerified(newRegistration());
    const user = (await (await collections()).users.findOne({ phoneNormalized: input.phone }))!;
    await call(forgotRoute, "/api/auth/password/forgot", { body: { identifier: input.phone } });
    await flushAfter();
    const token = lastResetToken(input.phone);
    expect(await stored(user._id)).toEqual([]);

    const body = { token, password: "BrandNewPassw0rd" };
    expect((await call(resetRoute, "/api/auth/password/reset", { body })).status).toBe(200);
    expect((await call(resetRoute, "/api/auth/password/reset", { body })).status).toBeGreaterThanOrEqual(400);
    const notices = await stored(user._id);
    expect(notices.map((n) => [n.type, n.category])).toEqual([["password_changed", "security"]]);
    expect(JSON.stringify(notices)).not.toContain(token);
    expectNothingSensitiveLogged(token, "BrandNewPassw0rd");
  });

  it("isn't sent for a reset that never completes", async () => {
    const { input } = await registerVerified(newRegistration());
    const user = (await (await collections()).users.findOne({ phoneNormalized: input.phone }))!;
    await call(forgotRoute, "/api/auth/password/forgot", { body: { identifier: input.phone } });
    await flushAfter();
    expect((await call(resetRoute, "/api/auth/password/reset", { body: { token: "x".repeat(43), password: "BrandNewPassw0rd" } })).status).toBeGreaterThanOrEqual(400);
    expect(await stored(user._id)).toEqual([]);
    expect(errorOf(await inbox(""))).toBeTruthy();
  });
});
