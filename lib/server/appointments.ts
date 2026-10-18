import "server-only";
import { randomInt } from "node:crypto";
import { MongoServerError, ObjectId, type ClientSession, type Filter } from "mongodb";
import { isNigerianState } from "@/lib/locations/nigeria";
import { cleanText } from "@/lib/profile/validation";
import { categoryLabel } from "@/lib/services/config";
import { BOOKING_RULES, blockMinutes, isOpenSlot, lagosDate, unitStarts } from "@/lib/vets/schedule";
import {
  BOOKING_STATUSES,
  OPEN_BOOKING_STATUSES,
  type Appointment,
  type AppointmentAction,
  type AppointmentActor,
  type AppointmentSummary,
  type BookingStatus,
} from "@/lib/vets/types";
import { getDb } from "./db";
import { HttpError } from "./http";
import {
  COLLECTIONS,
  type AppointmentDoc,
  type AppointmentHistoryDoc,
  type FarmDoc,
  type UserDoc,
} from "./models";
import { queueNotifications, syncAppointmentNotifications } from "./notifications";
import { inTransaction } from "./order-store";
import { heldFor } from "./vet-availability";
import { findBookableVet, parseId, refreshStaleDirectory, vetCollections } from "./vet-directory";

// Vet appointments: booking, the status machine and what each party sees.
//
// - The customer always comes from the session and the vet from the
//   service's owner; prices come from the stored service (anything the
//   browser sends about price, fees, payment or status is ignored).
// - A booking and the 30-minute units of the vet's time it holds are written
//   in one transaction; a unique index on (vet, unit start) means two
//   bookings can never hold the same time.
// - Every status change is a conditional update on the status the actor
//   saw, so a stale or repeated action changes nothing.
// - Payment isn't collected in the app (docs/find-vet.md): a priced service
//   stays "payment_required" and is never shown as paid or confirmed.

export const APPOINTMENT_NOT_FOUND = "We couldn't find that appointment.";
export const APPOINTMENTS_UNVERIFIED = "Verify your phone number before booking a vet.";
export const SLOT_TAKEN = "That time is no longer available. Please choose another.";

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCATION_LIMITS = { farmName: 80, address: { min: 5, max: 160 }, directions: 300, reason: 200 } as const;

export async function appointmentCollections() {
  const db = await getDb();
  return {
    ...(await vetCollections()),
    farms: db.collection<FarmDoc>(COLLECTIONS.farms),
  };
}

const notify = (id: ObjectId) =>
  queueNotifications("appointment notifications", () => syncAppointmentNotifications(id));

// --- booking --------------------------------------------------------------------

export type ParsedBooking = {
  serviceId: ObjectId;
  startsAt: Date;
  farmId: ObjectId | null;
  location: { farmName: string; address: string; state: AppointmentDoc["location"]["state"]; directions: string };
  idempotencyKey: string;
};

/**
 * Reads only the fields a customer chooses. Price, fee, payment, status,
 * vet and customer fields are not read at all.
 */
