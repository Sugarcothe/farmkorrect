import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as decideRoute } from "@/app/api/admin/credentials/[userId]/route";
import { GET as appointmentRoute, PATCH as transitionRoute } from "@/app/api/appointments/[id]/route";
import { GET as listRoute, POST as bookRoute } from "@/app/api/appointments/route";
import { POST as checklistRoute } from "@/app/api/appointments/[id]/visit/checklist/route";
import { PUT as notesRoute } from "@/app/api/appointments/[id]/visit/notes/route";
import { GET as visitRoute } from "@/app/api/appointments/[id]/visit/route";
import { PUT as availabilityRoute } from "@/app/api/availability/route";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { POST as createServiceRoute } from "@/app/api/services/route";
import { JobCard } from "@/components/vets/vet-parts";
import { elapsedLabel, VisitTimer } from "@/components/vets/visit-timer";
import { jobTabCounts } from "@/lib/server/appointments";
import { COLLECTIONS, type AppointmentDoc } from "@/lib/server/models";
import { appointmentEventSpecs, syncAppointmentNotifications } from "@/lib/server/notifications";
import { LIMITS } from "@/lib/server/rate-limit";
import type { ServiceResponse } from "@/lib/services/types";
import type { AppointmentListResponse, AppointmentResponse, AppointmentSummary } from "@/lib/vets/types";
import { checklistTemplate, missingForCompletion, VISIT_TEMPLATE_VERSION, type VisitResponse } from "@/lib/vets/visit";
import { getDb } from "@/lib/server/db";
import { collections } from "./support/db";
import { FARM, newRegistration, registerWithFarm } from "./support/flows";
import { call, dataOf, type CallOptions, type CallResult } from "./support/http";
import { merchant } from "./support/wallet";

// The vet's side of an appointment: the job tabs, the job offer, the visit
// record (checklist and private clinical notes) and completion, against the
// real route handlers and an in-memory replica set. Date is fixed at Monday
// 4 Nov 2030, 08:00 in Lagos (the driver keeps real timers).

const MONDAY_8AM = new Date("2030-11-04T07:00:00.000Z");
const TUE_10 = "2030-11-05T09:00:00.000Z";
const TUE_11 = "2030-11-05T10:00:00.000Z";
const TUE_12 = "2030-11-05T11:00:00.000Z";
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
const VACCINATION = { ...VISIT, name: "Newcastle vaccination round", category: "vaccination" };
const LOCATION = {
  address: "Km 5 Ife Road, Ibadan",
  state: "oyo",
  directions: "Second gate after the filling station.",
};
const SECRET_NOTE = "Mild respiratory signs in house 3; private-marker-7f3a";

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

// --- accounts --------------------------------------------------------------------

let admin: Awaited<ReturnType<typeof merchant>> | null = null;
beforeEach(() => {
  admin = null;
});

async function listedVet(service: object = VISIT) {
  const vet = await merchant("veterinarian");
  const profile = await call(patchProfile, "/api/profile", {
    body: {
      registrationNumber: "VCN/12345",
      specialization: "poultry-medicine",
      qualifications: "DVM, University of Ibadan",
      yearsOfExperience: 6,
    },
    cookie: vet.cookie,
    method: "PATCH",
  });
  expect(profile.status).toBe(200);
  if (!admin) {
    admin = await merchant("poultry-farmer");
    vi.stubEnv("ADMIN_USER_IDS", admin.userId.toHexString());
  }
  const user = await (await collections()).users.findOne({ _id: vet.userId });
  const id = vet.userId.toHexString();
  const decided = await callWith(
    decideRoute,
    `/api/admin/credentials/${id}`,
    { userId: id },
    {
      cookie: admin.cookie,
      body: { decision: "approve", submittedAt: user!.profile!.credentialSubmittedAt!.toISOString() },
    },
  );
  expect(decided.status).toBe(200);
  const created = await call<ServiceResponse>(createServiceRoute, "/api/services", {
    body: service,
    cookie: vet.cookie,
  });
  expect(created.status).toBe(201);
  const saved = await call(availabilityRoute, "/api/availability", {
    body: SETTINGS,
    cookie: vet.cookie,
    method: "PUT",
  });
  expect(saved.status).toBe(200);
  return { ...vet, service: dataOf(created).service };
}
type Vet = Awaited<ReturnType<typeof listedVet>>;

