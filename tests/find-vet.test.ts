import { randomUUID } from "node:crypto";
import { Collection, MongoServerError, ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as decideRoute } from "@/app/api/admin/credentials/[userId]/route";
import { GET as appointmentRoute, PATCH as transitionRoute } from "@/app/api/appointments/[id]/route";
import { GET as listRoute, POST as bookRoute } from "@/app/api/appointments/route";
import { POST as checklistRoute } from "@/app/api/appointments/[id]/visit/checklist/route";
import { PUT as notesRoute } from "@/app/api/appointments/[id]/visit/notes/route";
import { GET as getAvailabilityRoute, PUT as availabilityRoute } from "@/app/api/availability/route";
import { POST as jobRoute } from "@/app/api/internal/appointments/process/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { POST as createServiceRoute } from "@/app/api/services/route";
import { PATCH as patchServiceRoute } from "@/app/api/services/[id]/route";
import { GET as profileRoute } from "@/app/api/vets/[id]/route";
import { GET as slotsRoute } from "@/app/api/vets/[id]/slots/route";
import { GET as searchRoute } from "@/app/api/vets/route";
import { syncAppointmentNotifications } from "@/lib/server/notifications";
import { COLLECTIONS, type VetDirectoryDoc } from "@/lib/server/models";
import { vetCollections } from "@/lib/server/vet-directory";
import type { ServiceResponse } from "@/lib/services/types";
import {
  isFullyConfirmed,
  type AppointmentListResponse,
  type AppointmentResponse,
  type AvailabilityResponse,
  type DirectoryPage,
  type SlotsResponse,
  type VetProfile,
} from "@/lib/vets/types";
import { collections } from "./support/db";
import { FARM, newRegistration, registerPending, registerWithFarm } from "./support/flows";
import { call, dataOf, ORIGIN, type CallOptions, type CallResult } from "./support/http";
import { merchant } from "./support/wallet";

// Find a Vet against the real route handlers and an in-memory replica set.
// The clock is fixed (Date only, so the database driver keeps real timers)
// at Monday 4 Nov 2030, 08:00 in Lagos. Vets are approved through the real
// admin credential review; directory pages are seeded straight into the
// derived directory collection where only paging is under test.

const MONDAY_8AM = new Date("2030-11-04T07:00:00.000Z");
/** Tuesday 5 Nov 2030, 10:00 and 11:00 in Lagos */
const TUE_10 = "2030-11-05T09:00:00.000Z";
const TUE_11 = "2030-11-05T10:00:00.000Z";
const HOUR = 60 * 60_000;
const JOB_SECRET = "test-order-job-secret-at-least-32-chars!";

const WORK_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: 8 * 60, end: 17 * 60 }));
const SETTINGS = {
  listed: true,
  state: "oyo",
  area: "Ibadan",
  hours: WORK_WEEK,
  slotMinutes: 60,
  blockedDates: [] as string[],
  sharePhoneWithClients: false,
};
const VISIT = {
  name: "Farm visit & flock check",
  category: "consultation",
  description: "On-site visit to examine your flock and advise on treatment.",
  priceNgn: 15000,
  durationMinutes: 60,
};
const LOCATION = { address: "Km 5 Ife Road, Ibadan", state: "oyo", directions: "Second gate after the filling station." };

type Account = Awaited<ReturnType<typeof merchant>>;
type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

function callWith<T, P>(handler: Handler<P>, path: string, params: P, options: CallOptions = {}) {
  return call<T>((request) => handler(request, { params: Promise.resolve(params) }), path, options);
}
const errorOf = (res: CallResult<unknown>) => (res.json as { ok: false; error: string }).error;
const fieldErrorsOf = (res: CallResult<unknown>) =>
  (res.json as { ok: false; fieldErrors?: Record<string, string> }).fieldErrors ?? {};

let admin: Account | null = null;

beforeEach(() => {
  admin = null;
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(MONDAY_8AM);
});
afterEach(() => {
  vi.useRealTimers();
});

// --- accounts --------------------------------------------------------------------

/** An admin account (ADMIN_USER_IDS is reset before every test). */
async function adminAccount() {
  admin = await merchant("poultry-farmer");
  vi.stubEnv("ADMIN_USER_IDS", admin.userId.toHexString());
  return admin;
}

/** A vet who submitted credentials; approved through the admin review unless `approve` is false. */
async function vetAccount({ approve = true, years = 6 } = {}) {
  const vet = await merchant("veterinarian");
  const res = await call(patchProfile, "/api/profile", {
    body: {
      registrationNumber: "VCN/12345",
      specialization: "poultry-medicine",
      qualifications: "DVM, University of Ibadan",
      yearsOfExperience: years,
    },
    cookie: vet.cookie,
    method: "PATCH",
  });
  expect(res.status).toBe(200);
  if (approve) {
    const boss = admin ?? (await adminAccount());
    const user = await (await collections()).users.findOne({ _id: vet.userId });
    const id = vet.userId.toHexString();
    const decided = await callWith(decideRoute, `/api/admin/credentials/${id}`, { userId: id }, {
      cookie: boss.cookie,
      body: { decision: "approve", submittedAt: user!.profile!.credentialSubmittedAt!.toISOString() },
    });
    expect(decided.status).toBe(200);
  }
  return vet;
}

