import "server-only";
import { randomInt } from "node:crypto";
import { MongoServerError, ObjectId, type Filter } from "mongodb";
import { isNigerianState, stateLabel } from "@/lib/locations/nigeria";
import { cleanText } from "@/lib/profile/validation";
import { isMarketplaceCategory, marketplaceLabel, MARKETPLACE_ROLES, SERVICE_LIMITS } from "@/lib/services/config";
import {
  describeDetails,
  isContactPreference,
  isDateString,
  isTimeWindow,
  OPEN_SERVICE_BOOKING_STATUSES,
  SERVICE_BOOKING_ACTIONS,
  SERVICE_BOOKING_RULES,
  SERVICE_BOOKING_STATUSES,
  validateBookingDetails,
  type ServiceBooking,
  type ServiceBookingAction,
  type ServiceBookingStatus,
  type ServiceBookingSummary,
  type ServiceBookingViewer,
} from "@/lib/services/marketplace";
import { addDays, lagosDate, lagosInstant } from "@/lib/vets/schedule";
import { HttpError } from "./http";
import type { ServiceBookingDoc, ServiceBookingHistoryDoc, ServiceDoc, ServiceRefundDoc, UserDoc } from "./models";
import { PAYMENTS_OFF, paymentsEnabled } from "./order-payments";
import { bestEffort, inTransaction } from "./order-store";
import { isPaystackConfigured } from "./paystack";
import { bookingCollections, bookingHistoryItem, notifyBooking } from "./service-booking-store";
import { syncBookingLedger } from "./service-ledger";
import {
  closeBookingAttempts,
  isBookingPayable,
  reconcileBookingPayments,
  settleBookingAttempt,
} from "./service-payments";
import { continueBookingRefund, newBookingRefund, reconcileBookingRefunds } from "./service-refunds";
import { parseId } from "./vet-directory";

// Other Services bookings: making one, the status machine and what each
// party sees (docs/other-services.md).
//
// - The customer always comes from the session and the provider from the
//   service's owner. The service's name, category and price are copied in
//   when the booking is made; anything the browser sends about price,
//   payment, provider or status is ignored.
// - Every change is a conditional update on the state the actor saw, so a
//   stale or repeated action changes nothing.
// - A paid booking that ends without the work (declined, cancelled, lapsed)
//   is refunded in full: the refund is created in the same transaction as
//   the change and sent straight after it.

export const BOOKING_NOT_FOUND = "We couldn't find that booking.";
export const SERVICE_BOOKINGS_UNVERIFIED = "Verify your phone number before booking a service.";
const SERVICE_UNAVAILABLE = "This service isn't taking bookings right now.";

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newReference = () =>
  `FK-SVC-${Array.from({ length: 8 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join("")}`;

const isDuplicate = (error: unknown, index: string) =>
  error instanceof MongoServerError && error.code === 11000 && String(error.message).includes(index);

const DAY_MS = 24 * 60 * 60_000;

/** The earliest and latest dates that can be booked today (Lagos). */
export function bookableDates(now = new Date()) {
  const today = lagosDate(now);
  return {
    first: addDays(today, SERVICE_BOOKING_RULES.minDaysAhead),
    last: addDays(today, SERVICE_BOOKING_RULES.maxDaysAhead),
  };
}

// --- whether a service can be booked ------------------------------------------------

/**
 * A marketplace service anyone can book: listed (active, taking bookings,
 * not removed), with a price or quote pricing, owned by an active account
 * whose role may offer that category.
 */
export function isListedService(service: ServiceDoc, owner: Pick<UserDoc, "role" | "status"> | null) {
  return (
    !!owner &&
    owner.status === "active" &&
    isMarketplaceCategory(service.category) &&
    MARKETPLACE_ROLES[owner.role].includes(service.category) &&
    (service.pricing === "quote" || (service.pricing === "fixed" && service.priceNgn > 0)) &&
    service.active &&
    service.bookingAvailable &&
    service.archivedAt === null
  );
}

async function findListedService(id: ObjectId) {
  const { services, users } = await bookingCollections();
  const service = await services.findOne({ _id: id, archivedAt: null, pricing: { $type: "string" } });
  if (!service) return null;
  const owner = await users.findOne({ _id: service.ownerUserId }, { projection: { role: 1, status: 1 } });
  return isListedService(service, owner) ? service : null;
}

