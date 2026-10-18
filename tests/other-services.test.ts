import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as processRoute } from "@/app/api/internal/orders/process/route";
import { GET as directoryItemRoute } from "@/app/api/service-directory/[id]/route";
import { GET as directoryRoute } from "@/app/api/service-directory/route";
import { POST as checkoutRoute } from "@/app/api/service-bookings/[id]/checkout/route";
import { GET as bookingRoute, PATCH as transitionRoute } from "@/app/api/service-bookings/[id]/route";
import { POST as verifyRoute } from "@/app/api/service-bookings/[id]/verify-payment/route";
import { GET as listRoute, POST as bookRoute } from "@/app/api/service-bookings/route";
import { PATCH as patchServiceRoute } from "@/app/api/services/[id]/route";
import { POST as createServiceRoute } from "@/app/api/services/route";
import { POST as webhookRoute } from "@/app/api/webhooks/paystack/route";
import type { Role } from "@/lib/auth/types";
import { getWalletSummary } from "@/lib/server/ledger";
import { bookingCollections } from "@/lib/server/service-booking-store";
import type {
  MarketplaceServiceDetails,
  ServiceBooking,
  ServiceBookingListResponse,
  ServiceBookingResponse,
  ServiceCheckoutResponse,
  ServiceDirectoryPage,
  ServiceVerifyResponse,
} from "@/lib/services/marketplace";
import type { ServiceResponse } from "@/lib/services/types";
import { collections, userByPhone } from "./support/db";
import { newRegistration, registerPending, registerVerified } from "./support/flows";
import { call, dataOf, ORIGIN, type CallOptions, type CallResult } from "./support/http";
import { flushAfter } from "./support/outbox";
import { completeCheckout, paystack, signedChargeEvent } from "./support/paystack";

// Other Services against the real route handlers and an in-memory replica
// set. The clock is fixed (Date only, so the database driver keeps real
// timers) at Monday 4 Nov 2030, 08:00 in Lagos; bookings are for Wednesday
// 6 Nov. Paystack is the in-process fake: no live provider is called.

const MONDAY_8AM = new Date("2030-11-04T07:00:00.000Z");
/** Wednesday 6 Nov 2030, 08:00 in Lagos: the booked day */
const WEDNESDAY_8AM = new Date("2030-11-06T07:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const JOB_SECRET = "test-order-job-secret-at-least-32-chars!";

const FUMIGATION = {
  name: "Layer house fumigation",
  category: "farm-fumigation",
  description: "Full fumigation of poultry houses against mites, flies and beetles.",
  priceNgn: 45000,
  durationMinutes: 180,
  pricing: "fixed",
  serviceStates: ["oyo", "lagos"],
  included: "Chemicals and sprayers",
  requirements: "Birds moved out of the house",
};
const HAULAGE = {
  name: "Live bird haulage",
  category: "transportation",
  description: "Ventilated trucks for moving live birds between farms and markets.",
  durationMinutes: 240,
  pricing: "quote",
  serviceStates: ["oyo"],
};
const FUMIGATION_DETAILS = { premisesType: "poultry-house", areaSqm: 400, pestProblem: "Red mites in layer cages" };
const HAULAGE_DETAILS = {
  cargo: "live-birds",
  quantity: "300 birds",
  dropoffAddress: "Bodija market, Ibadan",
  dropoffState: "oyo",
};
const LOCATION = {
  address: "Km 5 Ife Road, Ibadan",
  state: "oyo",
  directions: "Second gate after the filling station.",
};

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

function callWith<T, P>(handler: Handler<P>, path: string, params: P, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve(params) }), path, options);
}
const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(MONDAY_8AM);
});
afterEach(() => {
  vi.useRealTimers();
});

// --- helpers ---------------------------------------------------------------------

async function account(role: Role = "poultry-farmer") {
  const { input, cookie } = await registerVerified(newRegistration({ role }));
  const user = await userByPhone(input.phone);
  return { cookie, userId: user!._id, phone: user!.phoneNormalized };
}

async function addService(cookie: string, body: object = FUMIGATION) {
  const res = await call<ServiceResponse>(createServiceRoute, "/api/services", { body, cookie });
  expect(res.status).toBe(201);
  return dataOf(res).service;
}

/** A specialist offering fixed-price fumigation, and a farmer customer. */
async function fixedSetup() {
  const provider = await account("non-vet-specialist");
  const service = await addService(provider.cookie);
  const customer = await account();
  return { provider, service, customer };
}

/** A farmer offering quote-priced haulage, and another farmer as customer. */
async function quoteSetup() {
  const provider = await account();
  const service = await addService(provider.cookie, HAULAGE);
  const customer = await account();
  return { provider, service, customer };
}

const search = (cookie: string, query = "") =>
  call<ServiceDirectoryPage>(directoryRoute, `/api/service-directory${query ? `?${query}` : ""}`, { cookie });

const bookingBody = (serviceId: string, overrides: object = {}) => ({
  serviceId,
  date: "2030-11-06",
  window: "morning",
  location: LOCATION,
  contactPreference: "call",
  notes: "Call when you reach the junction.",
  details: FUMIGATION_DETAILS,
  idempotencyKey: randomUUID(),
  ...overrides,
});

const book = (cookie: string, body: object) =>
  call<ServiceBookingResponse>(bookRoute, "/api/service-bookings", { body, cookie });

async function booked(cookie: string, body: object) {
  const res = await book(cookie, body);
  expect(res.status).toBe(201);
  return dataOf(res).booking;
}

const read = (cookie: string, id: string) =>
  callWith<ServiceBookingResponse, { id: string }>(bookingRoute, `/api/service-bookings/${id}`, { id }, { cookie });

const act = (cookie: string, id: string, body: object) =>
  callWith<ServiceBookingResponse, { id: string }>(
    transitionRoute,
    `/api/service-bookings/${id}`,
    { id },
    {
      cookie,
      body,
      method: "PATCH",
    },
  );

async function acted(cookie: string, booking: Pick<ServiceBooking, "id" | "status">, action: string, extra = {}) {
  const res = await act(cookie, booking.id, { action, expectedStatus: booking.status, ...extra });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return dataOf(res).booking;
}

const checkout = (cookie: string, id: string) =>
  callWith<ServiceCheckoutResponse, { id: string }>(
    checkoutRoute,
    `/api/service-bookings/${id}/checkout`,
    { id },
    {
      cookie,
      method: "POST",
    },
  );