async function addService(cookie: string, body: object = VISIT) {
  const res = await call<ServiceResponse>(createServiceRoute, "/api/services", { body, cookie });
  expect(res.status).toBe(201);
  return dataOf(res).service;
}

const putAvailability = (cookie: string, body: object = SETTINGS) =>
  call<AvailabilityResponse>(availabilityRoute, "/api/availability", { body, cookie, method: "PUT" });

/** An approved, listed vet with one bookable service. */
async function listedVet(options: { service?: object; settings?: object; years?: number } = {}) {
  const vet = await vetAccount({ years: options.years });
  const service = await addService(vet.cookie, options.service);
  const saved = await putAvailability(vet.cookie, { ...SETTINGS, ...options.settings });
  expect(saved.status).toBe(200);
  expect(dataOf(saved).listingIssues).toEqual([]);
  return { ...vet, service };
}

/** A verified farmer with a farm; returns the farm id too. */
async function customer() {
  const { input, cookie } = await registerWithFarm(newRegistration());
  const { users, farms } = await collections();
  const user = await users.findOne({ phoneNormalized: input.phone });
  const farm = await farms.findOne({ ownerUserId: user!._id });
  return { cookie, userId: user!._id, phone: input.phone, farmId: farm!._id.toHexString() };
}

// --- calls -------------------------------------------------------------------------

const search = (cookie: string | undefined, qs = "") => call<DirectoryPage>(searchRoute, `/api/vets${qs ? `?${qs}` : ""}`, { cookie });
const profile = (cookie: string, id: string) => callWith<{ vet: VetProfile }, { id: string }>(profileRoute, `/api/vets/${id}`, { id }, { cookie });
const slots = (cookie: string, id: string, qs: string) =>
  callWith<SlotsResponse, { id: string }>(slotsRoute, `/api/vets/${id}/slots?${qs}`, { id }, { cookie });

function book(cookie: string, body: Record<string, unknown>) {
  return call<AppointmentResponse>(bookRoute, "/api/appointments", {
    cookie,
    body: { location: LOCATION, idempotencyKey: randomUUID(), ...body },
  });
}
const read = (cookie: string, id: string) =>
  callWith<AppointmentResponse, { id: string }>(appointmentRoute, `/api/appointments/${id}`, { id }, { cookie });
const move = (cookie: string, id: string, action: string, expectedStatus: string, extra: object = {}) =>
  callWith<AppointmentResponse, { id: string }>(transitionRoute, `/api/appointments/${id}`, { id }, {
    cookie,
    method: "PATCH",
    body: { action, expectedStatus, ...extra },
  });

function runJob(authorization: string | null = `Bearer ${JOB_SECRET}`) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== null) headers.set("authorization", authorization);
  return jobRoute(new Request(`${ORIGIN}/api/internal/appointments/process`, { method: "POST", headers, body: "{}" }));
}

async function booked(vet: Awaited<ReturnType<typeof listedVet>>, who?: Awaited<ReturnType<typeof customer>>, startsAt = TUE_10) {
  const buyer = who ?? (await customer());
  const res = await book(buyer.cookie, { serviceId: vet.service.id, startsAt });
  expect(res.status).toBe(201);
  return { buyer, appointment: dataOf(res).appointment };
}

const holdsFor = async (appointmentId: string) =>
  (await vetCollections()).slots.countDocuments({ appointmentId: new ObjectId(appointmentId) });

// --- seeded directory entries (paging only) -----------------------------------------

let seeded = 0;
function entry(overrides: Partial<VetDirectoryDoc> = {}): VetDirectoryDoc {
  seeded += 1;
  const name = overrides.name ?? `Vet ${String(seeded).padStart(3, "0")}`;
  const years = overrides.yearsOfExperience === undefined ? 5 : overrides.yearsOfExperience;
  return {
    _id: new ObjectId(),
    listed: true,
    name,
    nameKey: name.toLowerCase(),
    photoUrl: null,
    specialization: "poultry-medicine",
    yearsOfExperience: years,
    experienceKey: years ?? -1,
    state: "lagos",
    area: "",
    serviceCategories: ["consultation"],
    priceFromNgn: 5000,
    minBlockMinutes: 60,
    slotMinutes: 60,
    hours: WORK_WEEK,
    searchWords: name.toLowerCase().split(" "),
    workDays: [0, 1, 2, 3, 4, 5, 6],
    blockedDates: [],
    refreshedAt: new Date(),
    ...overrides,
  };
}

async function seed(docs: VetDirectoryDoc[]) {
  await (await vetCollections()).directory.insertMany(docs);
  return docs;
}

/** Follows nextCursor to the end, returning every page's ids. */
async function allPages(cookie: string, qs: string) {
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams(qs);
    if (cursor) params.set("cursor", cursor);
    const res = await search(cookie, params.toString());
    expect(res.status).toBe(200);
    const page = dataOf(res);
    pages.push(page.vets.map((v) => v.id));
    cursor = page.nextCursor;
  } while (cursor && pages.length < 20);
  return pages;
}

// =====================================================================================