// --- making a booking ----------------------------------------------------------------

export type ParsedServiceBooking = {
  serviceId: ObjectId;
  date: string;
  window: ServiceBookingDoc["schedule"]["window"];
  location: ServiceBookingDoc["location"];
  contactPreference: ServiceBookingDoc["contactPreference"];
  notes: string;
  /** checked against the service's category once it's loaded */
  rawDetails: unknown;
  idempotencyKey: string;
};

/**
 * Reads only the fields a customer chooses. Price, amount, fee, payment,
 * status, provider and customer fields are not read at all.
 */
export function parseServiceBooking(body: Record<string, unknown>, now = new Date()): ParsedServiceBooking {
  const fieldErrors: Record<string, string> = {};
  const serviceId = parseId(body.serviceId);
  if (!serviceId) fieldErrors.serviceId = "Choose a service.";

  const { first, last } = bookableDates(now);
  const date = typeof body.date === "string" && isDateString(body.date) ? body.date : null;
  if (!date) fieldErrors.date = "Choose a date.";
  else if (date < first || date > last) fieldErrors.date = "Choose a date from tomorrow up to 90 days ahead.";
  if (!isTimeWindow(body.window)) fieldErrors.window = "Choose a time of day.";

  const loc = (body.location && typeof body.location === "object" ? body.location : {}) as Record<string, unknown>;
  const text = (v: unknown, multiline = false) => (typeof v === "string" ? cleanText(v, multiline) : "");
  const address = text(loc.address);
  const directions = text(loc.directions, true);
  const { address: addressLimits } = SERVICE_BOOKING_RULES;
  if (address.length < addressLimits.min || address.length > addressLimits.max)
    fieldErrors["location.address"] = "Enter the address or nearest landmark (5–160 characters).";
  if (!isNigerianState(loc.state)) fieldErrors["location.state"] = "Choose the state.";
  if (directions.length > SERVICE_BOOKING_RULES.directions)
    fieldErrors["location.directions"] = "Keep directions to 300 characters.";
  if (!isContactPreference(body.contactPreference)) fieldErrors.contactPreference = "Choose how to be contacted.";
  const notes = text(body.notes, true);
  if ((body.notes !== undefined && typeof body.notes !== "string") || notes.length > SERVICE_BOOKING_RULES.notes)
    fieldErrors.notes = "Keep notes to 500 characters.";
  const key = body.idempotencyKey;
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key))
    fieldErrors.idempotencyKey = "Reload the page and try again.";

  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "Please check the booking details.", fieldErrors);
  return {
    serviceId: serviceId!,
    date: date!,
    window: body.window as ParsedServiceBooking["window"],
    location: { address, state: loc.state as ParsedServiceBooking["location"]["state"], directions },
    contactPreference: body.contactPreference as ParsedServiceBooking["contactPreference"],
    notes,
    rawDetails: body.details,
    idempotencyKey: (key as string).toLowerCase(),
  };
}

/** The same booking submitted again: the first one, if its details match. */
function sameBooking(existing: ServiceBookingDoc, input: ParsedServiceBooking) {
  if (!existing.serviceId.equals(input.serviceId) || existing.schedule.date !== input.date)
    throw new HttpError(409, "This booking was already sent with different details. Reload the page to start again.");
  return existing;
}

const openKeyFor = (serviceId: ObjectId, date: string) => `${serviceId.toHexString()}:${date}`;
const respondByFor = (date: string, now: Date) =>
  new Date(Math.min(now.getTime() + SERVICE_BOOKING_RULES.respondWithinMs, lagosInstant(date, 0).getTime()));

/**
 * Books a service. A fixed-price booking waits for payment first; a quote
 * request goes to the provider to price. Returns the booking and whether
 * this call made it (false: the same idempotency key was used before).
 */