export function parseBooking(body: Record<string, unknown>): ParsedBooking {
  const fieldErrors: Record<string, string> = {};
  const serviceId = parseId(body.serviceId);
  if (!serviceId) fieldErrors.serviceId = "Choose a service.";
  const startsAt =
    typeof body.startsAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(\.000)?Z$/.test(body.startsAt)
      ? new Date(body.startsAt)
      : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) fieldErrors.startsAt = "Choose a time.";
  const farmId = body.farmId === undefined || body.farmId === null || body.farmId === "" ? null : parseId(body.farmId);
  if (farmId === null && body.farmId !== undefined && body.farmId !== null && body.farmId !== "")
    fieldErrors.farmId = "Choose one of your farms.";

  const loc = (body.location && typeof body.location === "object" ? body.location : {}) as Record<string, unknown>;
  const text = (v: unknown, multiline = false) => (typeof v === "string" ? cleanText(v, multiline) : "");
  const farmName = text(loc.farmName);
  const address = text(loc.address);
  const directions = text(loc.directions, true);
  if (farmName.length > LOCATION_LIMITS.farmName) fieldErrors["location.farmName"] = "Keep the farm name to 80 characters.";
  if (address.length < LOCATION_LIMITS.address.min || address.length > LOCATION_LIMITS.address.max)
    fieldErrors["location.address"] = "Enter the farm's address or nearest landmark (5–160 characters).";
  if (!isNigerianState(loc.state)) fieldErrors["location.state"] = "Choose the farm's state.";
  if (directions.length > LOCATION_LIMITS.directions)
    fieldErrors["location.directions"] = "Keep directions to 300 characters.";
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) fieldErrors.idempotencyKey = "Reload the page and try again.";

  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Please check the booking details.", fieldErrors);
  return {
    serviceId: serviceId!,
    startsAt: startsAt!,
    farmId,
    location: { farmName, address, state: loc.state as ParsedBooking["location"]["state"], directions },
    idempotencyKey: (key as string).toLowerCase(),
  };
}

const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newReference = () =>
  `VA-${Array.from({ length: 8 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join("")}`;

const isDuplicate = (error: unknown, index?: string) =>
  error instanceof MongoServerError &&
  error.code === 11000 &&
  (index === undefined || String(error.message).includes(index));

const historyItem = (
  status: BookingStatus,
  by: AppointmentActor,
  userId: ObjectId | null,
  at: Date,
  note: string | null = null,
): AppointmentHistoryDoc => ({ status, by, userId, at, note });

/** The same booking submitted again: the first one, if its details match. */
function sameBooking(existing: AppointmentDoc, input: ParsedBooking) {
  if (!existing.serviceId.equals(input.serviceId) || existing.startsAt.getTime() !== input.startsAt.getTime())
    throw new HttpError(409, "This booking was already sent with different details. Reload the page to start again.");
  return existing;
}

/**
 * Books a slot. Returns the appointment and whether it was made by this
 * call (false: the same idempotency key was used before).
 */
