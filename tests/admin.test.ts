import { randomUUID } from "node:crypto";
import { Collection, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import * as auditRouteModule from "@/app/api/admin/audit/route";
import { GET as auditRoute } from "@/app/api/admin/audit/route";
import * as credentialRouteModule from "@/app/api/admin/credentials/[userId]/route";
import { GET as credentialRoute, POST as decideRoute } from "@/app/api/admin/credentials/[userId]/route";
import { GET as credentialsRoute } from "@/app/api/admin/credentials/route";
import { GET as exceptionsRoute } from "@/app/api/admin/exceptions/route";
import * as issueRouteModule from "@/app/api/admin/issues/[number]/route";
import { GET as issueCaseRoute, POST as closeRoute } from "@/app/api/admin/issues/[number]/route";
import { GET as issuesRoute } from "@/app/api/admin/issues/route";
import * as moderateRouteModule from "@/app/api/admin/reviews/[id]/route";
import { POST as moderateRoute } from "@/app/api/admin/reviews/[id]/route";
import { GET as adminReviewsRoute } from "@/app/api/admin/reviews/route";
import { GET as summaryRoute } from "@/app/api/admin/summary/route";
import { POST as internalIssuesRoute } from "@/app/api/internal/orders/issues/route";
import { POST as checkoutRoute } from "@/app/api/orders/[id]/checkout/route";
import { POST as reportRoute } from "@/app/api/orders/[id]/issue/route";
import { GET as orderRoute } from "@/app/api/orders/[id]/route";
import { POST as verifyRoute } from "@/app/api/orders/[id]/verify-payment/route";
import { POST as placeRoute } from "@/app/api/orders/route";
import { GET as productReviewsRoute, POST as postReviewRoute } from "@/app/api/products/[id]/reviews/route";
import { POST as addProductRoute } from "@/app/api/products/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { GET as mineRoute } from "@/app/api/reviews/mine/route";
import { POST as fulfilRoute } from "@/app/api/sales/[id]/fulfillment/route";
import type {
  AdminSummary,
  AuditPage,
  CredentialCaseResponse,
  CredentialPage,
  ExceptionPage,
  IssueCaseResponse,
  IssuePage,
  ModerationPage,
  ModerationResponse,
} from "@/lib/admin/types";
import type { CheckoutResponse, OrderResponse, Product, ProductResponse, VerifyPaymentResponse } from "@/lib/orders/types";
import type { MyReviewsResponse, ProductReviewsResponse, ReviewResponse } from "@/lib/reviews/types";
import { parseAdminUserIds } from "@/lib/server/config";
import type { NotificationDeliveryDoc, PayoutDoc } from "@/lib/server/models";
import { collections } from "./support/db";
import { newRegistration, registerPending } from "./support/flows";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { flushAfter } from "./support/outbox";
import { completeCheckout } from "./support/paystack";
import { merchant, summaryOf } from "./support/wallet";

// The admin area: access comes only from ADMIN_USER_IDS on the server
// (stubbed per test; empty by default), every decision commits with its
// audit record, and nothing here touches payments, payouts or refunds.
// Orders and reviews are created through the real APIs against the fake
// Paystack; nothing calls a live provider.

const JOB_SECRET = "test-order-job-secret-at-least-32-chars!";
const EGGS = { name: "Fresh eggs", category: "eggs", unit: "crate", priceKobo: 4_500_00, stockQuantity: 100, description: "" };
const NOTE = "Deliver to 12 Ring Road, Ibadan. Call on arrival.";
const RESOLUTION = "Seller sent replacement eggs; buyer confirmed by phone.";
const REASON = "Contains a phone number and abusive language.";

type Account = Awaited<ReturnType<typeof merchant>>;
type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

function callWith<T, P>(handler: Handler<P>, path: string, params: P, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve(params) }), path, options);
}

const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

/** Makes these accounts (and only these) admins. */
const allow = (...accounts: Account[]) =>
  vi.stubEnv("ADMIN_USER_IDS", accounts.map((a) => a.userId.toHexString()).join(","));

async function admin() {
  const account = await merchant("poultry-farmer");
  allow(account);
  return account;
}

const auditCount = async () => (await collections()).adminAudit.countDocuments();

// --- orders ---------------------------------------------------------------------------

async function listProduct(cookie: string) {
  return dataOf(await call<ProductResponse>(addProductRoute, "/api/products", { body: EGGS, cookie })).product;
}

async function deliveredOrder(seller: Account, product: Product, customer?: Account) {
  const buyer = customer ?? (await merchant("veterinarian"));
  const placed = await call<OrderResponse>(placeRoute, "/api/orders", {
    body: {
      items: [{ productId: product.id, quantity: 2 }],
      fulfillmentMethod: "pickup",
      deliveryNote: NOTE,
      idempotencyKey: randomUUID(),
    },
    cookie: buyer.cookie,
  });
  expect(placed.status).toBe(201);
  const order = dataOf(placed).order;
  const { reference } = dataOf(
    await callWith<CheckoutResponse, { id: string }>(checkoutRoute, `/api/orders/${order.id}/checkout`, { id: order.id }, {
      cookie: buyer.cookie,
      body: {},
    }),
  );
  completeCheckout(reference);
  const verified = await callWith<VerifyPaymentResponse, { id: string }>(
    verifyRoute,
    `/api/orders/${order.id}/verify-payment`,
    { id: order.id },
    { cookie: buyer.cookie, body: { reference } },
  );
  expect(dataOf(verified).result).toBe("paid");
  for (const action of ["accept", "ship", "deliver"])
    expect(
      (await callWith(fulfilRoute, `/api/sales/${order.id}/fulfillment`, { id: order.id }, { cookie: seller.cookie, body: { action } }))
        .status,
    ).toBe(200);
  return { buyer, order };
}