describe("directory search: GET /api/vets", () => {
  it("needs a verified session and is never cached", async () => {
    expect((await search(undefined)).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await search(pendingCookie)).status).toBe(403);
    const { cookie } = await customer();
    const res = await search(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(dataOf(res)).toEqual({ vets: [], nextCursor: null });
  });

  it("pages by experience with the id as tie-breaker: 12 by default, no duplicates, no total", async () => {
    const { cookie } = await customer();
    // 30 entries, many sharing the same experience so ties cross page boundaries
    const docs = await seed(Array.from({ length: 30 }, (_, i) => entry({ yearsOfExperience: i % 3 === 0 ? null : 10 - (i % 4) })));
    const pages = await allPages(cookie, "");
    expect(pages.map((p) => p.length)).toEqual([12, 12, 6]);
    const ids = pages.flat();
    expect(new Set(ids).size).toBe(30);
    const expected = [...docs]
      .sort((a, b) => b.experienceKey - a.experienceKey || a._id.toHexString().localeCompare(b._id.toHexString()))
      .map((d) => d._id.toHexString());
    expect(ids).toEqual(expected);
    const first = await search(cookie);
    expect(Object.keys(dataOf(first)).sort()).toEqual(["nextCursor", "vets"]);
  });

  it("sorts by name with ties broken by id, and honours a page size up to 24", async () => {
    const { cookie } = await customer();
    const docs = await seed(Array.from({ length: 7 }, (_, i) => entry({ name: i < 4 ? "Ade Bello" : `Zainab ${i}` })));
    const pages = await allPages(cookie, "sort=name&limit=3");
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
    const expected = [...docs]
      .sort((a, b) => a.nameKey.localeCompare(b.nameKey) || a._id.toHexString().localeCompare(b._id.toHexString()))
      .map((d) => d._id.toHexString());
    expect(pages.flat()).toEqual(expected);
    expect((await search(cookie, "limit=24")).status).toBe(200);
  });

  it("applies every filter before paging", async () => {
    const { cookie } = await customer();
    const oyo = await seed(
      Array.from({ length: 5 }, () => entry({ state: "oyo", serviceCategories: ["vaccination"], searchWords: ["adebayo"] })),
    );
    await seed(Array.from({ length: 25 }, () => entry({ state: "lagos" })));
    // matches the state but not the service
    await seed([entry({ state: "oyo", serviceCategories: ["consultation"], searchWords: ["adebayo"] })]);
    const pages = await allPages(cookie, "state=oyo&service=vaccination&q=ade&limit=2");
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(new Set(pages.flat())).toEqual(new Set(oyo.map((d) => d._id.toHexString())));
  });

  it("filters by work date: weekday worked and not a day off", async () => {
    const { cookie } = await customer();
    const [works] = await seed([entry({ workDays: [2] })]);
    await seed([entry({ workDays: [1, 3] }), entry({ workDays: [2], blockedDates: ["2030-11-05"] })]);
    const page = dataOf(await search(cookie, "date=2030-11-05"));
    expect(page.vets.map((v) => v.id)).toEqual([works._id.toHexString()]);
  });

  it("returns only listed entries", async () => {
    const { cookie } = await customer();
    const [shown] = await seed([entry()]);
    await seed([entry({ listed: false }), entry({ listed: false })]);
    expect(dataOf(await search(cookie)).vets.map((v) => v.id)).toEqual([shown._id.toHexString()]);
  });

  it("rejects a cursor used with other filters or sort, a tampered cursor, and junk", async () => {
    const { cookie } = await customer();
    await seed(Array.from({ length: 5 }, () => entry({ state: "oyo" })));
    const { nextCursor } = dataOf(await search(cookie, "state=oyo&limit=2"));
    expect(nextCursor).toBeTruthy();
    const cursor = nextCursor!;
    expect((await search(cookie, `state=oyo&limit=2&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
    // a different page size is the same search
    expect((await search(cookie, `state=oyo&limit=3&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);

    for (const qs of [
      `state=lagos&cursor=${encodeURIComponent(cursor)}`,
      `state=oyo&sort=name&cursor=${encodeURIComponent(cursor)}`,
      `cursor=${encodeURIComponent(cursor)}`,
    ]) {
      const res = await search(cookie, qs);
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe("This list has changed. Start the search again.");
    }
    const [payload, signature] = cursor.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, k: 99, i: new ObjectId().toHexString() })).toString("base64url");
    for (const bad of [`${forged}.${signature}`, `${payload}.${"0".repeat(32)}`, "not-a-cursor", `${cursor}.extra`, "x".repeat(301)])
      expect((await search(cookie, `state=oyo&cursor=${encodeURIComponent(bad)}`)).status).toBe(400);
  });

  it("rejects bad page sizes and unknown filter values", async () => {
    const { cookie } = await customer();
    for (const qs of ["limit=0", "limit=25", "limit=abc", "limit=-1", "limit=1.5", "state=atlantis", "sort=rating", "date=2030-02-30", "service=surgery"]) {
      const res = await search(cookie, qs);
      expect(res.status, qs).toBe(400);
    }
    expect(fieldErrorsOf(await search(cookie, "limit=25"))).toHaveProperty("limit");
  });

  it("returns public card fields only", async () => {
    const vet = await listedVet();
    const { cookie } = await customer();
    const page = dataOf(await search(cookie));
    expect(page.vets).toHaveLength(1);
    expect(Object.keys(page.vets[0]).sort()).toEqual(
      ["area", "id", "name", "nextOpenSlot", "photoUrl", "priceFromNgn", "serviceTypes", "specialization", "state", "yearsOfExperience"].sort(),
    );
    const text = JSON.stringify(page);
    for (const secret of ["VCN/12345", "phone", "email", "registration", "credential", "passwordHash"]) expect(text).not.toContain(secret);
    expect(page.vets[0]).toMatchObject({ id: vet.userId.toHexString(), priceFromNgn: 15000, state: "oyo" });
    // the next open time comes from real hours and notice: at 07:55, Monday 10:00 in Lagos
    vi.setSystemTime(new Date(MONDAY_8AM.getTime() - 5 * 60_000));
    expect(dataOf(await search(cookie)).vets[0].nextOpenSlot).toBe("2030-11-04T09:00:00.000Z");
    // a moment after 08:00, 10:00 is inside the notice period
    vi.setSystemTime(new Date(MONDAY_8AM.getTime() + 60_000));
    page.vets = dataOf(await search(cookie)).vets;
    expect(page.vets[0].nextOpenSlot).toBe("2030-11-04T10:00:00.000Z");
  });

  it("answers a database failure with a generic, retryable error", async () => {
    const { cookie } = await customer();
    const original = Collection.prototype.find;
    const spy = vi.spyOn(Collection.prototype, "find").mockImplementation(function (this: Collection, ...args: unknown[]) {
      if (this.collectionName === COLLECTIONS.vetDirectory) throw new MongoServerError({ message: "simulated outage" });
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    const res = await search(cookie);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ ok: false, error: "Something went wrong on our side. Please try again." });
  });
});