export async function createServiceBooking(
  customer: UserDoc,
  input: ParsedServiceBooking,
  now = new Date(),
): Promise<{ booking: ServiceBookingDoc; created: boolean }> {
  const { bookings } = await bookingCollections();
  const earlier = await bookings.findOne({ customerUserId: customer._id, idempotencyKey: input.idempotencyKey });
  if (earlier) return { booking: sameBooking(earlier, input), created: false };

  const service = await findListedService(input.serviceId);
  if (!service || !isMarketplaceCategory(service.category) || !service.pricing)
    throw new HttpError(404, SERVICE_UNAVAILABLE);
  if (service.ownerUserId.equals(customer._id)) throw new HttpError(403, "You can't book your own service.");
  const states = service.serviceStates ?? [];
  if (states.length > 0 && !states.includes(input.location.state))
    throw new HttpError(400, "Please check the booking details.", {
      "location.state": "This provider doesn't cover that state.",
    });
  const { details, errors } = validateBookingDetails(service.category, input.rawDetails);
  if (Object.keys(errors).length > 0)
    throw new HttpError(
      400,
      "Please check the booking details.",
      Object.fromEntries(Object.entries(errors).map(([k, v]) => [`details.${k}`, v])),
    );
  const fixed = service.pricing === "fixed";
  if (fixed && !paymentsEnabled()) throw new HttpError(503, PAYMENTS_OFF);

  const open = await bookings.countDocuments(
    { customerUserId: customer._id, status: { $in: [...OPEN_SERVICE_BOOKING_STATUSES] } },
    { limit: SERVICE_BOOKING_RULES.maxOpenPerCustomer },
  );
  if (open >= SERVICE_BOOKING_RULES.maxOpenPerCustomer)
    throw new HttpError(
      409,
      `You can have up to ${SERVICE_BOOKING_RULES.maxOpenPerCustomer} open service bookings. Cancel one you no longer need first.`,
    );

  for (let attempt = 0; ; attempt++) {
    const doc: ServiceBookingDoc = {
      _id: new ObjectId(),
      reference: newReference(),
      customerUserId: customer._id,
      providerUserId: service.ownerUserId,
      serviceId: service._id,
      service: {
        name: service.name,
        category: service.category,
        pricing: service.pricing,
        durationMinutes: service.durationMinutes,
      },
      details,
      schedule: { date: input.date, window: input.window },
      location: input.location,
      contactPreference: input.contactPreference,
      notes: input.notes,
      status: fixed ? "awaiting_payment" : "requested",
      amountKobo: fixed ? service.priceNgn * 100 : null,
      quote: null,
      paymentStatus: fixed ? "pending" : "none",
      paidKobo: 0,
      paymentReference: null,
      paidAt: null,
      refundedKobo: 0,
      refundInFlight: null,
      acceptedAt: null,
      completedAt: null,
      respondBy: fixed ? null : respondByFor(input.date, now),
      payBy: fixed ? new Date(now.getTime() + SERVICE_BOOKING_RULES.payWithinMs) : null,
      openKey: openKeyFor(service._id, input.date),
      idempotencyKey: input.idempotencyKey,
      history: [bookingHistoryItem(fixed ? "awaiting_payment" : "requested", "customer", customer._id, now)],
      settlement: null,
      ledgerSyncAt: null,
      notifySyncAt: now,
      notifiedThrough: 0,
      reviewIssue: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await bookings.insertOne(doc);
      await notifyBooking(doc._id);
      return { booking: doc, created: true };
    } catch (error) {
      if (isDuplicate(error, "customer_idempotency")) {
        const first = await bookings.findOne({ customerUserId: customer._id, idempotencyKey: input.idempotencyKey });
        if (first) return { booking: sameBooking(first, input), created: false };
      }
      if (isDuplicate(error, "customer_open_unique"))
        throw new HttpError(409, "You already have an open booking for this service on that day.");
      if (isDuplicate(error, "reference_unique") && attempt < 3) continue;
      throw error;
    }
  }
}

// --- the status machine ---------------------------------------------------------------

/**
 * What this viewer may do now. The whole state machine:
 *
 *   fixed price:  awaiting_payment → requested (paid) → confirmed (provider accepts)
 *   quote:        requested → quote_offered (provider) → awaiting_payment (customer accepts) → confirmed (paid)
 *
 *   requested         → confirmed | quote_offered (provider) | declined (provider) | cancelled (customer)
 *                       | expired (at respondBy)
 *   quote_offered     → awaiting_payment (customer) | cancelled (customer rejects) | declined (provider withdraws)
 *                       | expired (at quote.validUntil)
 *   awaiting_payment  → requested / confirmed (paid) | cancelled (customer) | expired (at payBy)
 *   confirmed         → provider_en_route | in_progress (provider, from the booked day) | cancelled (provider;
 *                       customer until the day before)
 *   provider_en_route → in_progress | cancelled (provider)
 *   in_progress       → completed (provider)
 *   completed, declined, cancelled, expired: final
 */