export async function createAppointment(
  customer: UserDoc,
  input: ParsedBooking,
  now = new Date(),
): Promise<{ appointment: AppointmentDoc; created: boolean }> {
  const { appointments, services, slots, farms } = await appointmentCollections();
  const earlier = await appointments.findOne({ customerUserId: customer._id, idempotencyKey: input.idempotencyKey });
  if (earlier) return { appointment: sameBooking(earlier, input), created: false };

  const service = await services.findOne({ _id: input.serviceId, archivedAt: null });
  if (!service) throw new HttpError(404, "That service isn't available any more.");
  if (service.ownerUserId.equals(customer._id)) throw new HttpError(403, "You can't book your own service.");
  const vet = await findBookableVet(service.ownerUserId.toHexString());
  const current = vet?.services.find((s) => s._id.equals(service._id));
  if (!vet || !current) throw new HttpError(409, "This vet isn't taking bookings for that service right now.");

  const open = await appointments.countDocuments(
    { customerUserId: customer._id, bookingStatus: { $in: ["requested", "confirmed"] } },
    { limit: BOOKING_RULES.maxOpenPerCustomer },
  );
  if (open >= BOOKING_RULES.maxOpenPerCustomer)
    throw new HttpError(409, `You can have up to ${BOOKING_RULES.maxOpenPerCustomer} open appointments. Cancel one you no longer need first.`);

  await expireLapsed({ vetUserId: vet.user._id }, 20, now);
  const block = blockMinutes(current.durationMinutes, vet.settings.slotMinutes);
  const held = await heldFor(vet.user._id, lagosDate(input.startsAt), 1);
  if (!isOpenSlot(vet.settings, input.startsAt, block, held, now)) throw new HttpError(409, SLOT_TAKEN);

  let farmId: ObjectId | null = null;
  let farmName = input.location.farmName;
  if (input.farmId) {
    const farm = await farms.findOne({ _id: input.farmId, ownerUserId: customer._id }, { projection: { farmName: 1 } });
    if (!farm) throw new HttpError(400, "Please check the booking details.", { farmId: "Choose one of your farms." });
    farmId = farm._id;
    farmName = farm.farmName;
  }

  const priceKobo = current.priceNgn * 100;
  const feeKobo = 0; // no booking fee is configured
  for (let attempt = 0; ; attempt++) {
    const doc: AppointmentDoc = {
      _id: new ObjectId(),
      reference: newReference(),
      customerUserId: customer._id,
      vetUserId: vet.user._id,
      serviceId: current._id,
      service: { name: current.name, category: current.category, durationMinutes: current.durationMinutes },
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + block * 60_000),
      location: { farmId, farmName, address: input.location.address, state: input.location.state, directions: input.location.directions },
      price: { priceKobo, feeKobo, totalKobo: priceKobo + feeKobo, currency: "NGN" },
      bookingStatus: "requested",
      paymentStatus: priceKobo + feeKobo === 0 ? "not_required" : "payment_required",
      respondBy: new Date(Math.min(now.getTime() + BOOKING_RULES.respondWithinMs, input.startsAt.getTime())),
      idempotencyKey: input.idempotencyKey,
      history: [historyItem("requested", "customer", customer._id, now)],
      slotsReleasedAt: null,
      notifySyncAt: now,
      notifiedThrough: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await inTransaction(async (session) => {
        await appointments.insertOne(doc, { session });
        await slots.insertMany(
          unitStarts(doc.startsAt, block).map((startsAt) => ({
            _id: new ObjectId(),
            vetUserId: doc.vetUserId,
            startsAt,
            appointmentId: doc._id,
            createdAt: now,
          })),
          { session },
        );
      });
      await notify(doc._id);
      return { appointment: doc, created: true };
    } catch (error) {
      if (isDuplicate(error, "vet_unit_unique")) throw new HttpError(409, SLOT_TAKEN);
      if (isDuplicate(error, "customer_idempotency")) {
        const first = await appointments.findOne({ customerUserId: customer._id, idempotencyKey: input.idempotencyKey });
        if (first) return { appointment: sameBooking(first, input), created: false };
      }
      if (isDuplicate(error, "reference_unique") && attempt < 3) continue;
      throw error;
    }
  }
}

// --- the status machine -----------------------------------------------------------

export type Viewer = "customer" | "vet";

const TARGET: Record<AppointmentAction, BookingStatus> = {
  accept: "confirmed",
  decline: "declined",
  en_route: "en_route",
  start: "in_progress",
  complete: "completed",
  cancel: "cancelled",
};

/** Statuses that give the vet's time back. */
const RELEASES: readonly BookingStatus[] = ["declined", "cancelled", "expired"];

/**
 * What this viewer may do now. The whole state machine:
 *
 *   requested   → confirmed (vet accepts) | declined (vet) | cancelled (customer) | expired (system, at respondBy)
 *   confirmed   → en_route (vet) | in_progress (vet, from 1 h before) | cancelled (vet; customer until 2 h before)
 *   en_route    → in_progress (vet) | cancelled (vet)
 *   in_progress → completed (vet)
 *   completed, declined, cancelled, expired: final
 */
export function actionsFor(doc: AppointmentDoc, viewer: Viewer, now = new Date()): AppointmentAction[] {
  const t = now.getTime();
  const start = doc.startsAt.getTime();
  switch (doc.bookingStatus) {
    case "requested":
      if (t >= doc.respondBy.getTime()) return []; // lapsing; the job (or the next read) expires it
      return viewer === "vet" ? ["accept", "decline"] : ["cancel"];
    case "confirmed":
      if (viewer === "customer") return t < start - BOOKING_RULES.customerCancelCutoffMs ? ["cancel"] : [];
      return [
        "en_route",
        ...(t >= start - BOOKING_RULES.startEarlyMs ? (["start"] as const) : []),
        "cancel",
      ];
    case "en_route":
      return viewer === "vet" ? ["start", "cancel"] : [];
    case "in_progress":
      return viewer === "vet" ? ["complete"] : [];
    default:
      return [];
  }
}