describe("who is listed", () => {
  it("lists a vet only after an admin approves their credentials", async () => {
    const { cookie } = await customer();
    const vet = await vetAccount({ approve: false });
    await addService(vet.cookie);
    const saved = dataOf(await putAvailability(vet.cookie));
    expect(saved.listingIssues).toEqual(["Your credentials haven't been approved by the Farm Korret team yet."]);
    expect(dataOf(await search(cookie)).vets).toEqual([]);
    expect((await profile(cookie, vet.userId.toHexString())).status).toBe(404);

    const boss = await adminAccount();
    const user = await (await collections()).users.findOne({ _id: vet.userId });
    const id = vet.userId.toHexString();
    await callWith(decideRoute, `/api/admin/credentials/${id}`, { userId: id }, {
      cookie: boss.cookie,
      body: { decision: "approve", submittedAt: user!.profile!.credentialSubmittedAt!.toISOString() },
    });
    expect(dataOf(await search(cookie)).vets.map((v) => v.id)).toEqual([id]);
    expect(await (await collections()).adminAudit.countDocuments({ action: "credential.approve" })).toBe(1);
  });

  it("never treats a missing credential status as verified", async () => {
    const { cookie } = await customer();
    const vet = await listedVet();
    await (await collections()).users.updateOne({ _id: vet.userId }, { $unset: { "profile.credentialStatus": "" } });
    // the profile and booking read the sources, not the directory entry
    expect((await profile(cookie, vet.userId.toHexString())).status).toBe(404);
    expect((await book(cookie, { serviceId: vet.service.id, startsAt: TUE_10 })).status).toBe(409);
    // the job rebuilds the entry from the sources
    expect((await runJob()).status).toBe(200);
    expect(dataOf(await search(cookie)).vets).toEqual([]);
  });

  it("drops a vet who turns listing off or has no bookable service", async () => {
    const { cookie } = await customer();
    const vet = await listedVet();
    const id = vet.userId.toHexString();
    await putAvailability(vet.cookie, { ...SETTINGS, listed: false });
    expect(dataOf(await search(cookie)).vets).toEqual([]);
    await putAvailability(vet.cookie);
    expect(dataOf(await search(cookie)).vets).toHaveLength(1);
    const res = await callWith(patchServiceRoute, `/api/services/${vet.service.id}`, { id: vet.service.id }, {
      cookie: vet.cookie,
      method: "PATCH",
      body: { bookingAvailable: false },
    });
    expect(res.status).toBe(200);
    expect(dataOf(await search(cookie)).vets).toEqual([]);
    expect((await profile(cookie, id)).status).toBe(404);
  });

  it("only lets veterinarians manage availability, and validates it", async () => {
    const farmer = await customer();
    expect((await putAvailability(farmer.cookie)).status).toBe(403);
    expect((await call(getAvailabilityRoute, "/api/availability", { cookie: farmer.cookie })).status).toBe(403);
    const vet = await vetAccount();
    for (const body of [
      { ...SETTINGS, hours: [{ day: 1, start: 545, end: 600 }] },
      { ...SETTINGS, hours: [{ day: 1, start: 600, end: 540 }] },
      { ...SETTINGS, slotMinutes: 45 },
      { ...SETTINGS, state: "atlantis" },
      { ...SETTINGS, blockedDates: ["2020-01-01"] },
      { ...SETTINGS, credentialStatus: "verified" },
    ])
      expect((await putAvailability(vet.cookie, body)).status).toBe(400);
  });
});