export function serviceBookingActions(
  doc: ServiceBookingDoc,
  viewer: ServiceBookingViewer,
  now = new Date(),
): ServiceBookingAction[] {
  const provider = viewer === "provider";
  const onTheDay = lagosDate(now) >= doc.schedule.date;
  switch (doc.status) {
    case "requested":
      if (!doc.respondBy || now >= doc.respondBy) return []; // lapsing
      if (!provider) return ["cancel"];
      return doc.service.pricing === "quote" ? ["quote", "decline"] : ["accept", "decline"];
    case "quote_offered":
      if (!doc.quote || now >= doc.quote.validUntil) return [];
      return provider ? ["decline"] : ["accept_quote", "reject_quote"];
    case "awaiting_payment":
      if (!doc.payBy || now >= doc.payBy) return [];
      return provider ? [] : ["cancel"];
    case "confirmed":
      if (!provider) return lagosDate(now) < doc.schedule.date ? ["cancel"] : [];
      return onTheDay ? ["en_route", "start", "cancel"] : ["cancel"];
    case "provider_en_route":
      return provider ? ["start", "cancel"] : [];
    case "in_progress":
      return provider ? ["complete"] : [];
    default:
      return [];
  }
}

const TARGET: Record<ServiceBookingAction, ServiceBookingStatus> = {
  accept: "confirmed",
  decline: "declined",
  quote: "quote_offered",
  accept_quote: "awaiting_payment",
  reject_quote: "cancelled",
  en_route: "provider_en_route",
  start: "in_progress",
  complete: "completed",
  cancel: "cancelled",
};

const ENDS: readonly ServiceBookingStatus[] = ["declined", "cancelled", "expired", "completed"];

export type ParsedServiceTransition = {
  action: ServiceBookingAction;
  expectedStatus: ServiceBookingStatus;
  reason: string | null;
  quote: { amountNgn: number; note: string; validDays: number } | null;
};

export function parseServiceTransition(body: Record<string, unknown>): ParsedServiceTransition {
  const { action, expectedStatus, reason } = body;
  const fieldErrors: Record<string, string> = {};
  if (!SERVICE_BOOKING_ACTIONS.includes(action as ServiceBookingAction)) fieldErrors.action = "Choose an action.";
  if (!SERVICE_BOOKING_STATUSES.includes(expectedStatus as ServiceBookingStatus))
    fieldErrors.expectedStatus = "Reload the page and try again.";
  const note = typeof reason === "string" ? cleanText(reason) : "";
  if (reason !== undefined && typeof reason !== "string") fieldErrors.reason = "Enter a short reason.";
  if (note.length > SERVICE_BOOKING_RULES.reason) fieldErrors.reason = "Keep the reason to 200 characters.";

  let quote: ParsedServiceTransition["quote"] = null;
  if (action === "quote") {
    const raw = (body.quote && typeof body.quote === "object" ? body.quote : {}) as Record<string, unknown>;
    const amountNgn = raw.amountNgn;
    if (
      typeof amountNgn !== "number" ||
      !Number.isSafeInteger(amountNgn) ||
      amountNgn < 1 ||
      amountNgn > SERVICE_LIMITS.maxPriceNgn
    )
      fieldErrors["quote.amountNgn"] = "Enter the price in whole naira.";
    const quoteNote = typeof raw.note === "string" ? cleanText(raw.note, true) : "";
    if ((raw.note !== undefined && typeof raw.note !== "string") || quoteNote.length > SERVICE_BOOKING_RULES.quoteNote)
      fieldErrors["quote.note"] = "Keep the note to 300 characters.";
    const { min, max, default: fallback } = SERVICE_BOOKING_RULES.quoteValidDays;
    const validDays = raw.validDays === undefined ? fallback : raw.validDays;
    if (typeof validDays !== "number" || !Number.isInteger(validDays) || validDays < min || validDays > max)
      fieldErrors["quote.validDays"] = `Choose ${min} to ${max} days.`;
    quote = { amountNgn: amountNgn as number, note: quoteNote, validDays: validDays as number };
  }
  if (Object.keys(fieldErrors).length > 0) throw new HttpError(400, "That change couldn't be made.", fieldErrors);
  return {
    action: action as ServiceBookingAction,
    expectedStatus: expectedStatus as ServiceBookingStatus,
    reason: note || null,
    quote,
  };
}