export type ParsedTransition = { action: AppointmentAction; expectedStatus: BookingStatus; reason: string | null };

export function parseTransition(body: Record<string, unknown>): ParsedTransition {
  const { action, expectedStatus, reason } = body;
  const fieldErrors: Record<string, string> = {};
  if (typeof action !== "string" || !Object.hasOwn(TARGET, action)) fieldErrors.action = "Choose an action.";
  if (!BOOKING_STATUSES.includes(expectedStatus as BookingStatus)) fieldErrors.expectedStatus = "Reload the page and try again.";
  const note = typeof reason === "string" ? cleanText(reason) : "";
  if (reason !== undefined && typeof reason !== "string") fieldErrors.reason = "Enter a short reason.";
  if (note.length > LOCATION_LIMITS.reason) fieldErrors.reason = "Keep the reason to 200 characters.";
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "That change couldn't be made.", fieldErrors);
  return { action: action as AppointmentAction, expectedStatus: expectedStatus as BookingStatus, reason: note || null };
}

/** The appointment if this user is its customer or its vet; null otherwise (including for a bad id). */
export async function findOwnAppointment(user: Pick<UserDoc, "_id">, id: unknown) {
  const _id = parseId(id);
  if (!_id) return null;
  const { appointments } = await appointmentCollections();
  const doc = await appointments.findOne({ _id, $or: [{ customerUserId: user._id }, { vetUserId: user._id }] });
  if (!doc) return null;
  return { doc, viewer: (doc.vetUserId.equals(user._id) ? "vet" : "customer") as Viewer };
}

/**
 * Moves an appointment from `from` to `to` if it's still in `from`, adding
 * the history item and (for a decline, cancellation or lapse) deleting its
 * slot holds in the same transaction. Null when it had already changed.
 */
async function move(
  doc: AppointmentDoc,
  from: BookingStatus,
  to: BookingStatus,
  item: AppointmentHistoryDoc,
): Promise<AppointmentDoc | null> {
  const { appointments, slots } = await appointmentCollections();
  const release = RELEASES.includes(to);
  const updated = await inTransaction(async (session: ClientSession) => {
    const after = await appointments.findOneAndUpdate(
      { _id: doc._id, bookingStatus: from } as Filter<AppointmentDoc>,
      {
        $set: {
          bookingStatus: to,
          notifySyncAt: item.at,
          updatedAt: item.at,
          ...(release ? { slotsReleasedAt: item.at } : {}),
        },
        $push: { history: item },
      },
      { returnDocument: "after", session },
    );
    if (after && release) await slots.deleteMany({ appointmentId: doc._id }, { session });
    return after;
  });
  if (updated) await notify(updated._id);
  return updated;
}

export async function transitionAppointment(
  user: UserDoc,
  id: unknown,
  input: ParsedTransition,
  now = new Date(),
): Promise<{ doc: AppointmentDoc; viewer: Viewer }> {
  const found = await findOwnAppointment(user, id);
  if (!found) throw new HttpError(404, APPOINTMENT_NOT_FOUND);
  const { doc, viewer } = found;
  const stale = () => new HttpError(409, "This appointment has changed. Reload to see its latest status.");
  if (doc.bookingStatus !== input.expectedStatus) throw stale();

  if (doc.bookingStatus === "requested" && now >= doc.respondBy) {
    await expireOne(doc, now);
    throw new HttpError(409, "This request wasn't answered in time, so it has lapsed.");
  }
  if (!actionsFor(doc, viewer, now).includes(input.action))
    throw new HttpError(409, "That change isn't possible for this appointment now.");
  if (input.action === "accept" && user.profile?.credentialStatus !== "verified")
    throw new HttpError(403, "Your credentials need to be approved before you can accept appointments.");

  const to = TARGET[input.action];
  const updated = await move(doc, doc.bookingStatus, to, historyItem(to, viewer, user._id, now, input.reason));
  if (!updated) throw stale();
  return { doc: updated, viewer };
}