async function customer() {
  const { input, cookie } = await registerWithFarm(newRegistration());
  const { users, farms } = await collections();
  const user = await users.findOne({ phoneNormalized: input.phone });
  const farm = await farms.findOne({ ownerUserId: user!._id });
  return { cookie, userId: user!._id, farmId: farm!._id.toHexString() };
}
type Customer = Awaited<ReturnType<typeof customer>>;

// --- calls -------------------------------------------------------------------------

async function booked(vet: Vet, who?: Customer, startsAt = TUE_10, linkFarm = true) {
  const buyer = who ?? (await customer());
  const res = await call<AppointmentResponse>(bookRoute, "/api/appointments", {
    cookie: buyer.cookie,
    body: {
      serviceId: vet.service.id,
      startsAt,
      location: { ...LOCATION, farmName: FARM.farmName },
      idempotencyKey: randomUUID(),
      ...(linkFarm ? { farmId: buyer.farmId } : {}),
    },
  });
  expect(res.status).toBe(201);
  return { buyer, id: dataOf(res).appointment.id };
}

const read = (cookie: string, id: string) =>
  callWith<AppointmentResponse, { id: string }>(appointmentRoute, `/api/appointments/${id}`, { id }, { cookie });
const move = (cookie: string, id: string, action: string, expectedStatus: string, extra: object = {}) =>
  callWith<AppointmentResponse, { id: string }>(
    transitionRoute,
    `/api/appointments/${id}`,
    { id },
    {
      cookie,
      method: "PATCH",
      body: { action, expectedStatus, ...extra },
    },
  );
const tick = (cookie: string | undefined, id: string, body: object, options: CallOptions = {}) =>
  callWith<VisitResponse, { id: string }>(
    checklistRoute,
    `/api/appointments/${id}/visit/checklist`,
    { id },
    {
      cookie,
      body,
      ...options,
    },
  );
const saveNotes = (cookie: string | undefined, id: string, body: object, options: CallOptions = {}) =>
  callWith<VisitResponse, { id: string }>(
    notesRoute,
    `/api/appointments/${id}/visit/notes`,
    { id },
    {
      cookie,
      method: "PUT",
      body,
      ...options,
    },
  );
const readVisit = (cookie: string | undefined, id: string) =>
  callWith<VisitResponse, { id: string }>(visitRoute, `/api/appointments/${id}/visit`, { id }, { cookie });