/** The booking if this user is its customer or its provider; null otherwise (including for a bad id). */
export async function findOwnServiceBooking(user: Pick<UserDoc, "_id">, id: unknown) {
  const _id = parseId(id);
  if (!_id) return null;
  const { bookings } = await bookingCollections();
  const doc = await bookings.findOne({ _id, $or: [{ customerUserId: user._id }, { providerUserId: user._id }] });
  if (!doc) return null;
  return { doc, viewer: (doc.providerUserId.equals(user._id) ? "provider" : "customer") as ServiceBookingViewer };
}

/**
 * Moves a booking from the state it was read in to `to`, in one
 * transaction. A paid booking that ends without the work gets its full
 * refund created alongside; an unpaid one that ends records no payment.
 * Null when it had already changed.
 */
async function move(
  doc: ServiceBookingDoc,
  to: ServiceBookingStatus,
  item: ServiceBookingHistoryDoc,
  set: Partial<ServiceBookingDoc> = {},
): Promise<ServiceBookingDoc | null> {
  const { bookings, refunds } = await bookingCollections();
  const ends = ENDS.includes(to);
  const refund: ServiceRefundDoc | null =
    ends && to !== "completed" && doc.paymentStatus === "paid" && doc.paymentReference
      ? newBookingRefund(doc, "booking", doc.paymentReference, doc.paidKobo, `Booking ${to}`)
      : null;
  const filter: Filter<ServiceBookingDoc> = { _id: doc._id, status: doc.status };
  if (doc.status === "awaiting_payment") filter.paymentStatus = { $in: ["pending", "failed"] };
  else filter.paymentStatus = doc.paymentStatus;
  const at = item.at;
  const updated = await inTransaction(async (session) => {
    const after = await bookings.findOneAndUpdate(
      filter,
      {
        $set: {
          ...set,
          status: to,
          ...(ends ? { openKey: null, respondBy: null, payBy: null } : {}),
          ...(ends && !refund && doc.paymentStatus !== "paid" ? { paymentStatus: "none" as const } : {}),
          ...(refund ? { paymentStatus: "refund_pending" as const, refundInFlight: refund._id, ledgerSyncAt: at } : {}),
          ...(to === "completed" || to === "confirmed" ? { ledgerSyncAt: at } : {}),
          notifySyncAt: at,
          updatedAt: at,
        },
        $push: { history: item },
      },
      { returnDocument: "after", session },
    );
    if (after && refund) await refunds.insertOne(refund, { session });
    return after;
  });
  if (!updated) return null;
  if (refund) await bestEffort("booking refund", () => continueBookingRefund(refund._id));
  else if (updated.ledgerSyncAt) await bestEffort("booking ledger sync", () => syncBookingLedger(updated._id));
  await notifyBooking(updated._id);
  return (await bookings.findOne({ _id: updated._id })) ?? updated;
}

/**
 * Ends an unpaid booking that's waiting for payment. Its payment attempt is
 * settled with Paystack first: if it was paid meanwhile the booking moves on
 * instead, and while Paystack can't be reached nothing changes.
 */
async function endUnpaid(
  doc: ServiceBookingDoc,
  to: "cancelled" | "expired",
  item: ServiceBookingHistoryDoc,
): Promise<ServiceBookingDoc | "paid" | "unknown" | null> {
  const settled = await settleBookingAttempt(doc._id);
  if (settled !== "clear") return settled;
  const { bookings } = await bookingCollections();
  const current = await bookings.findOne({ _id: doc._id });
  if (!current || current.status !== "awaiting_payment" || current.paymentStatus === "paid") return null;
  const updated = await move(current, to, item);
  if (updated) await closeBookingAttempts(doc._id);
  return updated;
}