/** A delivered order whose buyer reported a problem; the seller's earning is on hold. */
async function reportedIssue() {
  // no commission, so the whole 9,000 naira is the seller's earning
  vi.stubEnv("COMMISSION_POLICY_ID", "test-policy");
  vi.stubEnv("COMMISSION_RATE_BPS", "0");
  const seller = await merchant("poultry-farmer");
  const product = await listProduct(seller.cookie);
  const { buyer, order } = await deliveredOrder(seller, product);
  const res = await callWith<OrderResponse, { id: string }>(reportRoute, `/api/orders/${order.id}/issue`, { id: order.id }, {
    cookie: buyer.cookie,
    body: { note: "Half the eggs were broken on arrival." },
  });
  expect(res.status).toBe(200);
  // past the 24-hour window so the earning would otherwise be available
  const { orders, fulfillments } = await collections();
  const past = new Date(Date.now() - 30 * 60 * 60_000);
  await orders.updateOne({ number: order.number }, { $set: { deliveredAt: past } });
  await fulfillments.updateOne({ sourceType: "order", sourceId: order.number }, { $set: { deliveredAt: past } });
  return { seller, buyer, order };
}

const closeIssue = (cookie: string, number: string, body: unknown, options: CallOptions = {}) =>
  callWith<IssueCaseResponse, { number: string }>(closeRoute, `/api/admin/issues/${number}`, { number }, { cookie, body, ...options });

// --- credentials ----------------------------------------------------------------------

/** A veterinarian who submitted a registration number (pending review). */
async function submittedVet() {
  const vet = await merchant("veterinarian");
  const res = await call(patchProfile, "/api/profile", {
    body: { registrationNumber: "VCN/12345", specialization: "poultry-medicine", qualifications: "DVM, University of Ibadan" },
    cookie: vet.cookie,
    method: "PATCH",
  });
  expect(res.status).toBe(200);
  const user = await (await collections()).users.findOne({ _id: vet.userId });
  expect(user!.profile!.credentialStatus).toBe("pending");
  return { ...vet, submittedAt: user!.profile!.credentialSubmittedAt!.toISOString() };
}

const decide = (cookie: string, userId: ObjectId | string, body: unknown, options: CallOptions = {}) => {
  const id = typeof userId === "string" ? userId : userId.toHexString();
  return callWith<CredentialCaseResponse, { userId: string }>(decideRoute, `/api/admin/credentials/${id}`, { userId: id }, {
    cookie,
    body,
    ...options,
  });
};

// --- reviews --------------------------------------------------------------------------

async function publishedReview() {
  const seller = await merchant("poultry-farmer");
  const product = await listProduct(seller.cookie);
  const { buyer } = await deliveredOrder(seller, product);
  const res = await callWith<ReviewResponse, { id: string }>(postReviewRoute, `/api/products/${product.id}/reviews`, { id: product.id }, {
    cookie: buyer.cookie,
    body: { rating: 2, text: "Several eggs arrived cracked this time." },
  });
  expect(res.status).toBe(201);
  return { seller, product, buyer, review: dataOf(res).review };
}

const storedReview = async (id: string) => (await (await collections()).reviews.findOne({ _id: new ObjectId(id) }))!;
const storedProduct = async (id: string) => (await (await collections()).products.findOne({ _id: new ObjectId(id) }))!;

const moderate = (cookie: string, id: string, body: unknown, options: CallOptions = {}) =>
  callWith<ModerationResponse, { id: string }>(moderateRoute, `/api/admin/reviews/${id}`, { id }, { cookie, body, ...options });

// --------------------------------------------------------------------------------------

describe("the admin allowlist", () => {
  it("parses a comma-separated list of user ids", () => {
    const a = new ObjectId().toHexString();
    const b = new ObjectId().toHexString();
    expect(parseAdminUserIds(undefined)).toEqual({ ids: new Set(), error: null });
    expect(parseAdminUserIds("   ")).toEqual({ ids: new Set(), error: null });
    expect([...parseAdminUserIds(` ${a} , ${b.toUpperCase()} `).ids]).toEqual([a, b]);
  });

  it("grants nobody anything when any entry is malformed", () => {
    const a = new ObjectId().toHexString();
    for (const raw of [`${a},not-an-id`, `${a},`, `${a};${a}`, "admin", "true", `"${a}"`]) {
      const { ids, error } = parseAdminUserIds(raw);
      expect(ids.size).toBe(0);
      expect(error).toBeTruthy();
      expect(error).not.toContain(a);
    }
  });
});