describe("vet profile: GET /api/vets/[id]", () => {
  it("shows public details and bookable services only", async () => {
    const vet = await listedVet();
    const hidden = await addService(vet.cookie, { ...VISIT, name: "Vaccination round", category: "vaccination", priceNgn: 8000 });
    await callWith(patchServiceRoute, `/api/services/${hidden.id}`, { id: hidden.id }, {
      cookie: vet.cookie,
      method: "PATCH",
      body: { active: false },
    });
    const { cookie } = await customer();
    const res = await profile(cookie, vet.userId.toHexString());
    expect(res.status).toBe(200);
    const shown = dataOf(res).vet;
    expect(shown.services.map((s) => s.id)).toEqual([vet.service.id]);
    const text = JSON.stringify(shown);
    for (const secret of ["VCN/12345", "University of Ibadan", "+234", "registration", "email"]) expect(text).not.toContain(secret);
    for (const id of ["nope", new ObjectId().toHexString(), (await customer()).userId.toHexString()])
      expect((await profile(cookie, id)).status).toBe(404);
  });
});

describe("open times: GET /api/vets/[id]/slots", () => {
  it("offers only future, in-hours, unheld times with notice", async () => {
    const vet = await listedVet();
    const { cookie } = await customer();
    vi.setSystemTime(new Date(MONDAY_8AM.getTime() - 5 * 60_000));
    const res = await slots(cookie, vet.userId.toHexString(), `service=${vet.service.id}`);
    expect(res.status).toBe(200);
    const [today, tomorrow] = dataOf(res).days;
    // 07:55 now: 2 hours' notice means 10:00 is the first; the last 60-minute visit starts at 16:00
    expect(today.slots[0]).toBe("2030-11-04T09:00:00.000Z");
    expect(today.slots.at(-1)).toBe("2030-11-04T15:00:00.000Z");
    expect(tomorrow.slots).toHaveLength(9);

    await booked(vet);
    const after = dataOf(await slots(cookie, vet.userId.toHexString(), `service=${vet.service.id}&from=2030-11-05`));
    expect(after.days[0].slots).not.toContain(TUE_10);
    expect(after.days[0].slots).toContain(TUE_11);

    for (const qs of [`service=${vet.service.id}&from=2030-11-03`, `service=${vet.service.id}&from=2031-01-01`, `service=${vet.service.id}&from=junk`])
      expect((await slots(cookie, vet.userId.toHexString(), qs)).status).toBe(400);
    expect((await slots(cookie, vet.userId.toHexString(), `service=${new ObjectId().toHexString()}`)).status).toBe(404);
  });
});

// =====================================================================================