/** Whether a booking's time to act has run out (the job, or the next read, ends it). */
function lapsed(doc: ServiceBookingDoc, now: Date) {
  if (doc.status === "requested") return !!doc.respondBy && now >= doc.respondBy;
  if (doc.status === "quote_offered") return !!doc.quote && now >= doc.quote.validUntil;
  if (doc.status === "awaiting_payment") return !!doc.payBy && now >= doc.payBy;
  return false;
}

/** Ends one lapsed booking; the doc unchanged when it couldn't be ended yet. */
async function expireOne(doc: ServiceBookingDoc, now: Date): Promise<ServiceBookingDoc> {
  const item = bookingHistoryItem("expired", "system", null, now);
  if (doc.status === "awaiting_payment") {
    const result = await endUnpaid(doc, "expired", item);
    const { bookings } = await bookingCollections();
    return typeof result === "object" && result ? result : ((await bookings.findOne({ _id: doc._id })) ?? doc);
  }
  return (await move(doc, "expired", item)) ?? doc;
}

export async function transitionServiceBooking(
  user: UserDoc,
  id: unknown,
  input: ParsedServiceTransition,
  now = new Date(),
): Promise<{ doc: ServiceBookingDoc; viewer: ServiceBookingViewer }> {
  const found = await findOwnServiceBooking(user, id);
  if (!found) throw new HttpError(404, BOOKING_NOT_FOUND);
  const { doc, viewer } = found;
  const stale = () => new HttpError(409, "This booking has changed. Reload to see its latest status.");
  if (doc.status !== input.expectedStatus) throw stale();
  if (lapsed(doc, now)) {
    await expireOne(doc, now);
    throw new HttpError(409, "The time to respond to this booking has passed, so it has lapsed.");
  }
  if (!serviceBookingActions(doc, viewer, now).includes(input.action))
    throw new HttpError(409, "That change isn't possible for this booking now.");

  const to = TARGET[input.action];
  const item = bookingHistoryItem(to, viewer, user._id, now, input.reason);
  let set: Partial<ServiceBookingDoc> = {};
  switch (input.action) {
    case "accept":
      set = { acceptedAt: now, respondBy: null };
      break;
    case "quote": {
      const q = input.quote!;
      const validUntil = new Date(
        Math.min(now.getTime() + q.validDays * DAY_MS, lagosInstant(doc.schedule.date, 0).getTime()),
      );
      set = { quote: { amountKobo: q.amountNgn * 100, note: q.note, offeredAt: now, validUntil }, respondBy: null };
      item.note = null;
      break;
    }
    case "accept_quote":
      if (!paymentsEnabled()) throw new HttpError(503, PAYMENTS_OFF);
      set = {
        amountKobo: doc.quote!.amountKobo,
        paymentStatus: "pending",
        payBy: new Date(now.getTime() + SERVICE_BOOKING_RULES.payWithinMs),
      };
      break;
    case "complete":
      set = { completedAt: now };
      break;
  }

  let updated: ServiceBookingDoc | null;
  if (doc.status === "awaiting_payment" && input.action === "cancel") {
    const result = await endUnpaid(doc, "cancelled", item);
    if (result === "paid") throw new HttpError(409, "This booking was just paid. Reload to see its latest status.");
    if (result === "unknown")
      throw new HttpError(503, "We couldn't check your payment with our provider. Please try again in a minute.");
    updated = result;
  } else {
    updated = await move(doc, to, item, set);
  }
  if (!updated) throw stale();
  return { doc: updated, viewer };
}

/** Ends lapsed requests, quotes and unpaid bookings (bounded), oldest first. */
export async function expireLapsedBookings(
  scope: { customerUserId?: ObjectId; providerUserId?: ObjectId },
  limit: number,
  now = new Date(),
): Promise<number> {
  const { bookings } = await bookingCollections();
  const due = [
    ...(await bookings
      .find({ ...scope, status: "requested", respondBy: { $lte: now } })
      .sort({ respondBy: 1 })
      .limit(limit)
      .toArray()),
    ...(await bookings
      .find({ ...scope, status: "quote_offered", "quote.validUntil": { $lte: now } })
      .sort({ "quote.validUntil": 1 })
      .limit(limit)
      .toArray()),
  ];
  // unpaid bookings: their open payment attempt is checked with Paystack first
  due.push(
    ...(await bookings
      .find({ ...scope, status: "awaiting_payment", payBy: { $lte: now } })
      .sort({ payBy: 1 })
      .limit(limit)
      .toArray()),
  );
  let expired = 0;
  for (const doc of due) if ((await expireOne(doc, now)).status === "expired") expired++;
  return expired;
}