const verify = (cookie: string, id: string, reference?: string) =>
  callWith<ServiceVerifyResponse, { id: string }>(
    verifyRoute,
    `/api/service-bookings/${id}/verify-payment`,
    { id },
    {
      cookie,
      body: reference ? { reference } : {},
    },
  );

/** Opens checkout, has the customer finish it on the fake Paystack page, then comes back. */
async function pay(cookie: string, id: string, status = "success", overrides = {}) {
  const started = await checkout(cookie, id);
  expect(started.status, JSON.stringify(started.json)).toBe(200);
  const { reference } = dataOf(started);
  completeCheckout(reference, status, overrides);
  const verified = await verify(cookie, id, reference);
  expect(verified.status).toBe(200);
  return { reference, ...dataOf(verified) };
}

/** A paid fixed-price booking the provider accepted. */
async function confirmedFixed() {
  const s = await fixedSetup();
  const created = await booked(s.customer.cookie, bookingBody(s.service.id));
  const { booking: paid, reference } = await pay(s.customer.cookie, created.id);
  expect(paid.status).toBe("requested");
  const providerView = dataOf(await read(s.provider.cookie, created.id)).booking;
  const confirmed = await acted(s.provider.cookie, providerView, "accept");
  return { ...s, booking: confirmed, reference };
}

const stored = async (id: string) => (await (await bookingCollections()).bookings.findOne({ _id: new ObjectId(id) }))!;
const attemptsFor = async (id: string) =>
  (await bookingCollections()).payments
    .find({ bookingId: new ObjectId(id) })
    .sort({ createdAt: 1 })
    .toArray();
const refundsFor = async (id: string) =>
  (await bookingCollections()).refunds.find({ bookingId: new ObjectId(id) }).toArray();
const entriesFor = async (reference: string) =>
  (await collections()).ledger
    .find({ "source.type": "service_booking", "source.id": reference })
    .sort({ sequence: 1 })
    .toArray();
const notificationsFor = async (userId: ObjectId) => {
  await flushAfter();
  return (await collections()).notifications.find({ recipientUserId: userId }).sort({ _id: 1 }).toArray();
};

function webhook(raw: string, signature: string) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-real-ip": "52.31.139.75",
    "x-paystack-signature": signature,
  });
  return webhookRoute(new Request(`${ORIGIN}/api/webhooks/paystack`, { method: "POST", headers, body: raw }));
}