async function expireOne(doc: AppointmentDoc, now: Date) {
  return move(doc, "requested", "expired", historyItem("expired", "system", null, now));
}

/** Lapses unanswered requests past their respond-by time (bounded). */
export async function expireLapsed(scope: { vetUserId?: ObjectId }, limit: number, now = new Date()): Promise<number> {
  const { appointments } = await appointmentCollections();
  const due = await appointments
    .find({ ...scope, bookingStatus: "requested", respondBy: { $lte: now } })
    .sort({ respondBy: 1 })
    .limit(limit)
    .toArray();
  let expired = 0;
  for (const doc of due) if (await expireOne(doc, now)) expired++;
  return expired;
}

/**
 * Deletes holds left by an appointment that no longer needs them (a
 * release interrupted mid-way can't happen inside a transaction, but this
 * keeps the job honest if data was edited by hand).
 */
export async function releaseOrphanHolds(limit: number): Promise<number> {
  const { appointments, slots } = await appointmentCollections();
  const done = await appointments
    .find({ bookingStatus: { $in: [...RELEASES] }, slotsReleasedAt: null }, { projection: { _id: 1 } })
    .limit(limit)
    .toArray();
  for (const { _id } of done) {
    await inTransaction(async (session) => {
      await slots.deleteMany({ appointmentId: _id }, { session });
      await appointments.updateOne({ _id }, { $set: { slotsReleasedAt: new Date() } }, { session });
    });
  }
  return done.length;
}

export type AppointmentJobResult = { expired: number; holdsReleased: number; directoryRefreshed: number };

/** The scheduled job (app/api/internal/appointments/process). Each step is safe to repeat. */
export async function runAppointmentJob(limit = 50, now = new Date()): Promise<AppointmentJobResult> {
  return {
    expired: await expireLapsed({}, limit, now),
    holdsReleased: await releaseOrphanHolds(limit),
    directoryRefreshed: await refreshStaleDirectory(limit),
  };
}

// --- what each party sees -----------------------------------------------------------

/** Phone numbers are only shared while a visit the vet accepted is still open. */
const SHARES_CONTACT: readonly BookingStatus[] = ["confirmed", "en_route", "in_progress"];