describe("admin access", () => {
  const reads = [
    (cookie?: string) => call(summaryRoute, "/api/admin/summary", { cookie }),
    (cookie?: string) => call(credentialsRoute, "/api/admin/credentials", { cookie }),
    (cookie?: string) => call(issuesRoute, "/api/admin/issues", { cookie }),
    (cookie?: string) => call(adminReviewsRoute, "/api/admin/reviews", { cookie }),
    (cookie?: string) => call(exceptionsRoute, "/api/admin/exceptions?kind=payouts", { cookie }),
    (cookie?: string) => call(auditRoute, "/api/admin/audit", { cookie }),
  ];

  async function expectNoAccess(cookie: string | undefined, status: number) {
    for (const read of reads) {
      const res = await read(cookie);
      expect(res.status).toBe(status);
      expect(res.json.ok).toBe(false);
    }
  }

  it("is closed to everyone while no admins are configured", async () => {
    const user = await merchant("poultry-farmer");
    await expectNoAccess(user.cookie, 404);
    await expectNoAccess(undefined, 401);
  });

  it("is open to a configured admin with a full, verified session", async () => {
    const boss = await admin();
    for (const read of reads) expect((await read(boss.cookie)).status).toBe(200);
  });

  it("refuses ordinary users without revealing who the admins are", async () => {
    const boss = await admin();
    const user = await merchant("veterinarian");
    for (const read of reads) {
      const res = await read(user.cookie);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.json)).not.toContain(boss.userId.toHexString());
    }
  });

  it("ignores forged roles, flags and ids from the browser", async () => {
    const boss = await admin();
    const user = await merchant("veterinarian");
    const forged = `/api/admin/summary?admin=1&role=admin&userId=${boss.userId.toHexString()}`;
    expect((await call(summaryRoute, forged, { cookie: user.cookie })).status).toBe(404);
    const vet = await submittedVet();
    const res = await decide(user.cookie, vet.userId, {
      decision: "approve",
      submittedAt: vet.submittedAt,
      isAdmin: true,
      role: "admin",
      actorUserId: boss.userId.toHexString(),
    });
    expect(res.status).toBe(404);
    // a made-up cookie value (e.g. the admin's id) is not a session
    expect((await call(summaryRoute, "/api/admin/summary", { cookie: boss.userId.toHexString() })).status).toBe(401);
    expect((await (await collections()).users.findOne({ _id: vet.userId }))!.profile!.credentialStatus).toBe("pending");
    expect(await auditCount()).toBe(0);
  });

  it("refuses an allowlisted account whose session is pending or whose phone isn't verified", async () => {
    const input = newRegistration();
    const { pendingCookie } = await registerPending(input);
    const pendingUser = await (await collections()).users.findOne({ phoneNormalized: input.phone });
    vi.stubEnv("ADMIN_USER_IDS", pendingUser!._id.toHexString());
    await expectNoAccess(pendingCookie, 404);

    const boss = await admin();
    await (await collections()).users.updateOne({ _id: boss.userId }, { $set: { phoneVerifiedAt: null } });
    await expectNoAccess(boss.cookie, 404);
  });

  it("refuses an allowlisted account that is no longer active", async () => {
    const boss = await admin();
    await (await collections()).users.updateOne({ _id: boss.userId }, { $set: { status: "pending_verification" } });
    for (const read of reads) expect([401, 404]).toContain((await read(boss.cookie)).status);
  });

  it("is disabled entirely by a malformed allowlist", async () => {
    const boss = await merchant("poultry-farmer");
    vi.stubEnv("ADMIN_USER_IDS", `${boss.userId.toHexString()},oops`);
    await expectNoAccess(boss.cookie, 404);
  });

  it("requires a same-origin request for every action", async () => {
    const boss = await admin();
    const vet = await submittedVet();
    const body = { decision: "approve", submittedAt: vet.submittedAt };
    expect((await decide(boss.cookie, vet.userId, body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await decide(boss.cookie, vet.userId, body, { origin: null })).status).toBe(403);
    const { review } = await publishedReview();
    allow(boss);
    expect((await moderate(boss.cookie, review.id, { action: "remove", reason: REASON, updatedAt: review.updatedAt }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await auditCount()).toBe(0);
  });

  it("offers no way to edit or delete records", () => {
    for (const mod of [auditRouteModule, credentialRouteModule, issueRouteModule, moderateRouteModule]) {
      expect(mod).not.toHaveProperty("PATCH");
      expect(mod).not.toHaveProperty("PUT");
      expect(mod).not.toHaveProperty("DELETE");
    }
    expect(auditRouteModule).not.toHaveProperty("POST");
  });
});

describe("credential review", () => {
  it("lists pending submissions and approves one, with an audit record and an in-app notice", async () => {
    const boss = await admin();
    const vet = await submittedVet();
    const list = dataOf(await call<CredentialPage>(credentialsRoute, "/api/admin/credentials", { cookie: boss.cookie }));
    expect(list.cases).toHaveLength(1);
    expect(list.cases[0]).toMatchObject({ userId: vet.userId.toHexString(), registrationNumber: "VCN/12345", status: "pending" });
    expect(Object.keys(list.cases[0])).not.toContain("email");
    expect(JSON.stringify(list)).not.toContain("passwordHash");

    const res = await decide(boss.cookie, vet.userId, { decision: "approve", submittedAt: vet.submittedAt });
    expect(res.status).toBe(200);
    expect(dataOf(res).case.status).toBe("verified");
    expect(dataOf(res).history).toHaveLength(1);
    expect(dataOf(res).history[0]).toMatchObject({
      action: "credential.approve",
      actorUserId: boss.userId.toHexString(),
      from: "pending",
      to: "verified",
    });

    const audit = await (await collections()).adminAudit.find().toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "credential.approve", target: { type: "user", id: vet.userId.toHexString() } });
    expect(audit[0].actorUserId!.equals(boss.userId)).toBe(true);

    await flushAfter();
    const notice = await (await collections()).notifications.findOne({ recipientUserId: vet.userId, type: "credential_verified" });
    expect(notice).toBeTruthy();
    expect(notice!.body).not.toMatch(/licen[cs]e register|verified with/i);

    // a repeat is refused and not audited twice
    const again = await decide(boss.cookie, vet.userId, { decision: "reject", reason: REASON, submittedAt: vet.submittedAt });
    expect(again.status).toBe(409);
    expect(await auditCount()).toBe(1);
  });

  it("requires a reason to reject and keeps it internal", async () => {
    const boss = await admin();
    const vet = await submittedVet();
    for (const reason of [undefined, "", "   ", "no", "x".repeat(501)]) {
      const res = await decide(boss.cookie, vet.userId, { decision: "reject", submittedAt: vet.submittedAt, ...(reason === undefined ? {} : { reason }) });
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("reason");
    }
    const reason = "Registration number not found on the certificate provided.";
    const res = await decide(boss.cookie, vet.userId, { decision: "reject", reason, submittedAt: vet.submittedAt });
    expect(dataOf(res).case.status).toBe("rejected");
    expect((await (await collections()).adminAudit.findOne())!.reason).toBe(reason);
    await flushAfter();
    const notices = await (await collections()).notifications.find({ recipientUserId: vet.userId }).toArray();
    expect(notices.map((n) => n.type)).toContain("credential_rejected");
    expect(JSON.stringify(notices)).not.toContain(reason);
  });

  it("refuses unsubmitted, stale, unknown, non-professional and own credentials", async () => {
    const boss = await admin();
    const fresh = await merchant("veterinarian");
    expect(errorOf(await decide(boss.cookie, fresh.userId, { decision: "approve", submittedAt: new Date().toISOString() }))).toMatch(
      /nothing has been submitted/i,
    );

    const vet = await submittedVet();
    const stale = await decide(boss.cookie, vet.userId, { decision: "approve", submittedAt: new Date(0).toISOString() });
    expect(stale.status).toBe(409);
    expect((await (await collections()).users.findOne({ _id: vet.userId }))!.profile!.credentialStatus).toBe("pending");

    const farmer = await merchant("poultry-farmer");
    expect((await decide(boss.cookie, farmer.userId, { decision: "approve", submittedAt: vet.submittedAt })).status).toBe(404);
    expect((await decide(boss.cookie, new ObjectId(), { decision: "approve", submittedAt: vet.submittedAt })).status).toBe(404);
    expect((await decide(boss.cookie, "not-an-id", { decision: "approve", submittedAt: vet.submittedAt })).status).toBe(404);
    expect((await decide(boss.cookie, vet.userId, { decision: "maybe", submittedAt: vet.submittedAt })).status).toBe(400);
    expect((await decide(boss.cookie, vet.userId, { decision: "approve" })).status).toBe(400);

    const selfVet = await submittedVet();
    allow(selfVet);
    expect((await decide(selfVet.cookie, selfVet.userId, { decision: "approve", submittedAt: selfVet.submittedAt })).status).toBe(403);
    expect(await auditCount()).toBe(0);
  });

  it("lets only one of two concurrent decisions through", async () => {
    const first = await merchant("poultry-farmer");
    const second = await merchant("poultry-farmer");
    allow(first, second);
    const vet = await submittedVet();
    const results = await Promise.all([
      decide(first.cookie, vet.userId, { decision: "approve", submittedAt: vet.submittedAt }),
      decide(second.cookie, vet.userId, { decision: "reject", reason: REASON, submittedAt: vet.submittedAt }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await auditCount()).toBe(1);
    const winner = results.find((r) => r.status === 200)!;
    expect((await (await collections()).users.findOne({ _id: vet.userId }))!.profile!.credentialStatus).toBe(dataOf(winner).case.status);
  });

  it("can be read with its history; unknown ids are a 404", async () => {
    const boss = await admin();
    const vet = await submittedVet();
    const id = vet.userId.toHexString();
    const res = await callWith<CredentialCaseResponse, { userId: string }>(credentialRoute, `/api/admin/credentials/${id}`, { userId: id }, { cookie: boss.cookie });
    expect(dataOf(res).case.qualifications).toBe("DVM, University of Ibadan");
    expect(dataOf(res).history).toEqual([]);
    const missing = new ObjectId().toHexString();
    expect((await callWith(credentialRoute, `/api/admin/credentials/${missing}`, { userId: missing }, { cookie: boss.cookie })).status).toBe(404);
  });
});

describe("closing order issues", () => {
  it("closes an open issue through the ledger, records the note and audits it, without refunding", async () => {
    const boss = await admin();
    const { seller, buyer, order } = await reportedIssue();
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 0, underReviewKobo: 9_000_00 });

    const queue = dataOf(await call<IssuePage>(issuesRoute, "/api/admin/issues", { cookie: boss.cookie }));
    expect(queue.cases).toHaveLength(1);
    expect(queue.cases[0]).toMatchObject({ orderNumber: order.number, open: true, earningHeld: true, refundedKobo: 0 });

    const { orders, refunds, orderPayments, notifications } = await collections();
    const refundsBefore = await refunds.countDocuments();
    const paymentsBefore = await orderPayments.countDocuments();
    const paymentStatus = (await orders.findOne({ number: order.number }))!.paymentStatus;

    const res = await closeIssue(boss.cookie, order.number, { note: RESOLUTION, confirmed: true });
    expect(res.status).toBe(200);
    expect(dataOf(res).case).toMatchObject({ open: false, resolutionNote: RESOLUTION, earningHeld: false });
    expect(dataOf(res).history[0]).toMatchObject({ action: "order_issue.close", reason: RESOLUTION, from: "open", to: "closed" });

    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 9_000_00, underReviewKobo: 0 });
    const stored = (await orders.findOne({ number: order.number }))!;
    expect(stored.issue!.resolution).toMatchObject({ note: RESOLUTION });
    expect(stored.issue!.resolution!.byUserId.equals(boss.userId)).toBe(true);
    expect(stored.paymentStatus).toBe(paymentStatus);
    expect(stored.refundedKobo).toBe(0);
    expect(await refunds.countDocuments()).toBe(refundsBefore);
    expect(await orderPayments.countDocuments()).toBe(paymentsBefore);
    expect(stored.history.at(-1)).toMatchObject({ event: "issue_closed" });

    await flushAfter();
    const notices = await notifications.find({ type: { $in: ["issue_resolved", "sale_issue_resolved"] } }).toArray();
    expect(notices).toHaveLength(2);
    expect(JSON.stringify(notices)).not.toContain(RESOLUTION);

    // the buyer's view of the order never shows the internal note
    const view = await callWith(orderRoute, `/api/orders/${order.id}`, { id: order.id }, { cookie: buyer.cookie });
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.json)).not.toContain(RESOLUTION);

    // a second close is refused
    expect((await closeIssue(boss.cookie, order.number, { note: RESOLUTION, confirmed: true })).status).toBe(409);
    expect(await auditCount()).toBe(1);
  });

  it("requires a resolution note and the explicit confirmation", async () => {
    const boss = await admin();
    const { order } = await reportedIssue();
    for (const body of [
      { note: RESOLUTION },
      { note: RESOLUTION, confirmed: "true" },
      { note: "", confirmed: true },
      { note: "ok", confirmed: true },
      { confirmed: true },
      { note: RESOLUTION, confirmed: true, refund: true },
    ]) {
      const res = await closeIssue(boss.cookie, order.number, body);
      expect(res.status).toBe(400);
    }
    expect((await (await collections()).orders.findOne({ number: order.number }))!.issue!.closedAt).toBeNull();
    expect(await auditCount()).toBe(0);
  });

  it("refuses orders without an issue, unknown numbers, and the admin's own orders", async () => {
    const boss = await admin();
    expect((await closeIssue(boss.cookie, "FKO-ZZZZZZZZ", { note: RESOLUTION, confirmed: true })).status).toBe(404);
    expect((await closeIssue(boss.cookie, "nonsense", { note: RESOLUTION, confirmed: true })).status).toBe(404);

    const { order, seller } = await reportedIssue();
    allow(seller);
    expect((await closeIssue(seller.cookie, order.number, { note: RESOLUTION, confirmed: true })).status).toBe(403);
    expect(await auditCount()).toBe(0);
  });

  it("doesn't close anything if the audit record can't be written", async () => {
    const boss = await admin();
    const { seller, order } = await reportedIssue();
    const original = Collection.prototype.insertOne;
    const spy = vi.spyOn(Collection.prototype, "insertOne").mockImplementation(function (this: Collection, ...args) {
      if (this.collectionName === "admin_audit") return Promise.reject(new Error("audit write failed"));
      return (original as (...a: unknown[]) => ReturnType<Collection["insertOne"]>).apply(this, args);
    });
    const res = await closeIssue(boss.cookie, order.number, { note: RESOLUTION, confirmed: true });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toContain("audit write failed");
    const stored = (await (await collections()).orders.findOne({ number: order.number }))!;
    expect(stored.issue!.closedAt).toBeNull();
    expect(stored.issue!.resolution).toBeUndefined();
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 0, underReviewKobo: 9_000_00 });

    // and it can be closed once the audit trail is writable again
    expect((await closeIssue(boss.cookie, order.number, { note: RESOLUTION, confirmed: true })).status).toBe(200);
    expect(await auditCount()).toBe(1);
  });

  it("releases the earning once when two admins close at the same time", async () => {
    const first = await merchant("veterinarian");
    const second = await merchant("veterinarian");
    allow(first, second);
    const { seller, order } = await reportedIssue();
    const results = await Promise.all([
      closeIssue(first.cookie, order.number, { note: RESOLUTION, confirmed: true }),
      closeIssue(second.cookie, order.number, { note: `${RESOLUTION} (second)`, confirmed: true }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await auditCount()).toBe(1);
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 9_000_00, underReviewKobo: 0 });
  });

  it("keeps the internal support endpoint working, audited as the job", async () => {
    const { seller, order } = await reportedIssue();
    const request = (authorization: string | null) => {
      const headers = new Headers({ "content-type": "application/json" });
      if (authorization) headers.set("authorization", authorization);
      return internalIssuesRoute(
        new Request("http://localhost:3000/api/internal/orders/issues", {
          method: "POST",
          headers,
          body: JSON.stringify({ orderNumber: order.number }),
        }),
      );
    };
    expect((await request(null)).status).toBe(401);
    expect((await request(`Bearer ${JOB_SECRET}`)).status).toBe(200);
    expect(await summaryOf(seller.userId)).toMatchObject({ availableKobo: 9_000_00 });
    const audit = await (await collections()).adminAudit.find().toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "order_issue.close", actorUserId: null, target: { type: "order", id: order.number } });
    expect((await request(`Bearer ${JOB_SECRET}`)).status).toBe(404);
  });

  it("shows a case with its history; closed issues move to the closed list", async () => {
    const boss = await admin();
    const { order } = await reportedIssue();
    await closeIssue(boss.cookie, order.number, { note: RESOLUTION, confirmed: true });
    const res = await callWith<IssueCaseResponse, { number: string }>(issueCaseRoute, `/api/admin/issues/${order.number}`, { number: order.number }, { cookie: boss.cookie });
    expect(dataOf(res).case.open).toBe(false);
    expect(dataOf(res).history).toHaveLength(1);
    expect(dataOf(await call<IssuePage>(issuesRoute, "/api/admin/issues", { cookie: boss.cookie })).cases).toHaveLength(0);
    expect(dataOf(await call<IssuePage>(issuesRoute, "/api/admin/issues?state=closed", { cookie: boss.cookie })).cases).toHaveLength(1);
    expect((await call(issuesRoute, "/api/admin/issues?state=everything", { cookie: boss.cookie })).status).toBe(400);
  });
});