// --- the job ----------------------------------------------------------------------------

/** payments and refunds nobody has checked for this long are looked up */
const RECHECK_AFTER_MS = 2 * 60_000;
const LEDGER_RETRY_AFTER_MS = 60_000;

export type ServiceBookingJobResult = {
  expired: number;
  paymentsChecked: number;
  refundsChecked: number;
  ledgerSynced: number;
};

/** The scheduled job's share (app/api/internal/orders/process). Each step is safe to repeat. */
export async function runServiceBookingJob(limit = 20, now = new Date()): Promise<ServiceBookingJobResult> {
  const result: ServiceBookingJobResult = { expired: 0, paymentsChecked: 0, refundsChecked: 0, ledgerSynced: 0 };
  if (isPaystackConfigured()) {
    if (paymentsEnabled()) result.paymentsChecked = await reconcileBookingPayments(limit, RECHECK_AFTER_MS);
    result.refundsChecked = await reconcileBookingRefunds(limit, RECHECK_AFTER_MS);
  }
  result.expired = await expireLapsedBookings({}, limit, now);

  // ledger changes that didn't finish, and paid accepted bookings waiting
  // for a commission policy (settled as soon as one is configured)
  const { bookings } = await bookingCollections();
  const stale = await bookings
    .find({ ledgerSyncAt: { $lte: new Date(now.getTime() - LEDGER_RETRY_AFTER_MS) } })
    .sort({ ledgerSyncAt: 1 })
    .limit(limit)
    .toArray();
  const unsettled = await bookings
    .find({
      settlement: null,
      paidAt: { $type: "date" },
      acceptedAt: { $type: "date" },
      status: { $nin: ["declined", "cancelled", "expired"] },
    })
    .sort({ paidAt: 1 })
    .limit(limit)
    .toArray();
  const ids = new Map([...stale, ...unsettled].map((b) => [b._id.toHexString(), b._id]));
  for (const id of ids.values()) {
    await bestEffort("booking ledger sync", () => syncBookingLedger(id));
    result.ledgerSynced++;
  }
  return result;
}

// --- what each party sees ---------------------------------------------------------------

/** Phone numbers are only shared while a job the provider took is still open. */
const SHARES_CONTACT: readonly ServiceBookingStatus[] = ["confirmed", "provider_en_route", "in_progress"];