export async function toAppointment(doc: AppointmentDoc, viewer: Viewer, now = new Date()): Promise<Appointment> {
  const { users, availability } = await appointmentCollections();
  const projection = { fullName: 1, phoneNormalized: 1, "profile.photo.url": 1 } as const;
  const [vet, customer, settings] = await Promise.all([
    users.findOne({ _id: doc.vetUserId }, { projection }),
    users.findOne({ _id: doc.customerUserId }, { projection }),
    availability.findOne({ _id: doc.vetUserId }, { projection: { sharePhoneWithClients: 1 } }),
  ]);
  const open = SHARES_CONTACT.includes(doc.bookingStatus);
  return {
    id: doc._id.toHexString(),
    reference: doc.reference,
    viewer,
    vet: {
      id: doc.vetUserId.toHexString(),
      name: vet?.fullName ?? "Former vet",
      photoUrl: vet?.profile?.photo?.url ?? null,
      phone: viewer === "customer" && open && settings?.sharePhoneWithClients ? (vet?.phoneNormalized ?? null) : null,
    },
    customer: {
      name: customer?.fullName ?? "Former customer",
      phone: viewer === "vet" && open ? (customer?.phoneNormalized ?? null) : null,
    },
    service: {
      name: doc.service.name,
      categoryLabel: categoryLabel("veterinarian", doc.service.category),
      durationMinutes: doc.service.durationMinutes,
    },
    startsAt: doc.startsAt.toISOString(),
    endsAt: doc.endsAt.toISOString(),
    location: {
      farmName: doc.location.farmName,
      address: doc.location.address,
      state: doc.location.state,
      directions: doc.location.directions,
    },
    priceKobo: doc.price.priceKobo,
    feeKobo: doc.price.feeKobo,
    totalKobo: doc.price.totalKobo,
    bookingStatus: doc.bookingStatus,
    paymentStatus: doc.paymentStatus,
    respondBy: doc.respondBy.toISOString(),
    history: doc.history.map((h) => ({ status: h.status, by: h.by, at: h.at.toISOString(), note: h.note })),
    actions: actionsFor(doc, viewer, now),
    cancelUntil: new Date(doc.startsAt.getTime() - BOOKING_RULES.customerCancelCutoffMs).toISOString(),
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Reads one appointment for its customer or vet, lapsing it first if its time to answer has passed. */
export async function getAppointment(user: UserDoc, id: unknown, now = new Date()): Promise<Appointment | null> {
  const found = await findOwnAppointment(user, id);
  if (!found) return null;
  let doc = found.doc;
  if (doc.bookingStatus === "requested" && now >= doc.respondBy) doc = (await expireOne(doc, now)) ?? doc;
  return toAppointment(doc, found.viewer, now);
}

export const APPOINTMENT_PAGE_SIZE = 20;

function listCursor(view: Viewer, doc: Pick<AppointmentDoc, "startsAt" | "_id">) {
  return Buffer.from(`${view}.${doc.startsAt.getTime()}.${doc._id.toHexString()}`).toString("base64url");
}

function readListCursor(view: Viewer, cursor: string): { at: Date; id: ObjectId } {
  const bad = new HttpError(400, "This list has changed. Reload to start again.");
  if (cursor.length > 120) throw bad;
  const m = /^(customer|vet)\.(\d{1,15})\.([0-9a-f]{24})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!m || m[1] !== view) throw bad;
  return { at: new Date(Number(m[2])), id: new ObjectId(m[3]) };
}

/**
 * The user's appointments as a customer, or (vets) the ones booked with
 * them: newest start first, keyset paged on (startsAt, _id).
 */
export async function listAppointments(
  user: UserDoc,
  view: Viewer,
  cursor: string | null,
  now = new Date(),
): Promise<{ appointments: AppointmentSummary[]; nextCursor: string | null }> {
  const { appointments, users } = await appointmentCollections();
  const mine: Filter<AppointmentDoc> = view === "vet" ? { vetUserId: user._id } : { customerUserId: user._id };
  await expireLapsed(mine as { vetUserId?: ObjectId }, 20, now);
  const filter: Filter<AppointmentDoc> = { ...mine };
  if (cursor) {
    const after = readListCursor(view, cursor);
    filter.$or = [{ startsAt: { $lt: after.at } }, { startsAt: after.at, _id: { $lt: after.id } }];
  }
  const docs = await appointments
    .find(filter)
    .sort({ startsAt: -1, _id: -1 })
    .limit(APPOINTMENT_PAGE_SIZE + 1)
    .toArray();
  const page = docs.slice(0, APPOINTMENT_PAGE_SIZE);
  const otherIds = [...new Set(page.map((d) => (view === "vet" ? d.customerUserId : d.vetUserId).toHexString()))].map(
    (id) => new ObjectId(id),
  );
  const names = new Map(
    (await users.find({ _id: { $in: otherIds } }, { projection: { fullName: 1 } }).toArray()).map((u) => [
      u._id.toHexString(),
      u.fullName,
    ]),
  );
  return {
    appointments: page.map((d) => ({
      id: d._id.toHexString(),
      reference: d.reference,
      viewer: view,
      startsAt: d.startsAt.toISOString(),
      bookingStatus: d.bookingStatus,
      paymentStatus: d.paymentStatus,
      totalKobo: d.price.totalKobo,
      serviceName: d.service.name,
      otherParty: names.get((view === "vet" ? d.customerUserId : d.vetUserId).toHexString()) ?? "Former member",
    })),
    nextCursor: docs.length > APPOINTMENT_PAGE_SIZE ? listCursor(view, page[page.length - 1]) : null,
  };
}

export const isOpenStatus = (status: BookingStatus) => OPEN_BOOKING_STATUSES.includes(status);
