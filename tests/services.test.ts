import { Collection, MongoServerError, ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { GET as listRoute, POST as createRoute } from "@/app/api/services/route";
import { DELETE as deleteRoute, GET as getRoute, PATCH as patchRoute } from "@/app/api/services/[id]/route";
import { SERVICE_LIMITS } from "@/lib/services/config";
import type { ServiceResponse, ServicesResponse } from "@/lib/services/types";
import { collections, userByPhone } from "./support/db";
import { newRegistration, registerPending, registerVerified } from "./support/flows";
import { call, dataOf, type CallOptions } from "./support/http";

const vet = () => registerVerified(newRegistration({ role: "veterinarian", fullName: "Tunde Bakare" }));
const specialist = () => registerVerified(newRegistration({ role: "non-vet-specialist", fullName: "Kemi Adeyemi" }));
const farmer = () => registerVerified(newRegistration());

const CONSULT = {
  name: "Farm visit & flock check",
  category: "consultation",
  description: "On-site visit to examine your flock and advise on treatment.",
  priceNgn: 15000,
  durationMinutes: 60,
};

const withId = (handler: typeof getRoute, id: string) => (request: Request) =>
  handler(request, { params: Promise.resolve({ id }) });

const list = (cookie?: string) => call<ServicesResponse>(listRoute, "/api/services", { cookie });
const create = (body: unknown, cookie?: string, options: CallOptions = {}) =>
  call<ServiceResponse>(createRoute, "/api/services", { body, cookie, ...options });
const read = (id: string, cookie?: string) =>
  call<ServiceResponse>(withId(getRoute, id), `/api/services/${id}`, { cookie });
const patch = (id: string, body: unknown, cookie?: string, options: CallOptions = {}) =>
  call<ServiceResponse>(withId(patchRoute, id), `/api/services/${id}`, { method: "PATCH", body, cookie, ...options });
const remove = (id: string, cookie?: string, options: CallOptions = {}) =>
  call<null>(withId(deleteRoute, id), `/api/services/${id}`, { method: "DELETE", cookie, ...options });

function fieldErrorsOf(result: { json: { ok: boolean } }) {
  return (result.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};
}

async function storedServices() {
  return (await collections()).services.find().toArray();
}

async function createdBy(cookie: string, body: object = CONSULT) {
  const res = await create(body, cookie);
  expect(res.status).toBe(201);
  return dataOf(res).service;
}

/** Makes one Collection method throw, but only for the services collection. */
function failServices(method: "insertOne" | "find" | "findOne" | "findOneAndUpdate" | "updateOne") {
  const original = Collection.prototype[method] as (...args: unknown[]) => unknown;
  return vi.spyOn(Collection.prototype, method).mockImplementation(function (this: Collection, ...args: unknown[]) {
    if (this.collectionName === "services") throw new MongoServerError({ message: "simulated outage" });
    return original.apply(this, args);
  } as never);
}

describe("GET /api/services", () => {
  it("requires a signed-in, verified account", async () => {
    expect((await list()).status).toBe(401);
    expect((await list("not-a-real-session-token")).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await list(pendingCookie)).status).toBe(403);
  });

  it("is empty for a new account and is never cached", async () => {
    const { cookie } = await vet();
    const res = await list(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(dataOf(res).services).toEqual([]);
  });

  it("lists only the signed-in user's own services, newest first", async () => {
    const a = await vet();
    const b = await vet();
    const first = await createdBy(a.cookie);
    const second = await createdBy(a.cookie, { ...CONSULT, name: "Vaccination round", category: "vaccination" });
    await createdBy(b.cookie, { ...CONSULT, name: "Someone else's service" });

    const services = dataOf(await list(a.cookie)).services;
    expect(services.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(JSON.stringify(services)).not.toMatch(/ownerUserId|Someone else/);
  });
});

describe("POST /api/services", () => {
  it("creates a service owned by the signed-in account", async () => {
    const { input, cookie } = await vet();
    const res = await create(CONSULT, cookie);
    expect(res.status).toBe(201);

    const { service } = dataOf(res);
    expect(service).toMatchObject({
      ...CONSULT,
      active: true,
      bookingAvailable: true,
      bookable: true,
    });
    expect(service.id).toMatch(/^[0-9a-f]{24}$/);
    expect(Object.keys(service)).not.toContain("ownerUserId");

    const user = await userByPhone(input.phone);
    const [doc] = await storedServices();
    expect(doc.ownerUserId.equals(user!._id)).toBe(true);
    expect(doc).toMatchObject({ archivedAt: null });
    // no copied profile data
    expect(JSON.stringify(doc)).not.toContain(input.fullName);
    expect(dataOf(await list(cookie)).services).toHaveLength(1);
  });

  it("tidies whitespace and accepts a free service or one whose duration varies", async () => {
    const { cookie } = await vet();
    const service = await createdBy(cookie, {
      ...CONSULT,
      name: "  Phone   consultation ",
      description: "  First call is free.\r\n\r\n\r\nWe agree the next steps.  ",
      priceNgn: 0,
      durationMinutes: null,
      bookingAvailable: false,
    });
    expect(service).toMatchObject({
      name: "Phone consultation",
      description: "First call is free.\n\nWe agree the next steps.",
      priceNgn: 0,
      durationMinutes: null,
      active: true,
      bookingAvailable: false,
      bookable: false,
    });
  });

  it("rejects an empty, too short or too long name", async () => {
    const { cookie } = await vet();
    for (const name of ["", "   ", "ab", "x".repeat(SERVICE_LIMITS.name.max + 1)]) {
      const res = await create({ ...CONSULT, name }, cookie);
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("name");
    }
    expect(await storedServices()).toHaveLength(0);
  });

  it("rejects a missing or oversized description", async () => {
    const { cookie } = await vet();
    for (const description of ["", "too short", "x".repeat(SERVICE_LIMITS.description.max + 1)]) {
      const res = await create({ ...CONSULT, description }, cookie);
      expect(res.status).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("description");
    }
    expect(await storedServices()).toHaveLength(0);
  });

  it("rejects categories that don't exist or belong to another role", async () => {
    const { cookie: vetCookie } = await vet();
    const { cookie: farmerCookie } = await farmer();
    const { cookie: specialistCookie } = await specialist();

    const cases: Array<[string, string]> = [
      [vetCookie, ""],
      [vetCookie, "made-up"],
      [vetCookie, "__proto__"],
      [vetCookie, "equipment-hire"], // a farmer category
      [farmerCookie, "vaccination"], // vets only
      [specialistCookie, "emergency-visit"], // vets only
    ];
    for (const [cookie, category] of cases) {
      const res = await create({ ...CONSULT, category }, cookie);
      expect(res.status, category).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("category");
    }
    expect(await storedServices()).toHaveLength(0);
  });

  it("lets each role list services from its own categories", async () => {
    const { cookie: farmerCookie } = await farmer();
    const { cookie: specialistCookie } = await specialist();
    const advisory = { ...CONSULT, name: "Broiler starter mentoring", category: "farm-advisory" };
    const feed = { ...CONSULT, name: "Layer feed formulation", category: "nutrition-feed" };
    expect((await create(advisory, farmerCookie)).status).toBe(201);
    expect((await create(feed, specialistCookie)).status).toBe(201);
  });

  it("rejects negative, fractional, non-numeric, excessive or disallowed-free prices", async () => {
    const { cookie } = await vet();
    const bad: unknown[] = [-1, -5000, 1500.5, "5000", null, Number.MAX_SAFE_INTEGER, SERVICE_LIMITS.maxPriceNgn + 1];
    for (const priceNgn of bad) {
      const res = await create({ ...CONSULT, priceNgn }, cookie);
      expect(res.status, String(priceNgn)).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("priceNgn");
    }
    // vaccination can't be free; nothing is silently changed to a default
    const free = await create({ ...CONSULT, category: "vaccination", priceNgn: 0 }, cookie);
    expect(free.status).toBe(400);
    expect(fieldErrorsOf(free).priceNgn).toMatch(/can't be listed as free/);

    const { priceNgn: _omit, ...noPrice } = CONSULT;
    void _omit;
    expect((await create(noPrice, cookie)).status).toBe(400);
    expect(await storedServices()).toHaveLength(0);
  });

  it("rejects durations that aren't in the list", async () => {
    const { cookie } = await vet();
    for (const durationMinutes of [0, -30, 7, 61, "60", true, 1e9]) {
      const res = await create({ ...CONSULT, durationMinutes }, cookie);
      expect(res.status, String(durationMinutes)).toBe(400);
      expect(fieldErrorsOf(res)).toHaveProperty("durationMinutes");
    }
    const { durationMinutes: _omit, ...noDuration } = CONSULT;
    void _omit;
    expect(fieldErrorsOf(await create(noDuration, cookie))).toHaveProperty("durationMinutes");
    expect(await storedServices()).toHaveLength(0);
  });

  it("refuses an owner, id or bookkeeping fields in the body", async () => {
    const { cookie } = await vet();
    const other = new ObjectId().toHexString();
    for (const extra of [
      { ownerUserId: other },
      { _id: other },
      { id: other },
      { bookable: true },
      { archivedAt: null },
      { createdAt: "2020-01-01T00:00:00.000Z" },
    ]) {
      const res = await create({ ...CONSULT, ...extra }, cookie);
      expect(res.status).toBe(400);
      expect(Object.keys(fieldErrorsOf(res))).toEqual(Object.keys(extra));
    }
    // a JSON "__proto__" key is an own property and is refused too
    const proto = await create(undefined, cookie, { rawBody: `{"__proto__":{"active":false},"name":"x"}` });
    expect(proto.status).toBe(400);
    expect(await storedServices()).toHaveLength(0);
  });

  it("rejects booleans that aren't booleans", async () => {
    const { cookie } = await vet();
    const res = await create({ ...CONSULT, active: "yes", bookingAvailable: 1 }, cookie);
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res)).toMatchObject({ active: expect.any(String), bookingAvailable: expect.any(String) });
  });

  it("requires a verified session, same origin and a JSON body", async () => {
    expect((await create(CONSULT)).status).toBe(401);
    const { pendingCookie } = await registerPending(newRegistration({ role: "veterinarian" }));
    expect((await create(CONSULT, pendingCookie)).status).toBe(403);
    const { cookie } = await vet();
    expect((await create(CONSULT, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await create(CONSULT, cookie, { origin: null })).status).toBe(403);
    expect((await create(CONSULT, cookie, { contentType: "text/plain" })).status).toBe(415);
    expect((await create(undefined, cookie, { rawBody: "[1,2]" })).status).toBe(400);
    expect(await storedServices()).toHaveLength(0);
  });

  it("caps how many services one account can list", async () => {
    const { input, cookie } = await vet();
    const user = await userByPhone(input.phone);
    const now = new Date();
    await (await collections()).services.insertMany(
      Array.from({ length: SERVICE_LIMITS.perOwner }, (_, i) => ({
        _id: new ObjectId(),
        ownerUserId: user!._id,
        ...CONSULT,
        name: `Service ${i}`,
        active: true,
        bookingAvailable: true,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const res = await create(CONSULT, cookie);
    expect(res.status).toBe(409);
    expect(await storedServices()).toHaveLength(SERVICE_LIMITS.perOwner);
  });

  it("reports a database failure honestly without saving or leaking details", async () => {
    const { cookie } = await vet();
    const spy = failServices("insertOne");
    const res = await create(CONSULT, cookie);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ ok: false, error: "Something went wrong on our side. Please try again." });
    expect(await storedServices()).toHaveLength(0);
  });
});

describe("GET/PATCH/DELETE /api/services/[id]", () => {
  it("reads one of the user's services", async () => {
    const { cookie } = await vet();
    const service = await createdBy(cookie);
    const res = await read(service.id, cookie);
    expect(res.status).toBe(200);
    expect(dataOf(res).service).toEqual(service);
  });

  it("edits only the fields sent, keeping the rest", async () => {
    const { cookie } = await vet();
    const service = await createdBy(cookie);
    const res = await patch(service.id, { name: "Extended farm visit", priceNgn: 25000, durationMinutes: 120 }, cookie);
    expect(res.status).toBe(200);
    const updated = dataOf(res).service;
    expect(updated).toMatchObject({
      ...CONSULT,
      name: "Extended farm visit",
      priceNgn: 25000,
      durationMinutes: 120,
      createdAt: service.createdAt,
    });
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(service.updatedAt).getTime());
    expect(dataOf(await read(service.id, cookie)).service).toEqual(updated);
  });

  it("validates edits, including price against a new category", async () => {
    const { cookie } = await vet();
    const service = await createdBy(cookie, { ...CONSULT, priceNgn: 0 }); // free consultation

    expect(fieldErrorsOf(await patch(service.id, { name: "" }, cookie))).toHaveProperty("name");
    expect(fieldErrorsOf(await patch(service.id, { priceNgn: -10 }, cookie))).toHaveProperty("priceNgn");
    expect(fieldErrorsOf(await patch(service.id, { durationMinutes: 7 }, cookie))).toHaveProperty("durationMinutes");
    expect(fieldErrorsOf(await patch(service.id, { category: "equipment-hire" }, cookie))).toHaveProperty("category");
    // vaccination can't be free, and the stored price is ₦0
    const recategorised = await patch(service.id, { category: "vaccination" }, cookie);
    expect(recategorised.status).toBe(400);
    expect(fieldErrorsOf(recategorised)).toHaveProperty("priceNgn");
    // with a price it's fine
    expect((await patch(service.id, { category: "vaccination", priceNgn: 3000 }, cookie)).status).toBe(200);

    const empty = await patch(service.id, {}, cookie);
    expect(empty.status).toBe(400);
    expect(empty.json).toMatchObject({ error: "There are no changes to save." });
  });

  it("never lets the owner or bookkeeping fields be changed", async () => {
    const a = await vet();
    const b = await vet();
    const service = await createdBy(a.cookie);
    const bUser = await userByPhone(b.input.phone);

    for (const body of [
      { ownerUserId: bUser!._id.toHexString() },
      { ownerUserId: bUser!._id.toHexString(), name: "Taken over" },
      { archivedAt: null },
      { bookable: true },
      { _id: new ObjectId().toHexString() },
    ]) {
      const res = await patch(service.id, body, a.cookie);
      expect(res.status).toBe(400);
    }
    const [doc] = await storedServices();
    const aUser = await userByPhone(a.input.phone);
    expect(doc.ownerUserId.equals(aUser!._id)).toBe(true);
    expect(doc.name).toBe(CONSULT.name);
    expect(dataOf(await list(b.cookie)).services).toEqual([]);
  });

  it("toggles active and booking availability independently", async () => {
    const { cookie } = await vet();
    const { id } = await createdBy(cookie);

    let s = dataOf(await patch(id, { active: false }, cookie)).service;
    expect(s).toMatchObject({ active: false, bookingAvailable: true, bookable: false });

    s = dataOf(await patch(id, { bookingAvailable: false }, cookie)).service;
    expect(s).toMatchObject({ active: false, bookingAvailable: false, bookable: false });

    s = dataOf(await patch(id, { active: true }, cookie)).service;
    // active again, but still not taking bookings
    expect(s).toMatchObject({ active: true, bookingAvailable: false, bookable: false });

    s = dataOf(await patch(id, { bookingAvailable: true }, cookie)).service;
    expect(s).toMatchObject({ active: true, bookingAvailable: true, bookable: true });

    // an inactive service is never bookable, whatever its booking flag says
    s = dataOf(await patch(id, { active: false }, cookie)).service;
    expect(s).toMatchObject({ active: false, bookingAvailable: true, bookable: false });
    expect(dataOf(await list(cookie)).services[0]).toMatchObject({ bookable: false });
  });

  it("removes (archives) a service so it's gone from every endpoint", async () => {
    const { cookie } = await vet();
    const keep = await createdBy(cookie, { ...CONSULT, name: "Keep me" });
    const gone = await createdBy(cookie);

    const res = await remove(gone.id, cookie);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, data: null });

    expect(dataOf(await list(cookie)).services.map((s) => s.id)).toEqual([keep.id]);
    expect((await read(gone.id, cookie)).status).toBe(404);
    expect((await patch(gone.id, { active: true }, cookie)).status).toBe(404);
    expect((await remove(gone.id, cookie)).status).toBe(404);

    // kept for future booking history, but switched off
    const doc = (await storedServices()).find((d) => d._id.toHexString() === gone.id);
    expect(doc).toMatchObject({ active: false, bookingAvailable: false });
    expect(doc!.archivedAt).toBeInstanceOf(Date);
  });

  it("treats another user's service exactly like a missing one", async () => {
    const owner = await vet();
    const intruder = await vet();
    const service = await createdBy(owner.cookie);

    const notFound = { ok: false, error: "We couldn't find that service. It may have been removed." };
    for (const res of [
      await read(service.id, intruder.cookie),
      await patch(service.id, { name: "Hijacked", priceNgn: 1 }, intruder.cookie),
      await patch(service.id, { active: false }, intruder.cookie),
      await remove(service.id, intruder.cookie),
      await read(new ObjectId().toHexString(), intruder.cookie),
    ]) {
      expect(res.status).toBe(404);
      expect(res.json).toEqual(notFound);
    }
    expect(dataOf(await read(service.id, owner.cookie)).service).toEqual(service);
  });

  it("404s malformed ids without touching the database", async () => {
    const { cookie } = await vet();
    for (const id of ["abc", "zzzzzzzzzzzzzzzzzzzzzzzz", "123456789012", "{\"$ne\":null}"]) {
      expect((await read(id, cookie)).status).toBe(404);
      expect((await patch(id, { active: false }, cookie)).status).toBe(404);
      expect((await remove(id, cookie)).status).toBe(404);
    }
  });

  it("requires a verified session and same-origin changes", async () => {
    const { cookie } = await vet();
    const { id } = await createdBy(cookie);
    expect((await read(id)).status).toBe(401);
    expect((await patch(id, { active: false })).status).toBe(401);
    expect((await remove(id)).status).toBe(401);
    expect((await patch(id, { active: false }, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect((await remove(id, cookie, { origin: "https://evil.example" })).status).toBe(403);
    expect(dataOf(await read(id, cookie)).service).toMatchObject({ active: true });
  });

  it("reports database failures honestly and changes nothing", async () => {
    const { cookie } = await vet();
    const service = await createdBy(cookie);

    let spy = failServices("findOneAndUpdate");
    const edit = await patch(service.id, { name: "Should not save" }, cookie);
    spy.mockRestore();
    expect(edit.status).toBe(500);
    expect(JSON.stringify(edit.json)).not.toContain("simulated outage");

    spy = failServices("updateOne");
    const removed = await remove(service.id, cookie);
    spy.mockRestore();
    expect(removed.status).toBe(500);

    spy = failServices("find");
    const listed = await list(cookie);
    spy.mockRestore();
    expect(listed.status).toBe(500);
    expect(listed.json).toEqual({ ok: false, error: "Something went wrong on our side. Please try again." });

    expect(dataOf(await read(service.id, cookie)).service).toEqual(service);
  });
});