const jobs = (cookie: string, tab: string, cursor?: string) =>
  call<AppointmentListResponse>(
    listRoute,
    `/api/appointments?as=vet&tab=${tab}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    { cookie },
  );

/** Booked, accepted, on the way and started: a visit in progress. */
async function started(service: object = VISIT) {
  const vet = await listedVet(service);
  const { buyer, id } = await booked(vet);
  expect((await move(vet.cookie, id, "accept", "requested")).status).toBe(200);
  expect((await move(vet.cookie, id, "en_route", "confirmed")).status).toBe(200);
  expect((await move(vet.cookie, id, "start", "en_route")).status).toBe(200);
  return { vet, buyer, id };
}

async function finishRecord(cookie: string, id: string) {
  for (const itemId of ["arrived", "assessment", "service", "records"])
    expect((await tick(cookie, id, { itemId, done: true })).status).toBe(200);
  const current = dataOf(await readVisit(cookie, id)).visit;
  const res = await saveNotes(cookie, id, {
    notes: { observations: SECRET_NOTE },
    expectedVersion: current.notesVersion,
  });
  expect(res.status).toBe(200);
}

const rawAppointment = async (id: string) =>
  (await (await getDb()).collection<AppointmentDoc>(COLLECTIONS.appointments).findOne({ _id: new ObjectId(id) }))!;

// --- My Jobs ---------------------------------------------------------------------------

describe("My Jobs tabs", () => {
  it("filters by tab on the server, for the session's vet only, with the customer's flock", async () => {
    const vet = await listedVet();
    const other = await listedVet();
    const buyer = await customer();
    const pending = await booked(vet, buyer, TUE_10);
    const active = await booked(vet, buyer, TUE_11);
    const declined = await booked(vet, buyer, TUE_12, false);
    await booked(other, undefined, TUE_10);
    expect((await move(vet.cookie, active.id, "accept", "requested")).status).toBe(200);
    expect((await move(vet.cookie, declined.id, "decline", "requested", { reason: "Away that day." })).status).toBe(
      200,
    );

    const ids = async (tab: string) => dataOf(await jobs(vet.cookie, tab)).appointments.map((a) => a.id);
    expect(await ids("pending")).toEqual([pending.id]);
    expect(await ids("active")).toEqual([active.id]);
    // declined is closed, never "completed"
    expect(await ids("completed")).toEqual([]);
    expect(await ids("closed")).toEqual([declined.id]);
    expect(await jobTabCounts({ _id: vet.userId })).toEqual({ pending: 1, active: 1 });
    expect(await jobTabCounts({ _id: other.userId })).toEqual({ pending: 1, active: 0 });

    const [card] = dataOf(await jobs(vet.cookie, "pending")).appointments;
    expect(card).toMatchObject({
      reference: expect.any(String),
      farmName: FARM.farmName,
      serviceName: VISIT.name,
      bookingStatus: "requested",
      farm: { farmType: FARM.farmType, birdCount: FARM.birdCount },
    });
    // a booking not linked to a farm record has no flock rather than a made-up one
    expect(dataOf(await jobs(vet.cookie, "closed")).appointments[0].farm).toBeNull();
  });

  it("rejects job tabs for customers and unknown tabs", async () => {
    const buyer = await customer();
    const res = await call(listRoute, "/api/appointments?tab=pending", { cookie: buyer.cookie });
    expect(res.status).toBe(400);
    const vet = await listedVet();
    expect((await jobs(vet.cookie, "everything")).status).toBe(400);
    expect((await call(listRoute, "/api/appointments?as=vet&tab=pending")).status).toBe(401);
  });

  it("pages each tab with its own cursor, soonest first for active work", async () => {
    const vet = await listedVet();
    const { id } = await booked(vet);
    expect((await move(vet.cookie, id, "accept", "requested")).status).toBe(200);
    const template = await rawAppointment(id);
    const appointments = (await getDb()).collection<AppointmentDoc>(COLLECTIONS.appointments);
    const starts = Array.from({ length: 22 }, (_, i) => new Date(Date.parse("2030-12-01T09:00:00Z") + i * 86_400_000));
    await appointments.insertMany(
      starts.map((startsAt) => ({
        ...template,
        _id: new ObjectId(),
        reference: new ObjectId().toHexString(),
        idempotencyKey: new ObjectId().toHexString(),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
      })),
    );

    const first = dataOf(await jobs(vet.cookie, "active"));
    expect(first.appointments).toHaveLength(20);
    expect(first.appointments[0].id).toBe(id); // TUE_10 is the soonest
    const times = first.appointments.map((a) => Date.parse(a.startsAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const second = dataOf(await jobs(vet.cookie, "active", first.nextCursor!));
    expect(second.appointments).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    const all = [...first.appointments, ...second.appointments].map((a) => a.id);
    expect(new Set(all).size).toBe(23);

    // a cursor is tied to its tab and view
    expect((await jobs(vet.cookie, "completed", first.nextCursor!)).status).toBe(400);
    const plain = await call(listRoute, `/api/appointments?as=vet&cursor=${encodeURIComponent(first.nextCursor!)}`, {
      cookie: vet.cookie,
    });
    expect(plain.status).toBe(400);
  });

  it("renders a job card from real data only: no distance, map or arrival time", () => {
    const job: AppointmentSummary = {
      id: new ObjectId().toHexString(),
      reference: "FK-VET-7Q2M",
      viewer: "vet",
      startsAt: TUE_10,
      bookingStatus: "requested",
      paymentStatus: "payment_required",
      totalKobo: 1_500_000,
      serviceName: VISIT.name,
      otherParty: "Adaeze Okafor",
      farmName: "Green Acres",
      farm: { farmType: "layer", birdCount: 1200 },
    };
    const html = renderToStaticMarkup(createElement(JobCard, { job, href: `/appointments/${job.id}?from=pending` }));
    expect(html).toContain("FK-VET-7Q2M");
    expect(html).toContain("Adaeze Okafor");
    expect(html).toContain("Green Acres");
    expect(html).toContain("Layer · 1,200 birds");
    expect(html).toContain("Pending");
    expect(html).toContain("View details");
    expect(html).toContain("?from=pending");
    expect(html).not.toMatch(/\b(km|ETA|away|arrives?|distance)\b/i);
    const unlinked = renderToStaticMarkup(createElement(JobCard, { job: { ...job, farm: null }, href: "/x" }));
    expect(unlinked).toContain("Flock details not linked");
  });
});

// --- the job offer -----------------------------------------------------------------------

describe("Job offer", () => {
  it("shows the vet what they need to decide, with the real respond-by time", async () => {
    const vet = await listedVet();
    const { id } = await booked(vet);
    const offer = dataOf(await read(vet.cookie, id)).appointment;
    expect(offer).toMatchObject({
      viewer: "vet",
      bookingStatus: "requested",
      location: { farmName: FARM.farmName, address: LOCATION.address, directions: LOCATION.directions },
      farm: { farmType: FARM.farmType, birdCount: FARM.birdCount },
      service: { durationMinutes: 60 },
      startedAt: null,
      completedAt: null,
      visit: null,
    });
    expect(offer.actions.sort()).toEqual(["accept", "decline"]);
    expect(Date.parse(offer.respondBy)).toBeGreaterThan(MONDAY_8AM.getTime());
  });

  it("refuses a stale accept after the vet declined, and tells the customer once", async () => {
    const vet = await listedVet();
    const { buyer, id } = await booked(vet);
    expect((await move(vet.cookie, id, "decline", "requested", { reason: "Fully booked." })).status).toBe(200);
    const stale = await move(vet.cookie, id, "accept", "requested");
    expect(stale.status).toBe(409);
    expect(dataOf(await read(vet.cookie, id)).appointment.bookingStatus).toBe("declined");
    await syncAppointmentNotifications(new ObjectId(id));
    const { notifications } = await collections();
    const told = await notifications.find({ recipientUserId: buyer.userId, type: "appointment_declined" }).toArray();
    expect(told).toHaveLength(1);
  });

  it("ignores status, timestamps and visit data sent by the browser", async () => {
    const vet = await listedVet();
    const { id } = await booked(vet);
    const res = await move(vet.cookie, id, "accept", "requested", {
      bookingStatus: "completed",
      startedAt: "2020-01-01T00:00:00Z",
      visit: { checklist: [] },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).appointment).toMatchObject({ bookingStatus: "confirmed", startedAt: null, visit: null });
  });
});

// --- the visit -------------------------------------------------------------------------------

describe("Appointment progress", () => {
  it("records the start once and snapshots the checklist for the service", async () => {
    const { vet, buyer, id } = await started();
    const doc = await rawAppointment(id);
    const startEntry = doc.history.find((h) => h.status === "in_progress")!;
    expect(doc.startedAt?.toISOString()).toBe(startEntry.at.toISOString());
    expect(doc.visit).toMatchObject({
      template: { category: "consultation", version: VISIT_TEMPLATE_VERSION },
      vaccineDetails: false,
      notesVersion: 0,
    });
    expect(doc.visit!.checklist.map((i) => [i.id, i.required, i.doneAt])).toEqual(
      checklistTemplate("consultation").map((i) => [i.id, i.required, null]),
    );

    const seen = dataOf(await read(vet.cookie, id)).appointment;
    expect(seen.startedAt).toBe(startEntry.at.toISOString());
    expect(seen.visit).toMatchObject({ stored: true, editable: true });
    // the customer sees that it started, never the record
    const theirs = dataOf(await read(buyer.cookie, id)).appointment;
    expect(theirs.startedAt).toBe(startEntry.at.toISOString());
    expect(theirs.visit).toBeNull();

    // the customer hears that it started, once
    await syncAppointmentNotifications(new ObjectId(id));
    const { notifications } = await collections();
    const told = await notifications.find({ recipientUserId: buyer.userId, type: "appointment_started" }).toArray();
    expect(told).toHaveLength(1);
    expect(told[0].title).toBe("Visit started");
  });

  it("keeps a started visit's checklist even if the template changes later", async () => {
    const { vet, id } = await started();
    const appointments = (await getDb()).collection<AppointmentDoc>(COLLECTIONS.appointments);
    // an older snapshot with an item the current template doesn't have
    await appointments.updateOne(
      { _id: new ObjectId(id) },
      {
        $push: {
          "visit.checklist": { id: "legacy-step", label: "Old step", required: false, doneAt: null, doneBy: null },
        },
      },
    );
    expect((await tick(vet.cookie, id, { itemId: "legacy-step", done: true })).status).toBe(200);
  });

  it("gives vaccination visits the vaccine fields", async () => {
    const { vet, id } = await started(VACCINATION);
    const visit = dataOf(await readVisit(vet.cookie, id)).visit;
    expect(visit.vaccineDetails).toBe(true);
    expect(visit.checklist.find((i) => i.id === "service")!.label).toBe("Vaccine administered as agreed");
    const res = await saveNotes(vet.cookie, id, {
      notes: {
        vaccineProduct: "  Lasota ND  ",
        vaccineBatch: "B-2291",
        vaccineAdministration: "Drinking water, 2,000 birds",
      },
      expectedVersion: 0,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res).visit.notes).toMatchObject({ vaccineProduct: "Lasota ND", vaccineBatch: "B-2291" });
  });
});

describe("Visit timer", () => {
  it("formats elapsed time", () => {
    expect(elapsedLabel(0)).toBe("00:00");
    expect(elapsedLabel(65_000)).toBe("01:05");
    expect(elapsedLabel(3_909_000)).toBe("1:05:09");
    expect(elapsedLabel(-5_000)).toBe("00:00");
  });

  it("counts from the stored start, without announcing every second", () => {
    const html = renderToStaticMarkup(
      createElement(VisitTimer, {
        startedAt: "2030-11-05T09:00:00.000Z",
        serverNow: "2030-11-05T09:12:30.000Z",
        plannedMinutes: 60,
        running: true,
      }),
    );
    expect(html).toContain("12:30");
    expect(html).toMatch(/aria-hidden="true"[^>]*>12:30/);
    expect(html).not.toContain("aria-live");
    expect(html).toContain("Planned length");
  });

  it("says honestly when the start can't be established", () => {
    const html = renderToStaticMarkup(
      createElement(VisitTimer, { startedAt: null, serverNow: TUE_10, plannedMinutes: null, running: true }),
    );
    expect(html).toContain("Elapsed time unavailable");
    expect(html).not.toMatch(/\d\d:\d\d/);
    expect(html).not.toContain("Planned length");
  });
});

describe("Visit checklist", () => {
  it("records who ticked an item and when, and a repeat changes nothing", async () => {
    const { vet, id } = await started();
    const first = await tick(vet.cookie, id, { itemId: "arrived", done: true, doneBy: new ObjectId().toHexString() });
    expect(first.status).toBe(200);
    const doc = await rawAppointment(id);
    const item = doc.visit!.checklist.find((i) => i.id === "arrived")!;
    expect(item.doneBy?.equals(vet.userId)).toBe(true);
    expect(item.doneAt).toBeInstanceOf(Date);

    vi.setSystemTime(new Date(MONDAY_8AM.getTime() + 60_000));
    const again = await tick(vet.cookie, id, { itemId: "arrived", done: true });
    expect(again.status).toBe(200);
    const after = (await rawAppointment(id)).visit!.checklist.find((i) => i.id === "arrived")!;
    expect(after.doneAt!.toISOString()).toBe(item.doneAt!.toISOString());

    const cleared = await tick(vet.cookie, id, { itemId: "arrived", done: false });
    expect(dataOf(cleared).visit.checklist.find((i) => i.id === "arrived")!.doneAt).toBeNull();
  });

  it("refuses items that aren't on this visit's checklist and malformed input", async () => {
    const { vet, id } = await started();
    const unknown = await tick(vet.cookie, id, { itemId: "give-antibiotics", done: true });
    expect(unknown.status).toBe(400);
    expect(fieldErrorsOf(unknown).itemId).toBeTruthy();
    expect((await tick(vet.cookie, id, { itemId: "arrived", done: "yes" })).status).toBe(400);
    expect((await tick(vet.cookie, id, { itemId: "../$where", done: true })).status).toBe(400);
  });

  it("is only for the appointment's own vet, signed in, from this site", async () => {
    const { buyer, id } = await started();
    const stranger = await listedVet();
    expect((await tick(undefined, id, { itemId: "arrived", done: true })).status).toBe(401);
    expect((await tick(buyer.cookie, id, { itemId: "arrived", done: true })).status).toBe(404);
    expect((await tick(stranger.cookie, id, { itemId: "arrived", done: true })).status).toBe(404);
    expect((await tick(stranger.cookie, new ObjectId().toHexString(), { itemId: "arrived", done: true })).status).toBe(
      404,
    );
    expect((await tick(stranger.cookie, "not-an-id", { itemId: "arrived", done: true })).status).toBe(404);
    const cross = await tick(
      stranger.cookie,
      id,
      { itemId: "arrived", done: true },
      { origin: "https://evil.example" },
    );
    expect(cross.status).toBe(403);
    expect((await readVisit(buyer.cookie, id)).status).toBe(404);
    expect((await readVisit(stranger.cookie, id)).status).toBe(404);
    expect((await readVisit(undefined, id)).status).toBe(401);
    // nothing changed
    expect((await rawAppointment(id)).visit!.checklist.every((i) => i.doneAt === null)).toBe(true);
  });

  it("can't be changed before the visit starts", async () => {
    const vet = await listedVet();
    const { id } = await booked(vet);
    expect((await move(vet.cookie, id, "accept", "requested")).status).toBe(200);
    expect((await tick(vet.cookie, id, { itemId: "arrived", done: true })).status).toBe(409);
    expect((await readVisit(vet.cookie, id)).status).toBe(404);
  });

  it("is rate limited per user", () => {
    expect(LIMITS.appointmentVisitWritesPerUser).toEqual({ limit: 600, windowMs: 60 * 60_000 });
  });
});

describe("Clinical notes", () => {
  it("saves with a version, normalises text and enforces lengths", async () => {
    const { vet, id } = await started();
    const res = await saveNotes(vet.cookie, id, {
      notes: { observations: "  Birds alert.\r\n\r\n\r\n\r\nGood feed intake.  ", findings: "" },
      expectedVersion: 0,
    });
    expect(res.status).toBe(200);
    const visit = dataOf(res).visit;
    expect(visit.notesVersion).toBe(1);
    expect(visit.notes.observations.startsWith("Birds alert.")).toBe(true);
    expect(visit.notes.observations.endsWith("Good feed intake.")).toBe(true);
    expect(Date.parse(visit.notesUpdatedAt!)).toBeGreaterThanOrEqual(MONDAY_8AM.getTime());
    const stored = (await rawAppointment(id)).visit!;
    expect(stored.notesUpdatedBy?.equals(vet.userId)).toBe(true);

    const long = await saveNotes(vet.cookie, id, { notes: { followUp: "x".repeat(1001) }, expectedVersion: 1 });
    expect(long.status).toBe(400);
    expect(fieldErrorsOf(long).followUp).toContain("1000");
    const unknown = await saveNotes(vet.cookie, id, { notes: { dosage: "10ml" }, expectedVersion: 1 });
    expect(unknown.status).toBe(400);
    const noVersion = await saveNotes(vet.cookie, id, { notes: { findings: "ok" } });
    expect(noVersion.status).toBe(400);
    // vaccine fields belong to vaccination visits only
    const vaccine = await saveNotes(vet.cookie, id, { notes: { vaccineProduct: "Lasota" }, expectedVersion: 1 });
    expect(vaccine.status).toBe(400);
    expect(fieldErrorsOf(vaccine).vaccineProduct).toBeTruthy();
  });

  it("refuses a save based on an older version, but accepts a retry of the same save", async () => {
    const { vet, id } = await started();
    const body = { notes: { observations: "First draft." }, expectedVersion: 0 };
    expect((await saveNotes(vet.cookie, id, body)).status).toBe(200);
    // the same request again (a retry after a dropped response) changes nothing
    const retry = await saveNotes(vet.cookie, id, body);
    expect(retry.status).toBe(200);
    expect(dataOf(retry).visit.notesVersion).toBe(1);
    // a different save from an out-of-date screen is a conflict
    const stale = await saveNotes(vet.cookie, id, { notes: { observations: "Other tab." }, expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(fieldErrorsOf(stale).expectedVersion).toBeTruthy();
    expect(errorOf(stale)).not.toContain("Other tab.");
    expect((await rawAppointment(id)).visit!.notes.observations).toBe("First draft.");
  });

  it("never reaches the customer, notifications, URLs or logs", async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(capture),
    );
    try {
      const { vet, buyer, id } = await started();
      await finishRecord(vet.cookie, id);
      // a rejected save and a conflict, which go through the error path
      await saveNotes(vet.cookie, id, { notes: { observations: SECRET_NOTE + "x".repeat(2100) }, expectedVersion: 1 });
      await saveNotes(vet.cookie, id, { notes: { observations: `${SECRET_NOTE} v2` }, expectedVersion: 0 });
      expect((await move(vet.cookie, id, "complete", "in_progress")).status).toBe(200);
      await syncAppointmentNotifications(new ObjectId(id));

      const forCustomer = await read(buyer.cookie, id);
      expect(JSON.stringify(forCustomer.json)).not.toContain("private-marker-7f3a");
      expect(dataOf(forCustomer).appointment.visit).toBeNull();
      const list = await call(listRoute, "/api/appointments", { cookie: buyer.cookie });
      expect(JSON.stringify(list.json)).not.toContain("private-marker-7f3a");

      const { notifications } = await collections();
      const all = await notifications.find({ "subject.id": id }).toArray();
      expect(all.length).toBeGreaterThan(0);
      expect(JSON.stringify(all)).not.toContain("private-marker-7f3a");
      expect(all.every((n) => !(n.url ?? "").includes("private"))).toBe(true);
      const doc = await rawAppointment(id);
      for (let i = 0; i < doc.history.length; i++)
        expect(JSON.stringify(appointmentEventSpecs(doc, i))).not.toContain("private-marker-7f3a");

      expect(logged.join("\n")).not.toContain("private-marker-7f3a");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// --- completion ----------------------------------------------------------------------------

describe("Completing a visit", () => {
  it("is refused until the required steps and observations are recorded, and says what's missing", async () => {
    const { vet, id } = await started();
    const early = await move(vet.cookie, id, "complete", "in_progress", { bookingStatus: "completed", visit: {} });
    expect(early.status).toBe(409);
    expect(fieldErrorsOf(early).missing).toContain("Arrived at the farm");
    expect(fieldErrorsOf(early).missing).toContain("Clinical observations");
    expect((await rawAppointment(id)).bookingStatus).toBe("in_progress");

    for (const itemId of ["arrived", "assessment", "service", "records"])
      await tick(vet.cookie, id, { itemId, done: true });
    const noNotes = await move(vet.cookie, id, "complete", "in_progress");
    expect(noNotes.status).toBe(409);
    expect(fieldErrorsOf(noNotes).missing).toBe("Still needed: Clinical observations saved in the notes.");
    // the optional item isn't needed
    expect(missingForCompletion(dataOf(await readVisit(vet.cookie, id)).visit)).toEqual([
      "Clinical observations saved in the notes",
    ]);
  });

  it("completes once, with time, actor and history, then is read-only and can't be reopened", async () => {
    const { vet, buyer, id } = await started();
    await finishRecord(vet.cookie, id);
    // only the vet completes
    expect((await move(buyer.cookie, id, "complete", "in_progress")).status).toBe(409);

    const done = await move(vet.cookie, id, "complete", "in_progress");
    expect(done.status).toBe(200);
    const appointment = dataOf(done).appointment;
    expect(appointment).toMatchObject({ bookingStatus: "completed", actions: [], paymentStatus: "payment_required" });
    expect(appointment.visit).toMatchObject({ stored: true, editable: false });
    const doc = await rawAppointment(id);
    const last = doc.history[doc.history.length - 1];
    expect(last).toMatchObject({ status: "completed", by: "vet" });
    expect(last.userId?.equals(vet.userId)).toBe(true);
    expect(doc.completedAt?.toISOString()).toBe(last.at.toISOString());

    // repeats change nothing
    expect((await move(vet.cookie, id, "complete", "in_progress")).status).toBe(409);
    for (const action of ["start", "accept", "cancel"])
      expect((await move(vet.cookie, id, action, "completed")).status).toBe(409);
    expect((await tick(vet.cookie, id, { itemId: "follow-up", done: true })).status).toBe(409);
    expect((await saveNotes(vet.cookie, id, { notes: { findings: "late edit" }, expectedVersion: 1 })).status).toBe(
      409,
    );
    const after = await rawAppointment(id);
    expect(after.history.filter((h) => h.status === "completed")).toHaveLength(1);
    expect(after.visit!.notes.findings).toBe("");

    await syncAppointmentNotifications(new ObjectId(id));
    await syncAppointmentNotifications(new ObjectId(id));
    const { notifications } = await collections();
    expect(await notifications.countDocuments({ recipientUserId: buyer.userId, type: "appointment_completed" })).toBe(
      1,
    );

    // the visit record stays readable for the vet, and only for them
    expect((await readVisit(vet.cookie, id)).status).toBe(200);
    expect((await readVisit(buyer.cookie, id)).status).toBe(404);
  });

  it("touches no payment or ledger state", async () => {
    const { vet, id } = await started();
    const db = await getDb();
    const ledgerBefore = await db.collection(COLLECTIONS.ledgerEntries).countDocuments();
    await finishRecord(vet.cookie, id);
    expect((await move(vet.cookie, id, "complete", "in_progress")).status).toBe(200);
    expect((await rawAppointment(id)).paymentStatus).toBe("payment_required");
    expect(await db.collection(COLLECTIONS.ledgerEntries).countDocuments()).toBe(ledgerBefore);
  });

  it("gives a visit started before visit records existed its record, with the start from history", async () => {
    const { vet, id } = await started();
    const appointments = (await getDb()).collection<AppointmentDoc>(COLLECTIONS.appointments);
    await appointments.updateOne({ _id: new ObjectId(id) }, { $unset: { visit: "", startedAt: "" } });
    const seen = dataOf(await read(vet.cookie, id)).appointment;
    const startAt = (await rawAppointment(id)).history.find((h) => h.status === "in_progress")!.at.toISOString();
    expect(seen.startedAt).toBe(startAt);
    expect(seen.visit).toMatchObject({ stored: false, editable: true, notesVersion: 0 });

    await finishRecord(vet.cookie, id);
    expect((await rawAppointment(id)).visit?.template.version).toBe(VISIT_TEMPLATE_VERSION);
    expect((await move(vet.cookie, id, "complete", "in_progress")).status).toBe(200);
  });
});