function runJob() {
  const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${JOB_SECRET}` });
  return processRoute(
    new Request(`${ORIGIN}/api/internal/orders/process`, { method: "POST", headers, body: JSON.stringify({}) }),
  );
}

const setCommission = (bps: number, id = "test-policy") => {
  vi.stubEnv("COMMISSION_POLICY_ID", id);
  vi.stubEnv("COMMISSION_RATE_BPS", String(bps));
};

// --- who may offer what --------------------------------------------------------------

describe("marketplace categories and roles", () => {
  it("lets each role list only the categories its policy allows", async () => {
    const farmer = await account();
    const vet = await account("veterinarian");
    const specialist = await account("non-vet-specialist");

    // farmers: transportation and logistics only
    expect((await call(createServiceRoute, "/api/services", { body: HAULAGE, cookie: farmer.cookie })).status).toBe(
      201,
    );
    const farmerFumigation = await call(createServiceRoute, "/api/services", {
      body: FUMIGATION,
      cookie: farmer.cookie,
    });
    expect(farmerFumigation.status).toBe(400);
    expect(fieldErrorsOf(farmerFumigation).category).toBeTruthy();

    // vets: none of the marketplace categories
    for (const body of [FUMIGATION, HAULAGE]) {
      const res = await call(createServiceRoute, "/api/services", { body, cookie: vet.cookie });
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res).category).toBeTruthy();
    }

    // specialists: all seven
    const categories = [
      "farm-fumigation",
      "recruitment",
      "transportation",
      "logistics",
      "sales-connection",
      "installation",
      "maintenance",
    ];
    for (const category of categories) {
      const res = await call(createServiceRoute, "/api/services", {
        body: { ...HAULAGE, name: `Specialist ${category}`, category },
        cookie: specialist.cookie,
      });
      expect(res.status, category).toBe(201);
    }
  });

  it("requires pricing and at least one state for marketplace services, and a price unless quoted", async () => {
    const specialist = await account("non-vet-specialist");
    const noStates = await call(createServiceRoute, "/api/services", {
      body: { ...FUMIGATION, serviceStates: [] },
      cookie: specialist.cookie,
    });
    expect(noStates.status).toBe(400);
    expect(fieldErrorsOf(noStates).serviceStates).toBeTruthy();
    const noPrice = await call(createServiceRoute, "/api/services", {
      body: { ...FUMIGATION, priceNgn: 0 },
      cookie: specialist.cookie,
    });
    expect(noPrice.status).toBe(400);
    expect(fieldErrorsOf(noPrice).priceNgn).toBeTruthy();
  });
});

// --- the directory -------------------------------------------------------------------

describe("the service directory", () => {
  it("is for verified accounts only", async () => {
    expect((await call(directoryRoute, "/api/service-directory")).status).toBe(401);
    const { pendingCookie } = await registerPending(newRegistration());
    expect((await search(pendingCookie)).status).toBe(403);
  });

  it("lists bookable marketplace services with real provider details only", async () => {
    const { provider, service } = await fixedSetup();
    const viewer = await account();
    const page = dataOf(await search(viewer.cookie));
    expect(page.nextCursor).toBeNull();
    expect(page.services).toHaveLength(1);
    const card = page.services[0];
    expect(card).toMatchObject({
      id: service.id,
      name: FUMIGATION.name,
      category: "farm-fumigation",
      categoryLabel: "Farm Fumigation",
      pricing: "fixed",
      priceNgn: 45000,
      serviceStates: ["oyo", "lagos"],
      provider: { id: provider.userId.toHexString(), credentialsVerified: false },
    });
    // nothing the platform doesn't record
    expect(Object.keys(card).sort()).toEqual(
      [
        "category",
        "categoryLabel",
        "description",
        "durationMinutes",
        "id",
        "name",
        "priceNgn",
        "pricing",
        "provider",
        "serviceStates",
      ].sort(),
    );
    expect(Object.keys(card.provider).sort()).toEqual(
      ["credentialsVerified", "id", "name", "photoUrl", "roleLabel"].sort(),
    );
    expect(JSON.stringify(page)).not.toContain(provider.phone);
  });

  it("leaves out paused, unbookable, non-marketplace, removed and inactive-owner services", async () => {
    const specialist = await account("non-vet-specialist");
    const visible = await addService(specialist.cookie);
    const paused = await addService(specialist.cookie, { ...FUMIGATION, name: "Paused fumigation", active: false });
    const closed = await addService(specialist.cookie, {
      ...FUMIGATION,
      name: "Closed fumigation",
      bookingAvailable: false,
    });
    const vet = await account("veterinarian");
    await addService(vet.cookie, {
      name: "Farm visit & flock check",
      category: "consultation",
      description: "On-site visit to examine your flock and advise on treatment.",
      priceNgn: 15000,
      durationMinutes: 60,
    });
    const other = await account("non-vet-specialist");
    const ownerGone = await addService(other.cookie, { ...FUMIGATION, name: "Owner not active" });
    await (await collections()).users.updateOne({ _id: other.userId }, { $set: { status: "pending_verification" } });

    const viewer = await account();
    const ids = dataOf(await search(viewer.cookie)).services.map((s) => s.id);
    expect(ids).toEqual([visible.id]);
    for (const hidden of [paused, closed, ownerGone]) {
      const res = await callWith(
        directoryItemRoute,
        `/api/service-directory/${hidden.id}`,
        { id: hidden.id },
        {
          cookie: viewer.cookie,
        },
      );
      expect(res.status).toBe(404);
    }

    // a service that's turned off disappears straight away
    const off = await callWith(
      patchServiceRoute,
      `/api/services/${visible.id}`,
      { id: visible.id },
      {
        cookie: specialist.cookie,
        body: { bookingAvailable: false },
        method: "PATCH",
      },
    );
    expect(off.status).toBe(200);
    expect(dataOf(await search(viewer.cookie)).services).toEqual([]);
  });

  it("filters by search words, category, state, pricing and maximum price", async () => {
    const specialist = await account("non-vet-specialist");
    const fumigation = await addService(specialist.cookie);
    const cheap = await addService(specialist.cookie, {
      ...FUMIGATION,
      name: "Feed store spraying",
      description: "Spraying of feed stores against weevils and rodents.",
      priceNgn: 12000,
      serviceStates: ["kano"],
    });
    const farmer = await account();
    const haulage = await addService(farmer.cookie, HAULAGE);
    const viewer = await account();
    const ids = async (query: string) => {
      const res = await search(viewer.cookie, query);
      expect(res.status, query).toBe(200);
      return dataOf(res)
        .services.map((s) => s.id)
        .sort();
    };
    expect(await ids("q=layer")).toEqual([fumigation.id]);
    // the category's name is searchable too
    expect(await ids("q=fumig")).toEqual([fumigation.id, cheap.id].sort());
    expect(await ids("q=weevils+feed")).toEqual([cheap.id]);
    expect(await ids("q=nothing+like+this")).toEqual([]);
    expect(await ids("category=transportation")).toEqual([haulage.id]);
    expect(await ids("state=kano")).toEqual([cheap.id]);
    expect(await ids("state=oyo")).toEqual([fumigation.id, haulage.id].sort());
    expect(await ids("pricing=quote")).toEqual([haulage.id]);
    expect(await ids("pricing=fixed")).toEqual([fumigation.id, cheap.id].sort());
    expect(await ids("maxPrice=20000")).toEqual([cheap.id]);
    expect(await ids("category=farm-fumigation&state=lagos&maxPrice=50000")).toEqual([fumigation.id]);
  });

  it("refuses unknown filters and page sizes over the cap", async () => {
    const viewer = await account();
    for (const query of ["category=plumbing", "state=atlantis", "pricing=free", "maxPrice=-5", "limit=25", "limit=0"]) {
      const res = await search(viewer.cookie, query);
      expect(res.status, query).toBe(400);
      expect(errorOf(res)).toBe("Please check the search filters.");
    }
    expect((await search(viewer.cookie, "limit=24")).status).toBe(200);
  });

  it("pages with a signed cursor, without duplicates, and only for the filters it was made for", async () => {
    const specialist = await account("non-vet-specialist");
    const made: string[] = [];
    for (let i = 0; i < 7; i++)
      made.push((await addService(specialist.cookie, { ...FUMIGATION, name: `Fumigation ${i}` })).id);
    const viewer = await account();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `category=farm-fumigation&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await search(viewer.cookie, query);
      expect(res.status).toBe(200);
      const page = dataOf(res);
      seen.push(...page.services.map((s) => s.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...made].reverse()); // newest first

    const first = dataOf(await search(viewer.cookie, "category=farm-fumigation&limit=3")).nextCursor!;
    // another search's filters
    const moved = await search(viewer.cookie, `category=farm-fumigation&state=lagos&limit=3&cursor=${first}`);
    expect(moved.status).toBe(400);
    expect(errorOf(moved)).toBe("This list has changed. Start the search again.");
    // tampered
    const [payload, signature] = first.split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, t: Date.now() + HOUR, i: new ObjectId().toHexString() }),
    ).toString("base64url");
    for (const bad of [
      `${forged}.${signature}`,
      `${payload}.${"0".repeat(32)}`,
      "garbage",
      `${payload}.${signature}.x`,
    ]) {
      const res = await search(viewer.cookie, `category=farm-fumigation&limit=3&cursor=${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(400);
    }
  });

  it("shows a service's details, and says when it's your own", async () => {
    const { provider, service } = await fixedSetup();
    const viewer = await account();
    const theirs = await callWith<{ service: MarketplaceServiceDetails }, { id: string }>(
      directoryItemRoute,
      `/api/service-directory/${service.id}`,
      { id: service.id },
      { cookie: viewer.cookie },
    );
    expect(theirs.status).toBe(200);
    expect(dataOf(theirs).service).toMatchObject({
      id: service.id,
      included: FUMIGATION.included,
      requirements: FUMIGATION.requirements,
      excluded: "",
      canBook: true,
    });
    const own = await callWith<{ service: MarketplaceServiceDetails }, { id: string }>(
      directoryItemRoute,
      `/api/service-directory/${service.id}`,
      { id: service.id },
      { cookie: provider.cookie },
    );
    expect(dataOf(own).service.canBook).toBe(false);
    for (const id of ["not-an-id", new ObjectId().toHexString()]) {
      const res = await callWith(directoryItemRoute, `/api/service-directory/${id}`, { id }, { cookie: viewer.cookie });
      expect(res.status).toBe(404);
    }
  });
});

// --- booking -------------------------------------------------------------------------

describe("booking a service", () => {
  it("refuses anonymous, unverified and cross-site requests", async () => {
    const { service, customer } = await fixedSetup();
    expect((await call(bookRoute, "/api/service-bookings", { body: bookingBody(service.id) })).status).toBe(401);
    const { pendingCookie } = await registerPending(newRegistration());
    expect((await book(pendingCookie, bookingBody(service.id))).status).toBe(403);
    const crossSite = await call(bookRoute, "/api/service-bookings", {
      body: bookingBody(service.id),
      cookie: customer.cookie,
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    expect(await (await bookingCollections()).bookings.countDocuments()).toBe(0);
  });

  it("checks the date, location, contact preference and the category's own fields", async () => {
    const { service, customer } = await fixedSetup();
    const today = await book(customer.cookie, bookingBody(service.id, { date: "2030-11-04" }));
    expect(today.status).toBe(400);
    expect(fieldErrorsOf(today).date).toBeTruthy();
    const tooFar = await book(customer.cookie, bookingBody(service.id, { date: "2031-03-01" }));
    expect(fieldErrorsOf(tooFar).date).toBeTruthy();
    const bad = await book(customer.cookie, {
      ...bookingBody(service.id),
      window: "midnight",
      location: { address: "x", state: "nowhere" },
      contactPreference: "pigeon",
      idempotencyKey: "nope",
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(bad)).sort()).toEqual(
      ["contactPreference", "idempotencyKey", "location.address", "location.state", "window"].sort(),
    );
    const uncovered = await book(
      customer.cookie,
      bookingBody(service.id, { location: { ...LOCATION, state: "kano" } }),
    );
    expect(uncovered.status).toBe(400);
    expect(fieldErrorsOf(uncovered)["location.state"]).toBe("This provider doesn't cover that state.");
    const details = await book(
      customer.cookie,
      bookingBody(service.id, { details: { premisesType: "spaceship", areaSqm: 0 } }),
    );
    expect(details.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(details)).sort()).toEqual(
      ["details.areaSqm", "details.pestProblem", "details.premisesType"].sort(),
    );
    expect(await (await bookingCollections()).bookings.countDocuments()).toBe(0);
  });

  it("snapshots the service, sets the price itself and ignores anything else the browser sends", async () => {
    const { provider, service, customer } = await fixedSetup();
    const other = await account();
    const created = await booked(customer.cookie, {
      ...bookingBody(service.id),
      amountKobo: 100,
      priceNgn: 1,
      fee: 0,
      status: "confirmed",
      paymentStatus: "paid",
      providerUserId: other.userId.toHexString(),
      customerUserId: other.userId.toHexString(),
      details: { ...FUMIGATION_DETAILS, extra: "ignored" },
    });
    expect(created).toMatchObject({
      reference: expect.stringMatching(/^FK-SVC-[2-9A-HJ-NP-Z]{8}$/),
      viewer: "customer",
      status: "awaiting_payment",
      paymentStatus: "pending",
      amountKobo: 45000_00,
      paidKobo: 0,
      quote: null,
      canPay: true,
      actions: ["cancel"],
      provider: { id: provider.userId.toHexString(), phone: null },
      schedule: { date: "2030-11-06", window: "morning" },
      location: LOCATION,
    });
    const payWithin = Date.parse(created.payBy!) - MONDAY_8AM.getTime();
    expect(payWithin).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(payWithin).toBeLessThan(31 * MINUTE);
    expect(created.details.map((d) => d.label)).not.toContain("extra");
    const doc = await stored(created.id);
    expect(doc.customerUserId.equals(customer.userId)).toBe(true);
    expect(doc.providerUserId.equals(provider.userId)).toBe(true);
    expect(doc.details).toEqual(FUMIGATION_DETAILS);

    // later changes to the service don't change the booking
    await callWith(
      patchServiceRoute,
      `/api/services/${service.id}`,
      { id: service.id },
      {
        cookie: provider.cookie,
        body: { name: "Renamed fumigation", priceNgn: 90000 },
        method: "PATCH",
      },
    );
    const again = dataOf(await read(customer.cookie, created.id)).booking;
    expect(again.service.name).toBe(FUMIGATION.name);
    expect(again.amountKobo).toBe(45000_00);
  });

  it("is idempotent, and allows one open booking per service and day", async () => {
    const { service, customer } = await fixedSetup();
    const body = bookingBody(service.id);
    const first = await book(customer.cookie, body);
    expect(first.status).toBe(201);
    const repeat = await book(customer.cookie, body);
    expect(repeat.status).toBe(200);
    expect(dataOf(repeat).booking.id).toBe(dataOf(first).booking.id);
    const changed = await book(customer.cookie, { ...body, date: "2030-11-07" });
    expect(changed.status).toBe(409);

    const sameDay = await book(customer.cookie, bookingBody(service.id));
    expect(sameDay.status).toBe(409);
    expect(errorOf(sameDay)).toBe("You already have an open booking for this service on that day.");
    expect((await book(customer.cookie, bookingBody(service.id, { date: "2030-11-07" }))).status).toBe(201);

    // concurrent submissions of the same request make one booking
    const key = randomUUID();
    const results = await Promise.all(
      [0, 1, 2].map(() => book(customer.cookie, bookingBody(service.id, { date: "2030-11-08", idempotencyKey: key }))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => dataOf(r).booking.id)).size).toBe(1);
  });

  it("refuses your own service, unknown services and more than five open bookings", async () => {
    const { provider, service, customer } = await fixedSetup();
    const own = await book(provider.cookie, bookingBody(service.id));
    expect(own.status).toBe(403);
    const unknown = await book(customer.cookie, bookingBody(new ObjectId().toHexString()));
    expect(unknown.status).toBe(404);

    for (const date of ["2030-11-06", "2030-11-07", "2030-11-08", "2030-11-09", "2030-11-10"])
      await booked(customer.cookie, bookingBody(service.id, { date }));
    const sixth = await book(customer.cookie, bookingBody(service.id, { date: "2030-11-11" }));
    expect(sixth.status).toBe(409);
  });

  it("keeps bookings private to their customer and provider", async () => {
    const { provider, service, customer } = await fixedSetup();
    const created = await booked(customer.cookie, bookingBody(service.id));
    const stranger = await account();
    expect((await read(stranger.cookie, created.id)).status).toBe(404);
    expect((await read(stranger.cookie, "not-an-id")).status).toBe(404);
    expect(
      (await act(stranger.cookie, created.id, { action: "cancel", expectedStatus: "awaiting_payment" })).status,
    ).toBe(404);
    expect((await checkout(stranger.cookie, created.id)).status).toBe(404);
    expect((await checkout(provider.cookie, created.id)).status).toBe(404);
    expect((await verify(stranger.cookie, created.id)).status).toBe(404);
    expect((await read(provider.cookie, created.id)).status).toBe(200);

    const mine = dataOf(
      await call<ServiceBookingListResponse>(listRoute, "/api/service-bookings", { cookie: customer.cookie }),
    );
    expect(mine.bookings.map((b) => b.id)).toEqual([created.id]);
    const jobs = dataOf(
      await call<ServiceBookingListResponse>(listRoute, "/api/service-bookings?as=provider", {
        cookie: provider.cookie,
      }),
    );
    expect(jobs.bookings.map((b) => b.id)).toEqual([created.id]);
    const theirs = dataOf(
      await call<ServiceBookingListResponse>(listRoute, "/api/service-bookings?as=provider", {
        cookie: stranger.cookie,
      }),
    );
    expect(theirs.bookings).toEqual([]);
  });
});

// --- the fixed-price flow --------------------------------------------------------------

describe("a fixed-price booking", () => {
  it("goes from payment to the provider, on the way, started and completed, notifying each side", async () => {
    const { provider, service, customer } = await fixedSetup();
    const created = await booked(customer.cookie, bookingBody(service.id));
    // the provider has nothing to do until it's paid
    expect(dataOf(await read(provider.cookie, created.id)).booking.actions).toEqual([]);
    expect(await notificationsFor(provider.userId)).toEqual([]);

    const started = dataOf(await checkout(customer.cookie, created.id));
    expect(started.reference).toMatch(/^fsp_[0-9a-f]{24}$/);
    const sent = paystack.transactions.get(started.reference)!;
    expect(sent.amount).toBe(45000_00);
    expect(sent.currency).toBe("NGN");

    // coming back before paying proves nothing
    const early = dataOf(await verify(customer.cookie, created.id, started.reference));
    expect(early.result).toBe("pending");
    expect(early.booking.status).toBe("awaiting_payment");

    completeCheckout(started.reference);
    const paid = dataOf(await verify(customer.cookie, created.id, started.reference));
    expect(paid.result).toBe("paid");
    expect(paid.booking).toMatchObject({
      status: "requested",
      paymentStatus: "paid",
      paidKobo: 45000_00,
      canPay: false,
    });
    expect(paid.booking.respondBy).toBeTruthy();
    // verifying again changes nothing
    expect(dataOf(await verify(customer.cookie, created.id, started.reference)).result).toBe("paid");
    expect((await checkout(customer.cookie, created.id)).status).toBe(409);

    const asProvider = dataOf(await read(provider.cookie, created.id)).booking;
    expect(asProvider.actions).toEqual(["accept", "decline"]);
    expect(asProvider.customer.phone).toBeNull();
    const confirmed = await acted(provider.cookie, asProvider, "accept");
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.customer.phone).toBe(customer.phone);
    expect(confirmed.actions).toEqual(["cancel"]); // not the booked day yet
    expect((await act(provider.cookie, created.id, { action: "start", expectedStatus: "confirmed" })).status).toBe(409);
    const customerView = dataOf(await read(customer.cookie, created.id)).booking;
    expect(customerView.provider.phone).toBe(provider.phone);
    expect(customerView.cancelUntil).toBe("2030-11-05");

    vi.setSystemTime(WEDNESDAY_8AM);
    const onTheWay = await acted(provider.cookie, confirmed, "en_route");
    expect(onTheWay.status).toBe("provider_en_route");
    const working = await acted(provider.cookie, onTheWay, "start");
    expect(working.status).toBe("in_progress");
    const done = await acted(provider.cookie, working, "complete");
    expect(done).toMatchObject({ status: "completed", paymentStatus: "paid", actions: [] });
    expect(done.customer.phone).toBeNull(); // no longer shared once the job is closed
    expect(done.history.map((h) => [h.event, h.by])).toEqual([
      ["awaiting_payment", "customer"],
      ["paid", "system"],
      ["requested", "system"],
      ["confirmed", "provider"],
      ["provider_en_route", "provider"],
      ["in_progress", "provider"],
      ["completed", "provider"],
    ]);
    // every timestamp is the server's own
    for (const item of done.history) expect(Number.isNaN(Date.parse(item.at))).toBe(false);

    expect((await notificationsFor(customer.userId)).map((n) => n.type)).toEqual([
      "service_booking_paid",
      "service_booking_confirmed",
      "service_booking_en_route",
      "service_booking_started",
      "service_booking_completed",
    ]);
    const providerNotes = await notificationsFor(provider.userId);
    expect(providerNotes.map((n) => n.type)).toEqual(["service_booking_requested"]);
    expect(providerNotes[0].url).toBe(`/services/jobs/${created.id}`);
    // never the address or phone numbers
    const text = JSON.stringify(await (await collections()).notifications.find().toArray());
    expect(text).not.toContain(LOCATION.address);
    expect(text).not.toContain(customer.phone);
  });

  it("rejects stale and repeated changes", async () => {
    const { provider, booking } = await confirmedFixed();
    const stale = await act(provider.cookie, booking.id, { action: "accept", expectedStatus: "requested" });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toBe("This booking has changed. Reload to see its latest status.");
    const invalid = await act(provider.cookie, booking.id, { action: "fly", expectedStatus: "confirmed" });
    expect(invalid.status).toBe(400);

    // two concurrent accepts of the same request: one wins
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    await pay(s.customer.cookie, created.id);
    const results = await Promise.all(
      [0, 1].map(() => act(s.provider.cookie, created.id, { action: "accept", expectedStatus: "requested" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await stored(created.id)).history.filter((h) => h.event === "confirmed")).toHaveLength(1);
  });

  it("only lets the customer act as customer and the provider as provider", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    await pay(s.customer.cookie, created.id);
    const selfAccept = await act(s.customer.cookie, created.id, { action: "accept", expectedStatus: "requested" });
    expect(selfAccept.status).toBe(409);
    expect((await stored(created.id)).status).toBe("requested");
  });

  it("refunds a paid booking in full when the provider declines it, once", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const { reference } = await pay(s.customer.cookie, created.id);
    const declined = await acted(s.provider.cookie, { id: created.id, status: "requested" }, "decline", {
      reason: "Fully booked that week",
    });
    expect(declined).toMatchObject({ status: "declined", paymentStatus: "refunded", refundedKobo: 45000_00 });
    const refunds = await refundsFor(created.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: "processed", amountKobo: 45000_00, paymentReference: reference });
    expect(paystack.requests.filter((r) => r.operation === "refund")).toHaveLength(1);

    // repeating the decline, the job and the webhook changes nothing
    expect((await act(s.provider.cookie, created.id, { action: "decline", expectedStatus: "requested" })).status).toBe(
      409,
    );
    expect((await runJob()).status).toBe(200);
    const { raw, signature } = signedChargeEvent(paystack.transactions.get(reference)!);
    expect((await webhook(raw, signature)).status).toBe(200);
    expect(await refundsFor(created.id)).toHaveLength(1);
    expect(paystack.requests.filter((r) => r.operation === "refund")).toHaveLength(1);
    expect((await notificationsFor(s.customer.userId)).map((n) => n.type)).toContain(
      "service_booking_refund_processed",
    );
  });

  it("lets the customer cancel a confirmed booking for a refund until the day before, but not on the day", async () => {
    const early = await confirmedFixed();
    const cancelled = await acted(early.customer.cookie, early.booking, "cancel", { reason: "Changed plans" });
    expect(cancelled).toMatchObject({ status: "cancelled", paymentStatus: "refunded", refundedKobo: 45000_00 });
    expect((await notificationsFor(early.provider.userId)).map((n) => n.type)).toContain("service_booking_cancelled");

    const late = await confirmedFixed();
    vi.setSystemTime(WEDNESDAY_8AM);
    const view = dataOf(await read(late.customer.cookie, late.booking.id)).booking;
    expect(view.actions).toEqual([]);
    const refused = await act(late.customer.cookie, late.booking.id, { action: "cancel", expectedStatus: "confirmed" });
    expect(refused.status).toBe(409);
    expect((await stored(late.booking.id)).status).toBe("confirmed");
  });

  it("lapses when it isn't paid in time, closing the payment attempt", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const { reference } = dataOf(await checkout(s.customer.cookie, created.id));
    vi.setSystemTime(MONDAY_8AM.getTime() + 31 * MINUTE);
    const res = await runJob();
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { serviceBookings: { expired: number } } }).data.serviceBookings.expired,
    ).toBe(1);
    const after = dataOf(await read(s.customer.cookie, created.id)).booking;
    expect(after).toMatchObject({ status: "expired", paymentStatus: "none", canPay: false, actions: [] });
    expect((await attemptsFor(created.id)).map((a) => [a.reference, a.status, a.active])).toEqual([
      [reference, "closed", false],
    ]);
    // and the day is free again
    expect((await book(s.customer.cookie, bookingBody(s.service.id))).status).toBe(201);
  });

  it("lapses on the next read too, without waiting for the job", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    vi.setSystemTime(MONDAY_8AM.getTime() + 31 * MINUTE);
    expect(dataOf(await read(s.customer.cookie, created.id)).booking.status).toBe("expired");
    expect((await checkout(s.customer.cookie, created.id)).status).toBe(409);
  });

  it("lapses a paid request the provider never answered, with a full refund", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    await pay(s.customer.cookie, created.id);
    vi.setSystemTime(new Date("2030-11-05T23:30:00.000Z")); // Wednesday 00:30 in Lagos
    const after = dataOf(await read(s.provider.cookie, created.id)).booking;
    expect(after).toMatchObject({ status: "expired", paymentStatus: "refunded", refundedKobo: 45000_00 });
    const both = [...(await notificationsFor(s.customer.userId)), ...(await notificationsFor(s.provider.userId))];
    expect(both.filter((n) => n.type === "service_booking_expired")).toHaveLength(2);
  });

  it("lets the customer cancel while unpaid, settling the payment attempt first", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const { reference } = dataOf(await checkout(s.customer.cookie, created.id));
    // paid on Paystack, but the customer cancels before coming back
    completeCheckout(reference);
    const cancel = await act(s.customer.cookie, created.id, { action: "cancel", expectedStatus: "awaiting_payment" });
    expect(cancel.status).toBe(409);
    expect(errorOf(cancel)).toBe("This booking was just paid. Reload to see its latest status.");
    expect((await stored(created.id)).status).toBe("requested");

    // while Paystack can't be reached nothing changes
    const t = await fixedSetup();
    const other = await booked(t.customer.cookie, bookingBody(t.service.id));
    await checkout(t.customer.cookie, other.id);
    paystack.behaviour.transaction = "server-error";
    const unknown = await act(t.customer.cookie, other.id, { action: "cancel", expectedStatus: "awaiting_payment" });
    expect(unknown.status).toBe(503);
    expect((await stored(other.id)).status).toBe("awaiting_payment");
    paystack.behaviour.transaction = "ok";
    const done = await acted(t.customer.cookie, { id: other.id, status: "awaiting_payment" }, "cancel");
    expect(done).toMatchObject({ status: "cancelled", paymentStatus: "none" });
  });
});

// --- the quote flow ------------------------------------------------------------------------

describe("a quote request", () => {
  it("is priced by the provider, accepted and paid by the customer, which confirms it", async () => {
    const { provider, service, customer } = await quoteSetup();
    const created = await booked(customer.cookie, bookingBody(service.id, { details: HAULAGE_DETAILS }));
    expect(created).toMatchObject({
      status: "requested",
      paymentStatus: "none",
      amountKobo: null,
      canPay: false,
      actions: ["cancel"],
    });
    expect((await checkout(customer.cookie, created.id)).status).toBe(409);
    expect((await notificationsFor(provider.userId)).map((n) => n.type)).toEqual(["service_booking_requested"]);

    const asProvider = dataOf(await read(provider.cookie, created.id)).booking;
    expect(asProvider.actions).toEqual(["quote", "decline"]);
    const badQuote = await act(provider.cookie, created.id, {
      action: "quote",
      expectedStatus: "requested",
      quote: { amountNgn: 0, validDays: 9 },
    });
    expect(badQuote.status).toBe(400);
    expect(Object.keys(fieldErrorsOf(badQuote)).sort()).toEqual(["quote.amountNgn", "quote.validDays"]);

    const quoted = await acted(provider.cookie, asProvider, "quote", {
      quote: { amountNgn: 60000, note: "Includes two trucks", validDays: 3 },
    });
    expect(quoted.status).toBe("quote_offered");
    expect(quoted.quote).toMatchObject({ amountKobo: 60000_00, note: "Includes two trucks" });
    // valid for three days, but not past the start of the booked day
    expect(quoted.quote!.validUntil).toBe("2030-11-05T23:00:00.000Z");

    const customerView = dataOf(await read(customer.cookie, created.id)).booking;
    expect(customerView.actions).toEqual(["accept_quote", "reject_quote"]);
    const accepted = await acted(customer.cookie, customerView, "accept_quote");
    expect(accepted).toMatchObject({
      status: "awaiting_payment",
      paymentStatus: "pending",
      amountKobo: 60000_00,
      canPay: true,
    });
    expect((await notificationsFor(provider.userId)).map((n) => n.type)).toContain("service_booking_quote_accepted");

    const { reference, booking: paid } = await pay(customer.cookie, created.id);
    expect(paystack.transactions.get(reference)!.amount).toBe(60000_00);
    expect(paid).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidKobo: 60000_00 });
    const providerNotes = (await notificationsFor(provider.userId)).map((n) => n.type);
    expect(providerNotes.filter((t) => t === "service_booking_confirmed")).toHaveLength(1);
  });

  it("can be rejected by the customer or withdrawn by the provider", async () => {
    const { provider, service, customer } = await quoteSetup();
    const first = await booked(customer.cookie, bookingBody(service.id, { details: HAULAGE_DETAILS }));
    const quoted = await acted(provider.cookie, first, "quote", { quote: { amountNgn: 50000 } });
    const rejected = await acted(customer.cookie, quoted, "reject_quote", { reason: "Too expensive" });
    expect(rejected).toMatchObject({ status: "cancelled", paymentStatus: "none" });
    expect(rejected.history.at(-1)).toMatchObject({ event: "cancelled", by: "customer", note: "Too expensive" });

    const second = await booked(
      customer.cookie,
      bookingBody(service.id, { details: HAULAGE_DETAILS, date: "2030-11-07" }),
    );
    const quotedAgain = await acted(provider.cookie, second, "quote", { quote: { amountNgn: 50000 } });
    const withdrawn = await acted(provider.cookie, quotedAgain, "decline");
    expect(withdrawn.status).toBe("declined");
  });

  it("lapses once the quote runs out", async () => {
    const { provider, service, customer } = await quoteSetup();
    const created = await booked(
      customer.cookie,
      bookingBody(service.id, { details: HAULAGE_DETAILS, date: "2030-11-20" }),
    );
    await acted(provider.cookie, created, "quote", { quote: { amountNgn: 50000, validDays: 1 } });
    vi.setSystemTime(MONDAY_8AM.getTime() + 25 * HOUR);
    const refused = await act(customer.cookie, created.id, { action: "accept_quote", expectedStatus: "quote_offered" });
    expect(refused.status).toBe(409);
    expect((await stored(created.id)).status).toBe("expired");
  });
});

// --- payments ----------------------------------------------------------------------------

describe("paying for a booking", () => {
  it("never marks a tampered payment paid: wrong amount, currency or booking is held for review", async () => {
    for (const overrides of [
      { amount: 100_00 },
      { currency: "USD" },
      { metadata: { order_id: new ObjectId().toHexString() } },
    ]) {
      const s = await fixedSetup();
      const created = await booked(s.customer.cookie, bookingBody(s.service.id));
      const verified = await pay(s.customer.cookie, created.id, "success", overrides);
      expect(verified.result).toBe("pending");
      expect(verified.booking).toMatchObject({ status: "awaiting_payment", paymentStatus: "pending", paidKobo: 0 });
      const doc = await stored(created.id);
      expect(doc.reviewIssue).toContain("doesn't match");
      expect(await entriesFor(doc.reference)).toEqual([]);
    }
  });

  it("ignores a reference that isn't one of the booking's own attempts", async () => {
    const a = await fixedSetup();
    const b = await fixedSetup();
    const bookingA = await booked(a.customer.cookie, bookingBody(a.service.id));
    const bookingB = await booked(b.customer.cookie, bookingBody(b.service.id));
    const { reference: paidB } = await pay(b.customer.cookie, bookingB.id);
    const res = dataOf(await verify(a.customer.cookie, bookingA.id, paidB));
    expect(res.result).toBe("pending");
    expect(res.booking.paymentStatus).toBe("pending");
  });

  it("records a failed payment and lets the customer try again", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const failed = await pay(s.customer.cookie, created.id, "failed");
    expect(failed.result).toBe("failed");
    expect(failed.booking).toMatchObject({ status: "awaiting_payment", paymentStatus: "failed", canPay: true });
    expect((await notificationsFor(s.customer.userId)).map((n) => n.type)).toEqual(["service_booking_payment_failed"]);
    const retry = await pay(s.customer.cookie, created.id);
    expect(retry.result).toBe("paid");
    expect(retry.reference).not.toBe(failed.reference);
    const attempts = await attemptsFor(created.id);
    expect(attempts.map((a) => a.status)).toEqual(["failed", "success"]);
  });

  it("resumes the open attempt rather than starting a second, and runs one at a time", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const first = dataOf(await checkout(s.customer.cookie, created.id));
    const again = dataOf(await checkout(s.customer.cookie, created.id));
    expect(again).toEqual(first);
    const abandoned = await fixedSetup();
    const other = await booked(abandoned.customer.cookie, bookingBody(abandoned.service.id));
    const results = await Promise.all([0, 1, 2].map(() => checkout(abandoned.customer.cookie, other.id)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => dataOf(r).reference)).size).toBe(1);
    expect((await attemptsFor(other.id)).filter((a) => a.active)).toHaveLength(1);
  });

  it("starts a fresh attempt after an abandoned one, which Paystack confirms wasn't paid", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const first = dataOf(await checkout(s.customer.cookie, created.id));
    completeCheckout(first.reference, "abandoned");
    // still payable on Paystack: resumed
    expect(dataOf(await checkout(s.customer.cookie, created.id)).reference).toBe(first.reference);
    completeCheckout(first.reference, "failed");
    const second = dataOf(await checkout(s.customer.cookie, created.id));
    expect(second.reference).not.toBe(first.reference);
  });

  it("reports a provider outage as an outage, without changing anything", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    paystack.behaviour.initialize = "reject";
    const rejected = await checkout(s.customer.cookie, created.id);
    expect(rejected.status).toBe(502);
    paystack.behaviour.initialize = "ok";
    const { reference } = dataOf(await checkout(s.customer.cookie, created.id));
    completeCheckout(reference);
    paystack.behaviour.transaction = "timeout";
    const ambiguous = dataOf(await verify(s.customer.cookie, created.id, reference));
    expect(ambiguous.result).toBe("unknown");
    expect(ambiguous.booking.paymentStatus).toBe("pending");
    paystack.behaviour.transaction = "ok";
    expect(dataOf(await verify(s.customer.cookie, created.id, reference)).result).toBe("paid");
  });

  it("applies the charge webhook once, however often it arrives", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const { reference } = dataOf(await checkout(s.customer.cookie, created.id));
    const transaction = completeCheckout(reference);
    const { raw, signature } = signedChargeEvent(transaction);
    for (let i = 0; i < 3; i++) expect((await webhook(raw, signature)).status).toBe(200);
    const doc = await stored(created.id);
    expect(doc).toMatchObject({ status: "requested", paymentStatus: "paid", paidKobo: 45000_00 });
    expect(doc.history.filter((h) => h.event === "paid")).toHaveLength(1);
    // a forged signature is refused
    expect((await webhook(raw, "0".repeat(128))).status).toBe(401);
  });

  it("refunds a payment that arrives after the booking lapsed", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    const { reference } = dataOf(await checkout(s.customer.cookie, created.id));
    vi.setSystemTime(MONDAY_8AM.getTime() + 31 * MINUTE);
    await runJob();
    expect((await stored(created.id)).status).toBe("expired");

    const transaction = completeCheckout(reference);
    const { raw, signature } = signedChargeEvent(transaction);
    expect((await webhook(raw, signature)).status).toBe(200);
    expect((await webhook(raw, signature)).status).toBe(200);
    const doc = await stored(created.id);
    expect(doc.status).toBe("expired");
    expect(doc.history.map((h) => h.event)).toContain("late_payment_refunded");
    const refunds = await refundsFor(created.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ kind: "late_payment", amountKobo: 45000_00, status: "processed" });
    expect(paystack.requests.filter((r) => r.operation === "refund")).toHaveLength(1);
    expect(await entriesFor(doc.reference)).toEqual([]);
  });

  it("refuses to take payments while payments are switched off", async () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "");
    const s = await fixedSetup();
    const res = await book(s.customer.cookie, bookingBody(s.service.id));
    expect(res.status).toBe(503);
    // a quote request can still be sent: nothing is paid until a quote is accepted
    const q = await quoteSetup();
    expect((await book(q.customer.cookie, bookingBody(q.service.id, { details: HAULAGE_DETAILS }))).status).toBe(201);
  });
});

// --- the ledger --------------------------------------------------------------------------

describe("the provider's ledger", () => {
  it("records nothing without a commission policy, or before the provider takes the job", async () => {
    const s = await fixedSetup();
    const created = await booked(s.customer.cookie, bookingBody(s.service.id));
    await pay(s.customer.cookie, created.id);
    setCommission(1000);
    await runJob();
    expect(await entriesFor(created.reference)).toEqual([]); // paid, not accepted yet
    setCommission(0, "");
    vi.stubEnv("COMMISSION_RATE_BPS", "");

    const t = await confirmedFixed();
    expect(await entriesFor(t.booking.reference)).toEqual([]); // no policy configured
  });

  it("records the earning once accepted, delivery on completion, and the provider's share of a refund", async () => {
    setCommission(1000, "2030-test");
    const { provider, booking, customer } = await confirmedFixed();
    expect((await entriesFor(booking.reference)).map((e) => [e.type, e.amountKobo])).toEqual([
      ["earning", 45000_00],
      ["platform_fee", 4500_00],
    ]);
    expect((await stored(booking.id)).settlement).toMatchObject({
      policyId: "2030-test",
      rateBps: 1000,
      feeKobo: 4500_00,
    });
    expect((await getWalletSummary(provider.userId)).pendingKobo).toBe(40500_00);
    // the customer paid exactly the price: commission is the provider's cost, not a customer fee
    expect((await stored(booking.id)).paidKobo).toBe(45000_00);
    // the customer's own wallet is untouched
    expect(await getWalletSummary(customer.userId)).toMatchObject({ pendingKobo: 0, availableKobo: 0 });

    // repeated syncs don't add entries
    await runJob();
    await runJob();
    expect(await entriesFor(booking.reference)).toHaveLength(2);

    const cancelled = await acted(provider.cookie, booking, "cancel", { reason: "Truck broke down" });
    expect(cancelled.paymentStatus).toBe("refunded");
    expect((await entriesFor(booking.reference)).map((e) => [e.type, e.amountKobo])).toEqual([
      ["earning", 45000_00],
      ["platform_fee", 4500_00],
      ["refund", 40500_00],
    ]);
    expect(await getWalletSummary(provider.userId)).toMatchObject({ pendingKobo: 0, availableKobo: 0 });
  });

  it("starts the withdrawal window when the job is completed", async () => {
    setCommission(500);
    const { provider, booking } = await confirmedFixed();
    vi.setSystemTime(WEDNESDAY_8AM);
    const working = await acted(provider.cookie, booking, "start");
    await acted(provider.cookie, working, "complete");
    expect((await entriesFor(booking.reference)).map((e) => e.type)).toEqual(["earning", "platform_fee"]);
    const delivery = await (
      await collections()
    ).fulfillments.findOne({
      sourceType: "service_booking",
      sourceId: booking.reference,
    });
    expect(delivery?.deliveredAt).toBeInstanceOf(Date);
    expect((await getWalletSummary(provider.userId)).availableKobo).toBe(0);
    vi.setSystemTime(WEDNESDAY_8AM.getTime() + 25 * HOUR);
    expect((await getWalletSummary(provider.userId)).availableKobo).toBe(42750_00);
  });

  it("leaves orders and vet appointments alone", async () => {
    setCommission(1000);
    await confirmedFixed();
    const db = await collections();
    expect(await db.orders.countDocuments()).toBe(0);
    expect(await db.orderPayments.countDocuments()).toBe(0);
    expect(await db.refunds.countDocuments()).toBe(0);
    expect(await db.ledger.countDocuments({ "source.type": { $ne: "service_booking" } })).toBe(0);
  });
});