describe("review moderation", () => {
  const readPublic = (cookie: string, productId: string) =>
    callWith<ProductReviewsResponse, { id: string }>(productReviewsRoute, `/api/products/${productId}/reviews`, { id: productId }, { cookie });

  it("removes and restores a published review, keeping its rating and text and updating the product", async () => {
    const boss = await admin();
    const { product, buyer, review } = await publishedReview();
    expect(await storedProduct(product.id)).toMatchObject({ ratingCount: 1, ratingAverage: 2 });

    const noReason = await moderate(boss.cookie, review.id, { action: "remove", updatedAt: review.updatedAt });
    expect(noReason.status).toBe(400);
    expect(fieldErrorsOf(noReason)).toHaveProperty("reason");

    const removed = await moderate(boss.cookie, review.id, { action: "remove", reason: REASON, updatedAt: review.updatedAt });
    expect(removed.status).toBe(200);
    expect(dataOf(removed).review.status).toBe("rejected");
    expect(await storedProduct(product.id)).toMatchObject({ ratingCount: 0, ratingAverage: null });
    const stored = await storedReview(review.id);
    expect(stored).toMatchObject({ rating: 2, text: "Several eggs arrived cracked this time.", status: "rejected" });
    expect(dataOf(await readPublic(buyer.cookie, product.id)).reviews).toHaveLength(0);

    // the author sees the status, but never the internal reason
    await flushAfter();
    const mine = dataOf(await call<MyReviewsResponse>(mineRoute, "/api/reviews/mine", { cookie: buyer.cookie }));
    expect(mine.reviews[0].status).toBe("rejected");
    expect(JSON.stringify(mine)).not.toContain(REASON);
    const notices = await (await collections()).notifications.find({ recipientUserId: buyer.userId, type: "review_removed" }).toArray();
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain(REASON);

    const restored = await moderate(boss.cookie, review.id, {
      action: "restore",
      reason: "Re-checked: the number was a delivery reference.",
      updatedAt: stored.updatedAt.toISOString(),
    });
    expect(restored.status).toBe(200);
    expect(await storedProduct(product.id)).toMatchObject({ ratingCount: 1, ratingAverage: 2 });
    const pub = dataOf(await readPublic(buyer.cookie, product.id));
    expect(pub.reviews).toHaveLength(1);
    expect(JSON.stringify(pub)).not.toMatch(/moderation|Re-checked|reason/);

    const audit = await (await collections()).adminAudit.find().sort({ at: 1, _id: 1 }).toArray();
    expect(audit.map((a) => a.action)).toEqual(["review.remove", "review.restore"]);
    expect(audit[0]).toMatchObject({ from: "published", to: "rejected", reason: REASON });
    expect(await (await collections()).reviews.countDocuments()).toBe(1);
  });

  it("publishes or rejects a pending review and refuses moves that don't fit its status", async () => {
    const boss = await admin();
    const { product, review } = await publishedReview();
    const { reviews } = await collections();
    const pendingAt = new Date();
    await reviews.updateOne({ _id: new ObjectId(review.id) }, { $set: { status: "pending", updatedAt: pendingAt } });
    const at = pendingAt.toISOString();

    for (const action of ["remove", "restore"])
      expect((await moderate(boss.cookie, review.id, { action, reason: REASON, updatedAt: at })).status).toBe(409);
    expect((await moderate(boss.cookie, review.id, { action: "delete", updatedAt: at })).status).toBe(400);
    expect((await moderate(boss.cookie, review.id, { action: "publish", updatedAt: at, rating: 5 })).status).toBe(400);
    expect((await moderate(boss.cookie, review.id, { action: "reject", updatedAt: at })).status).toBe(400);

    const list = dataOf(await call<ModerationPage>(adminReviewsRoute, "/api/admin/reviews", { cookie: boss.cookie }));
    expect(list.cases.map((c) => c.id)).toEqual([review.id]);

    const published = await moderate(boss.cookie, review.id, { action: "publish", updatedAt: at });
    expect(dataOf(published).review.status).toBe("published");
    expect(await storedProduct(product.id)).toMatchObject({ ratingCount: 1 });
    await flushAfter();
    expect(await (await collections()).notifications.countDocuments({ type: "review_approved" })).toBe(1);
  });

  it("refuses stale versions, withdrawn reviews and reviews of the admin's own products", async () => {
    const boss = await admin();
    const { seller, review } = await publishedReview();
    allow(boss);
    expect((await moderate(boss.cookie, review.id, { action: "remove", reason: REASON, updatedAt: new Date(0).toISOString() })).status).toBe(409);
    expect((await moderate(boss.cookie, new ObjectId().toHexString(), { action: "remove", reason: REASON, updatedAt: review.updatedAt })).status).toBe(404);

    allow(boss, seller);
    expect((await moderate(seller.cookie, review.id, { action: "remove", reason: REASON, updatedAt: review.updatedAt })).status).toBe(403);

    await (await collections()).reviews.updateOne({ _id: new ObjectId(review.id) }, { $set: { status: "withdrawn" } });
    const withdrawn = await storedReview(review.id);
    for (const action of ["remove", "restore", "publish", "reject"])
      expect((await moderate(boss.cookie, review.id, { action, reason: REASON, updatedAt: withdrawn.updatedAt.toISOString() })).status).toBe(409);
    expect((await storedReview(review.id)).status).toBe("withdrawn");
    expect(await auditCount()).toBe(0);
  });

  it("lets only one of two concurrent moves through", async () => {
    const first = await merchant("veterinarian");
    const second = await merchant("veterinarian");
    allow(first, second);
    const { product, review } = await publishedReview();
    const results = await Promise.all([
      moderate(first.cookie, review.id, { action: "remove", reason: REASON, updatedAt: review.updatedAt }),
      moderate(second.cookie, review.id, { action: "remove", reason: REASON, updatedAt: review.updatedAt }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await auditCount()).toBe(1);
    expect(await storedProduct(product.id)).toMatchObject({ ratingCount: 0 });
  });
});

describe("audit trail and exceptions", () => {
  it("pages and filters the audit trail, and rejects unknown filters", async () => {
    const boss = await admin();
    const other = await merchant("veterinarian");
    allow(boss, other);
    for (let i = 0; i < 3; i += 1) {
      const vet = await submittedVet();
      dataOf(await decide(i === 0 ? other.cookie : boss.cookie, vet.userId, { decision: "approve", submittedAt: vet.submittedAt }));
    }
    const { review } = await publishedReview();
    dataOf(await moderate(boss.cookie, review.id, { action: "remove", reason: REASON, updatedAt: review.updatedAt }));

    const all = dataOf(await call<AuditPage>(auditRoute, "/api/admin/audit", { cookie: boss.cookie }));
    expect(all.entries).toHaveLength(4);
    expect(all.entries[0].action).toBe("review.remove");
    const byAction = dataOf(await call<AuditPage>(auditRoute, "/api/admin/audit?action=credential.approve", { cookie: boss.cookie }));
    expect(byAction.entries).toHaveLength(3);
    const byActor = dataOf(await call<AuditPage>(auditRoute, `/api/admin/audit?actor=${other.userId.toHexString()}`, { cookie: boss.cookie }));
    expect(byActor.entries).toHaveLength(1);
    const byTarget = dataOf(
      await call<AuditPage>(auditRoute, `/api/admin/audit?targetType=review&targetId=${review.id}`, { cookie: boss.cookie }),
    );
    expect(byTarget.entries.map((e) => e.action)).toEqual(["review.remove"]);
    expect(JSON.stringify(all)).not.toMatch(/passwordHash|phoneNormalized|emailNormalized/);

    for (const query of ["action=delete", "targetType=payout", "actor=me", "targetId=%24where", "page=0"])
      expect((await call(auditRoute, `/api/admin/audit?${query}`, { cookie: boss.cookie })).status).toBe(400);

    // pagination: 20 per page
    const { adminAudit } = await collections();
    await adminAudit.insertMany(
      Array.from({ length: 20 }, (_, i) => ({
        _id: new ObjectId(),
        actorUserId: boss.userId,
        action: "review.publish" as const,
        target: { type: "review" as const, id: new ObjectId().toHexString() },
        reason: null,
        from: "pending",
        to: "published",
        at: new Date(Date.now() - (i + 1) * 60_000),
      })),
    );
    const page1 = dataOf(await call<AuditPage>(auditRoute, "/api/admin/audit", { cookie: boss.cookie }));
    const page2 = dataOf(await call<AuditPage>(auditRoute, "/api/admin/audit?page=2", { cookie: boss.cookie }));
    expect(page1.entries).toHaveLength(20);
    expect(page1.hasMore).toBe(true);
    expect(page2.entries).toHaveLength(4);
    expect(page2.hasMore).toBe(false);
  });

  it("lists flagged payouts with only the last four digits and no provider secrets", async () => {
    const boss = await admin();
    const now = new Date();
    const payout = {
      _id: new ObjectId(),
      userId: new ObjectId(),
      idempotencyKey: randomUUID(),
      amountKobo: 25_000_00,
      currency: "NGN",
      status: "failed",
      payoutAccountId: new ObjectId(),
      recipientCode: "RCP_supersecretrecipient",
      bankName: "Zenith Bank",
      accountNumberLast4: "6789",
      reference: "fkp_test_reference",
      transferCode: "TRF_secrettransfer",
      providerStatus: "reversed-raw-provider-status",
      failureReason: "provider_reversed",
      issue: "Paystack reported success after the payout had failed.",
      transferInitiatedAt: now,
      lastCheckedAt: now,
      requestedAt: now,
      processingAt: now,
      paidAt: null,
      failedAt: now,
      history: [],
      createdAt: now,
      updatedAt: now,
    } as unknown as PayoutDoc;
    await (await collections()).payouts.insertOne(payout);

    const res = await call<ExceptionPage>(exceptionsRoute, "/api/admin/exceptions?kind=payouts", { cookie: boss.cookie });
    const page = dataOf(res);
    expect(page.kind).toBe("payouts");
    expect(page.items).toEqual([
      {
        reference: "fkp_test_reference",
        issue: "Paystack reported success after the payout had failed.",
        status: "failed",
        amountKobo: 25_000_00,
        bankName: "Zenith Bank",
        accountNumberLast4: "6789",
        failureReason: "provider_reversed",
        updatedAt: now.toISOString(),
      },
    ]);
    const text = JSON.stringify(res.json);
    for (const secret of ["RCP_supersecretrecipient", "TRF_secrettransfer", "reversed-raw-provider-status", payout.userId.toHexString()])
      expect(text).not.toContain(secret);

    expect(dataOf(await call<AdminSummary>(summaryRoute, "/api/admin/summary", { cookie: boss.cookie }))).toMatchObject({
      flaggedPayouts: 1,
    });
    expect((await call(exceptionsRoute, "/api/admin/exceptions?kind=ledger", { cookie: boss.cookie })).status).toBe(400);
  });

  it("lists flagged orders and failed deliveries with safe fields only, and counts them", async () => {
    const boss = await admin();
    const { order } = await reportedIssue();
    const { orders, deliveries, notifications } = await collections();
    await orders.updateOne({ number: order.number }, { $set: { reviewIssue: "payment fko_x doesn't match the order", updatedAt: new Date() } });
    const notification = await notifications.findOne({});
    const now = new Date();
    const delivery: NotificationDeliveryDoc = {
      _id: new ObjectId(),
      notificationId: notification!._id,
      recipientUserId: notification!.recipientUserId,
      channel: "sms",
      state: "exhausted",
      attempts: 5,
      nextAttemptAt: null,
      claimToken: null,
      claimedAt: null,
      providerMessageId: "provider-message-secret",
      lastFailure: "http_503",
      sentAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await deliveries.insertOne(delivery);

    const flagged = dataOf(await call<ExceptionPage>(exceptionsRoute, "/api/admin/exceptions?kind=orders", { cookie: boss.cookie }));
    expect(flagged.items).toHaveLength(1);
    expect(flagged.items[0]).toMatchObject({ orderNumber: order.number, issue: "payment fko_x doesn't match the order" });
    expect(JSON.stringify(flagged)).not.toContain(NOTE);

    const failed = await call<ExceptionPage>(exceptionsRoute, "/api/admin/exceptions?kind=deliveries", { cookie: boss.cookie });
    expect(dataOf(failed).items).toEqual([
      {
        id: delivery._id.toHexString(),
        channel: "sms",
        state: "exhausted",
        attempts: 5,
        lastFailure: "http_503",
        notificationType: notification!.type,
        updatedAt: now.toISOString(),
      },
    ]);
    expect(JSON.stringify(failed.json)).not.toContain("provider-message-secret");

    const summary = dataOf(await call<AdminSummary>(summaryRoute, "/api/admin/summary", { cookie: boss.cookie }));
    expect(summary).toMatchObject({ openIssues: 1, flaggedOrders: 1, failedDeliveries: 1, pendingCredentials: 0, reviewsToModerate: 0 });
  });

  it("can't be changed through the database helpers either: there is no update or delete", async () => {
    const auditModule = await import("@/lib/server/admin-audit");
    const names = Object.keys(auditModule);
    expect(names.filter((n) => /update|delete|remove|edit/i.test(n))).toEqual([]);
  });
});

describe("registration", () => {
  it("never grants admin access: a new account is an ordinary user", async () => {
    await admin();
    const fresh = await merchant("veterinarian");
    expect((await call(summaryRoute, "/api/admin/summary", { cookie: fresh.cookie })).status).toBe(404);
    const stored = await (await collections()).users.findOne({ _id: fresh.userId });
    expect(JSON.stringify(stored)).not.toMatch(/admin/i);
  });
});