export async function toServiceBooking(
  doc: ServiceBookingDoc,
  viewer: ServiceBookingViewer,
  now = new Date(),
): Promise<ServiceBooking> {
  const { users } = await bookingCollections();
  const projection = { fullName: 1, phoneNormalized: 1, "profile.photo.url": 1 } as const;
  const [provider, customer] = await Promise.all([
    users.findOne({ _id: doc.providerUserId }, { projection }),
    users.findOne({ _id: doc.customerUserId }, { projection }),
  ]);
  const shares = SHARES_CONTACT.includes(doc.status);
  return {
    id: doc._id.toHexString(),
    reference: doc.reference,
    viewer,
    service: {
      id: doc.serviceId.toHexString(),
      name: doc.service.name,
      category: doc.service.category,
      categoryLabel: marketplaceLabel(doc.service.category),
      pricing: doc.service.pricing,
    },
    provider: {
      id: doc.providerUserId.toHexString(),
      name: provider?.fullName ?? "Former provider",
      photoUrl: provider?.profile?.photo?.url ?? null,
      phone: viewer === "customer" && shares ? (provider?.phoneNormalized ?? null) : null,
    },
    customer: {
      name: customer?.fullName ?? "Former customer",
      phone: viewer === "provider" && shares ? (customer?.phoneNormalized ?? null) : null,
    },
    schedule: doc.schedule,
    location: doc.location,
    contactPreference: doc.contactPreference,
    notes: doc.notes,
    details: describeDetails(doc.service.category, doc.details, stateLabel),
    status: doc.status,
    paymentStatus: doc.paymentStatus,
    amountKobo: doc.amountKobo,
    paidKobo: doc.paidKobo,
    refundedKobo: doc.refundedKobo,
    quote: doc.quote
      ? {
          amountKobo: doc.quote.amountKobo,
          note: doc.quote.note,
          offeredAt: doc.quote.offeredAt.toISOString(),
          validUntil: doc.quote.validUntil.toISOString(),
        }
      : null,
    respondBy: doc.respondBy?.toISOString() ?? null,
    payBy: doc.payBy?.toISOString() ?? null,
    history: doc.history.map((h) => ({ event: h.event, by: h.by, at: h.at.toISOString(), note: h.note })),
    actions: serviceBookingActions(doc, viewer, now),
    canPay: viewer === "customer" && isBookingPayable(doc, now) && paymentsEnabled(),
    cancelUntil: doc.status === "confirmed" ? addDays(doc.schedule.date, -1) : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Reads one booking for its customer or provider, ending it first if its time to act has passed. */
export async function getServiceBooking(user: UserDoc, id: unknown, now = new Date()) {
  const found = await findOwnServiceBooking(user, id);
  if (!found) return null;
  let doc = found.doc;
  if (lapsed(doc, now)) doc = await expireOne(doc, now);
  return { doc, viewer: found.viewer, booking: await toServiceBooking(doc, found.viewer, now) };
}

export const SERVICE_BOOKING_PAGE_SIZE = 20;

function listCursor(view: ServiceBookingViewer, doc: Pick<ServiceBookingDoc, "createdAt" | "_id">) {
  return Buffer.from(`${view}.${doc.createdAt.getTime()}.${doc._id.toHexString()}`).toString("base64url");
}

function readListCursor(view: ServiceBookingViewer, cursor: string): { at: Date; id: ObjectId } {
  const bad = new HttpError(400, "This list has changed. Reload to start again.");
  if (cursor.length > 120) throw bad;
  const m = /^(customer|provider)\.(\d{1,15})\.([0-9a-f]{24})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!m || m[1] !== view) throw bad;
  return { at: new Date(Number(m[2])), id: new ObjectId(m[3]) };
}

/**
 * The user's bookings as a customer, or the jobs booked with them as a
 * provider: newest first, keyset paged on (createdAt, _id).
 */
export async function listServiceBookings(
  user: UserDoc,
  view: ServiceBookingViewer,
  cursor: string | null,
  now = new Date(),
): Promise<{ bookings: ServiceBookingSummary[]; nextCursor: string | null }> {
  const { bookings, users } = await bookingCollections();
  const mine = view === "provider" ? { providerUserId: user._id } : { customerUserId: user._id };
  await expireLapsedBookings(mine, 10, now);
  const filter: Filter<ServiceBookingDoc> = { ...mine };
  if (cursor) {
    const after = readListCursor(view, cursor);
    filter.$or = [{ createdAt: { $lt: after.at } }, { createdAt: after.at, _id: { $lt: after.id } }];
  }
  const docs = await bookings
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(SERVICE_BOOKING_PAGE_SIZE + 1)
    .toArray();
  const page = docs.slice(0, SERVICE_BOOKING_PAGE_SIZE);
  const other = (d: ServiceBookingDoc) => (view === "provider" ? d.customerUserId : d.providerUserId);
  const otherIds = [...new Set(page.map((d) => other(d).toHexString()))].map((id) => new ObjectId(id));
  const names = new Map(
    (await users.find({ _id: { $in: otherIds } }, { projection: { fullName: 1 } }).toArray()).map((u) => [
      u._id.toHexString(),
      u.fullName,
    ]),
  );
  return {
    bookings: page.map((d) => ({
      id: d._id.toHexString(),
      reference: d.reference,
      viewer: view,
      serviceName: d.service.name,
      categoryLabel: marketplaceLabel(d.service.category),
      date: d.schedule.date,
      window: d.schedule.window,
      status: d.status,
      paymentStatus: d.paymentStatus,
      amountKobo: d.amountKobo,
      otherParty: names.get(other(d).toHexString()) ?? "Former member",
    })),
    nextCursor: docs.length > SERVICE_BOOKING_PAGE_SIZE ? listCursor(view, page[page.length - 1]) : null,
  };
}