describe("booking: POST /api/appointments", () => {
  it("books from the server's own price, ignoring anything the browser says about money or status", async () => {
    const vet = await listedVet();
    const buyer = await customer();
    const res = await book(buyer.cookie, {
      serviceId: vet.service.id,
      startsAt: TUE_10,
      farmId: buyer.farmId,
      priceKobo: 1,
      feeKobo: 0,
      totalKobo: 1,
      paymentStatus: "paid",
      bookingStatus: "confirmed",
      customerUserId: new ObjectId().toHexString(),
      vetUserId: new ObjectId().toHexString(),
    });
    expect(res.status).toBe(201);
    const a = dataOf(res).appointment;
    expect(a).toMatchObject({
      viewer: "customer",
      bookingStatus: "requested",
      paymentStatus: "payment_required",
      priceKobo: 15000_00,
      feeKobo: 0,
      totalKobo: 15000_00,
      startsAt: TUE_10,
      endsAt: TUE_11,
      location: { farmName: FARM.farmName, address: LOCATION.address, state: "oyo" },
      actions: ["cancel"],
    });
    expect(isFullyConfirmed(a)).toBe(false);
    expect(a.reference).toMatch(/^VA-[2-9A-Z]{8}$/);
    // the stored record names the session's user, and holds two 30-minute units
    const stored = await (await vetCollections()).appointments.findOne({ _id: new ObjectId(a.id) });
    expect(stored!.customerUserId.equals(buyer.userId)).toBe(true);
    expect(stored!.vetUserId.equals(vet.userId)).toBe(true);
    expect(await holdsFor(a.id)).toBe(2);
    expect(a.history).toEqual([{ status: "requested", by: "customer", at: MONDAY_8AM.toISOString().slice(0, 13) + a.history[0].at.slice(13), note: null }]);

    // later edits to the service or farm never change the booking
    await callWith(patchServiceRoute, `/api/services/${vet.service.id}`, { id: vet.service.id }, {
      cookie: vet.cookie,
      method: "PATCH",
      body: { priceNgn: 99000 },
    });
    expect(dataOf(await read(buyer.cookie, a.id)).appointment.priceKobo).toBe(15000_00);
  });

  it("marks a free service as needing no payment", async () => {
    const vet = await listedVet({ service: { ...VISIT, priceNgn: 0 } });
    const { appointment } = await booked(vet);
    expect(appointment).toMatchObject({ paymentStatus: "not_required", totalKobo: 0 });
  });

  it("returns the first booking for a repeated idempotency key", async () => {
    const vet = await listedVet();
    const buyer = await customer();
    const body = { serviceId: vet.service.id, startsAt: TUE_10, idempotencyKey: randomUUID() };
    const first = await book(buyer.cookie, body);
    const again = await book(buyer.cookie, body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(dataOf(again).appointment.id).toBe(dataOf(first).appointment.id);
    expect(await (await vetCollections()).appointments.countDocuments()).toBe(1);
    const changed = await book(buyer.cookie, { ...body, startsAt: TUE_11 });
    expect(changed.status).toBe(409);
    // the same key from another customer is their own booking
    const other = await customer();
    expect((await book(other.cookie, { ...body, startsAt: TUE_11 })).status).toBe(201);
  });

  it("lets only one of two simultaneous bookings take a time", async () => {
    const vet = await listedVet();
    const [a, b, c] = await Promise.all([customer(), customer(), customer()]);
    const results = await Promise.all(
      [a, b, c].map((who) => book(who.cookie, { serviceId: vet.service.id, startsAt: TUE_10 })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((r) => r.status === 409)) expect(errorOf(r)).toBe("That time is no longer available. Please choose another.");
    const { appointments, slots: holds } = await vetCollections();
    expect(await appointments.countDocuments()).toBe(1);
    expect(await holds.countDocuments()).toBe(2);
  });

  it("refuses an overlapping longer visit", async () => {
    const vet = await listedVet({ service: { ...VISIT, durationMinutes: 120 } });
    await booked(vet, undefined, TUE_11);
    const buyer = await customer();
    // 10:00 for two hours would overlap 11:00
    expect((await book(buyer.cookie, { serviceId: vet.service.id, startsAt: TUE_10 })).status).toBe(409);
  });

  it("refuses past, too-soon, out-of-hours, off-grid, blocked and out-of-window times", async () => {
    const vet = await listedVet({ settings: { blockedDates: ["2030-11-06"] } });
    const buyer = await customer();
    for (const startsAt of [
      "2030-11-03T09:00:00.000Z", // yesterday
      "2030-11-04T08:00:00.000Z", // 09:00 today: under 2 hours' notice
      "2030-11-05T06:00:00.000Z", // 07:00, before hours
      "2030-11-05T16:00:00.000Z", // 17:00, the visit would end after hours
      "2030-11-05T09:30:00.000Z", // not on the vet's 60-minute grid
      "2030-11-06T09:00:00.000Z", // a day off
      "2030-12-20T09:00:00.000Z", // beyond 30 days
    ]) {
      const res = await book(buyer.cookie, { serviceId: vet.service.id, startsAt });
      expect(res.status, startsAt).toBe(409);
    }
    for (const startsAt of ["2030-11-05T09:00:30.000Z", "tomorrow", 12, null])
      expect(fieldErrorsOf(await book(buyer.cookie, { serviceId: vet.service.id, startsAt }))).toHaveProperty("startsAt");
    expect(await (await vetCollections()).appointments.countDocuments()).toBe(0);
  });

  it("checks the service, the vet and the farm on the server", async () => {
    const vet = await listedVet();
    const buyer = await customer();
    expect((await book(vet.cookie, { serviceId: vet.service.id, startsAt: TUE_10 })).status).toBe(403);
    expect((await book(buyer.cookie, { serviceId: new ObjectId().toHexString(), startsAt: TUE_10 })).status).toBe(404);
    const someoneElse = await customer();
    const res = await book(buyer.cookie, { serviceId: vet.service.id, startsAt: TUE_10, farmId: someoneElse.farmId });
    expect(res.status).toBe(400);
    expect(fieldErrorsOf(res)).toHaveProperty("farmId");

    await callWith(patchServiceRoute, `/api/services/${vet.service.id}`, { id: vet.service.id }, {
      cookie: vet.cookie,
      method: "PATCH",
      body: { bookingAvailable: false },
    });
    expect((await book(buyer.cookie, { serviceId: vet.service.id, startsAt: TUE_10 })).status).toBe(409);
    for (const location of [{ ...LOCATION, address: "x" }, { ...LOCATION, state: "atlantis" }, {}])
      expect((await book(buyer.cookie, { serviceId: vet.service.id, startsAt: TUE_10, location })).status).toBe(400);
    expect((await book(buyer.cookie, { serviceId: vet.service.id, startsAt: TUE_10, idempotencyKey: "abc" })).status).toBe(400);
  });

  it("needs a verified session and a same-origin request", async () => {
    const vet = await listedVet();
    const body = { serviceId: vet.service.id, startsAt: TUE_10, location: LOCATION, idempotencyKey: randomUUID() };
    expect((await call(bookRoute, "/api/appointments", { body })).status).toBe(401);
    const { pendingCookie } = await registerPending();
    expect((await call(bookRoute, "/api/appointments", { body, cookie: pendingCookie })).status).toBe(403);
    const buyer = await customer();
    expect((await call(bookRoute, "/api/appointments", { body, cookie: buyer.cookie, origin: "https://evil.example" })).status).toBe(403);
  });
});

// =====================================================================================

describe("the appointment and its status", () => {
  it("is visible to its customer and vet only", async () => {
    const vet = await listedVet();
    const { buyer, appointment } = await booked(vet);
    expect(dataOf(await read(buyer.cookie, appointment.id)).appointment.viewer).toBe("customer");
    expect(dataOf(await read(vet.cookie, appointment.id)).appointment.viewer).toBe("vet");
    const stranger = await customer();
    expect((await read(stranger.cookie, appointment.id)).status).toBe(404);
    expect((await move(stranger.cookie, appointment.id, "cancel", "requested")).status).toBe(404);
    expect((await read(stranger.cookie, "not-an-id")).status).toBe(404);

    const mine = dataOf(await call<AppointmentListResponse>(listRoute, "/api/appointments", { cookie: buyer.cookie }));
    expect(mine.appointments.map((a) => a.id)).toEqual([appointment.id]);
    const jobs = dataOf(await call<AppointmentListResponse>(listRoute, "/api/appointments?as=vet", { cookie: vet.cookie }));
    expect(jobs.appointments.map((a) => a.id)).toEqual([appointment.id]);
    expect(dataOf(await call<AppointmentListResponse>(listRoute, "/api/appointments?as=vet", { cookie: stranger.cookie })).appointments).toEqual([]);
    expect((await call(listRoute, "/api/appointments?as=admin", { cookie: buyer.cookie })).status).toBe(400);
    expect((await call(listRoute, "/api/appointments?cursor=junk", { cookie: buyer.cookie })).status).toBe(400);
  });

  it("goes requested → confirmed → on the way → in progress → completed, by the vet only", async () => {
    const vet = await listedVet();
    const { buyer, appointment } = await booked(vet);
    const id = appointment.id;
    // the customer can't accept their own request; the vet's view hides the customer's phone until they accept
    expect((await move(buyer.cookie, id, "accept", "requested")).status).toBe(409);
    expect(dataOf(await read(vet.cookie, id)).appointment.customer.phone).toBeNull();

    const accepted = await move(vet.cookie, id, "accept", "requested");
    expect(accepted.status).toBe(200);
    expect(dataOf(accepted).appointment).toMatchObject({ bookingStatus: "confirmed", paymentStatus: "payment_required" });
    expect(dataOf(accepted).appointment.customer.phone).toBe(buyer.phone);
    // priced: accepted, but never "Booking confirmed" while payment is outside the app
    expect(isFullyConfirmed(dataOf(accepted).appointment)).toBe(false);
    // the vet's phone isn't shared unless they chose to share it
    expect(dataOf(await read(buyer.cookie, id)).appointment.vet.phone).toBeNull();

    // a repeated (stale) accept changes nothing
    expect((await move(vet.cookie, id, "accept", "requested")).status).toBe(409);
    expect((await move(buyer.cookie, id, "en_route", "confirmed")).status).toBe(409);
    expect((await move(vet.cookie, id, "complete", "confirmed")).status).toBe(409);

    expect((await move(vet.cookie, id, "en_route", "confirmed")).status).toBe(200);
    expect((await move(vet.cookie, id, "start", "en_route")).status).toBe(200);
    // completing needs the visit record finished first (docs/vet-job-workflow.md)
    expect((await move(vet.cookie, id, "complete", "in_progress")).status).toBe(409);
    for (const itemId of ["arrived", "assessment", "service", "records"]) {
      const ticked = await callWith(checklistRoute, `/api/appointments/${id}/visit/checklist`, { id }, {
        cookie: vet.cookie,
        body: { itemId, done: true },
      });
      expect(ticked.status).toBe(200);
    }
    const noted = await callWith(notesRoute, `/api/appointments/${id}/visit/notes`, { id }, {
      cookie: vet.cookie,
      method: "PUT",
      body: { notes: { observations: "Flock alert and feeding well." }, expectedVersion: 0 },
    });
    expect(noted.status).toBe(200);
    const done = await move(vet.cookie, id, "complete", "in_progress", { reason: "Vaccinated 2,000 birds." });
    expect(dataOf(done).appointment).toMatchObject({ bookingStatus: "completed", actions: [] });
    // completed is final
    for (const action of ["cancel", "start", "accept"]) expect((await move(vet.cookie, id, action, "completed")).status).toBe(409);
    expect(dataOf(await read(vet.cookie, id)).appointment.customer.phone).toBeNull();

    const history = dataOf(await read(buyer.cookie, id)).appointment.history;
    expect(history.map((h) => [h.status, h.by])).toEqual([
      ["requested", "customer"],
      ["confirmed", "vet"],
      ["en_route", "vet"],
      ["in_progress", "vet"],
      ["completed", "vet"],
    ]);
    expect(history.every((h) => !Number.isNaN(Date.parse(h.at)))).toBe(true);
    expect(history[4].note).toBe("Vaccinated 2,000 birds.");
  });

  it("shows a free, accepted visit as confirmed and shares the vet's phone when they allow it", async () => {
    const vet = await listedVet({ service: { ...VISIT, priceNgn: 0 }, settings: { sharePhoneWithClients: true } });
    const { buyer, appointment } = await booked(vet);
    expect(dataOf(await read(buyer.cookie, appointment.id)).appointment.vet.phone).toBeNull();
    const accepted = dataOf(await move(vet.cookie, appointment.id, "accept", "requested")).appointment;
    expect(isFullyConfirmed(accepted)).toBe(true);
    const seen = dataOf(await read(buyer.cookie, appointment.id)).appointment;
    expect(seen.vet.phone).toMatch(/^\+234/);
  });

  it("refuses accepting once the vet's credential is no longer verified", async () => {
    const vet = await listedVet();
    const { appointment } = await booked(vet);
    await (await collections()).users.updateOne({ _id: vet.userId }, { $set: { "profile.credentialStatus": "rejected" } });
    expect((await move(vet.cookie, appointment.id, "accept", "requested")).status).toBe(403);
  });

  it("frees the time when the vet declines or the customer cancels", async () => {
    const vet = await listedVet();
    const { buyer, appointment } = await booked(vet);
    const declined = await move(vet.cookie, appointment.id, "decline", "requested", { reason: "Away that day." });
    expect(dataOf(declined).appointment.bookingStatus).toBe("declined");
    expect(await holdsFor(appointment.id)).toBe(0);
    expect((await move(buyer.cookie, appointment.id, "cancel", "declined")).status).toBe(409);

    const again = await booked(vet, buyer);
    expect(await holdsFor(again.appointment.id)).toBe(2);
    expect((await move(buyer.cookie, again.appointment.id, "cancel", "requested")).status).toBe(200);
    expect(await holdsFor(again.appointment.id)).toBe(0);
    await booked(vet);
  });

  it("lets the customer cancel an accepted visit only until 2 hours before it", async () => {
    const vet = await listedVet();
    const { buyer, appointment } = await booked(vet);
    await move(vet.cookie, appointment.id, "accept", "requested");
    expect(dataOf(await read(buyer.cookie, appointment.id)).appointment.actions).toEqual(["cancel"]);

    vi.setSystemTime(new Date(Date.parse(TUE_10) - 2 * HOUR + 60_000));
    const late = dataOf(await read(buyer.cookie, appointment.id)).appointment;
    expect(late.actions).toEqual([]);
    expect((await move(buyer.cookie, appointment.id, "cancel", "confirmed")).status).toBe(409);
    // the vet can still cancel, which frees the time
    expect((await move(vet.cookie, appointment.id, "cancel", "confirmed")).status).toBe(200);
    expect(await holdsFor(appointment.id)).toBe(0);
  });

  it("lets an unanswered request lapse and gives the time back", async () => {
    const vet = await listedVet();
    // a booking 3 days out lapses after 24 hours
    const { buyer, appointment } = await booked(vet, undefined, "2030-11-07T09:00:00.000Z");
    expect(appointment.respondBy).toBe(new Date(Date.parse(appointment.createdAt) + 24 * HOUR).toISOString());

    expect((await runJob(null)).status).toBe(401);
    expect((await runJob("Bearer wrong-secret")).status).toBe(401);
    let res = await runJob();
    expect(((await res.json()) as { data: { expired: number } }).data.expired).toBe(0);

    vi.setSystemTime(new Date(Date.parse(appointment.respondBy) + 60_000));
    // too late to accept, even before the job runs
    const late = await move(vet.cookie, appointment.id, "accept", "requested");
    expect(late.status).toBe(409);
    expect(dataOf(await read(buyer.cookie, appointment.id)).appointment.bookingStatus).toBe("expired");
    expect(await holdsFor(appointment.id)).toBe(0);
    res = await runJob();
    expect(((await res.json()) as { data: { expired: number } }).data.expired).toBe(0);

    const history = dataOf(await read(buyer.cookie, appointment.id)).appointment.history;
    expect(history.map((h) => [h.status, h.by])).toEqual([
      ["requested", "customer"],
      ["expired", "system"],
    ]);
  });

  it("expires through the job, once", async () => {
    const vet = await listedVet();
    const { appointment } = await booked(vet, undefined, "2030-11-07T09:00:00.000Z");
    vi.setSystemTime(new Date(Date.parse(appointment.respondBy) + 60_000));
    const res = await runJob();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { expired: number } }).data.expired).toBe(1);
    expect(await holdsFor(appointment.id)).toBe(0);
    const again = await runJob();
    expect(((await again.json()) as { data: { expired: number } }).data.expired).toBe(0);
  });

  it("sends each notification once", async () => {
    const vet = await listedVet();
    const { buyer, appointment } = await booked(vet);
    await move(vet.cookie, appointment.id, "accept", "requested");
    const { notifications } = await collections();
    const forVet = () => notifications.find({ recipientUserId: vet.userId, type: { $regex: /^appointment_/ } }).toArray();
    const forBuyer = () => notifications.find({ recipientUserId: buyer.userId, type: { $regex: /^appointment_/ } }).toArray();
    expect((await forVet()).map((n) => n.type)).toEqual(["appointment_requested"]);
    expect((await forBuyer()).map((n) => n.type)).toEqual(["appointment_confirmed"]);
    // the priced visit isn't announced as a confirmed booking
    expect((await forBuyer())[0].title).toBe("Vet accepted your request");

    // a repeated sync (as the notification job would do after a crash) adds nothing
    const { appointments } = await vetCollections();
    await appointments.updateOne({ _id: new ObjectId(appointment.id) }, { $set: { notifiedThrough: 0, notifySyncAt: new Date() } });
    await syncAppointmentNotifications(new ObjectId(appointment.id));
    await syncAppointmentNotifications(new ObjectId(appointment.id));
    expect(await forVet()).toHaveLength(1);
    expect(await forBuyer()).toHaveLength(1);
  });

  it("validates transitions", async () => {
    const vet = await listedVet();
    const { appointment } = await booked(vet);
    for (const body of [
      { action: "teleport", expectedStatus: "requested" },
      { action: "accept", expectedStatus: "bogus" },
      { action: "decline", expectedStatus: "requested", reason: 5 },
      { action: "decline", expectedStatus: "requested", reason: "x".repeat(201) },
    ]) {
      const res = await callWith(transitionRoute, `/api/appointments/${appointment.id}`, { id: appointment.id }, {
        cookie: vet.cookie,
        method: "PATCH",
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(dataOf(await read(vet.cookie, appointment.id)).appointment.bookingStatus).toBe("requested");
  });
});
